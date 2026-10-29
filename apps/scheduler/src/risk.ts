import {
  bots,
  equitySnapshots,
  outbox,
  riskAlerts,
  riskLimits,
  sodexAccounts,
  users,
  type Db,
} from "@drift/db";
import { applyReason, BotState, evaluateRisk, ReasonCode, valuePortfolio } from "@drift/shared";
import type { SodexRestClient } from "@drift/sodex";
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { getAddress } from "viem";

// Risk engine (DEC-41): mỗi phút ghi equity của từng account đang kết nối, rồi so với giới hạn. Vượt daily loss
// hoặc max drawdown → mọi bot đang chạy của account chuyển `pausing` với reason code (engine xác nhận), ghi alert
// và thông báo. Coin không có giá không được đoán giá: bị loại khỏi equity.

export interface RiskDeps {
  db: Db;
  rest: Pick<SodexRestClient, "getSpotBalances" | "getPerpsAccountState">;
  /** Giá gần nhất theo market (Redis `md:last:<market>`). */
  prices: (markets: readonly string[]) => Promise<Record<string, string>>;
  now: () => number;
}

const ACTIVE: readonly BotState[] = [BotState.running, BotState.starting, BotState.resuming];

export async function snapshotAndCheck(
  deps: RiskDeps,
): Promise<{ accounts: number; paused: number }> {
  const accounts = await deps.db
    .select({ a: sodexAccounts, tz: users.timezone, userId: users.id })
    .from(sodexAccounts)
    .innerJoin(users, eq(users.id, sodexAccounts.userId))
    .where(eq(sodexAccounts.status, "connected"));
  let paused = 0;
  const now = deps.now();
  for (const { a, tz, userId } of accounts) {
    const address = getAddress(a.address);
    const [spot, perps] = await Promise.all([
      deps.rest.getSpotBalances(address, a.sodexAccountId),
      deps.rest.getPerpsAccountState(address),
    ]);
    const markets = [
      ...spot.map((b) => `${b.coin.startsWith("v") ? b.coin : `v${b.coin}`}_vUSDC`),
      ...perps.P.map((p) => p.s),
    ];
    const value = valuePortfolio(spot, perps, await deps.prices(markets));
    // Coin chưa có giá bị loại khỏi equity ở mọi lần ghi (nhất quán), nên % lỗ / drawdown tính trên phần định
    // giá được; Portfolio và Risk Center ghi rõ coin nào bị loại (DEC-41).
    await deps.db
      .insert(equitySnapshots)
      .values({ sodexAccountId: a.id, at: new Date(now), equity: value.equity })
      .onConflictDoNothing();

    const [limits] = await deps.db
      .select()
      .from(riskLimits)
      .where(eq(riskLimits.sodexAccountId, a.id))
      .limit(1);
    if (limits === undefined) continue;
    const points = await deps.db
      .select({ at: equitySnapshots.at, equity: equitySnapshots.equity })
      .from(equitySnapshots)
      .where(
        and(
          eq(equitySnapshots.sodexAccountId, a.id),
          gte(equitySnapshots.at, new Date(now - 31 * 86_400_000)),
        ),
      );
    const status = evaluateRisk(
      { dailyLossPct: limits.dailyLossPct, maxDrawdownPct: limits.maxDrawdownPct },
      points.map((p) => ({ at: p.at.getTime(), equity: p.equity })),
      now,
      tz,
    );
    for (const breach of status.breaches) {
      const reason = breach === "daily_loss" ? ReasonCode.riskDailyLoss : ReasonCode.riskDrawdown;
      const n = await deps.db.transaction(async (tx) => {
        const list = await tx
          .select()
          .from(bots)
          .where(and(eq(bots.sodexAccountId, a.id), inArray(bots.state, [...ACTIVE])))
          .for("update");
        for (const b of list) {
          const next = applyReason(b.state, reason);
          if (next === null) continue;
          await tx.update(bots).set({ state: next, reasonCode: reason }).where(eq(bots.id, b.id));
          await tx.insert(outbox).values({
            topic: `user.${a.id}.bot`,
            payload: { botId: b.id, state: next, reasonCode: reason },
          });
        }
        // Một alert mở cho mỗi loại vi phạm; đã có thì không tạo thêm.
        const [open] = await tx
          .select({ id: riskAlerts.id })
          .from(riskAlerts)
          .where(
            and(
              eq(riskAlerts.sodexAccountId, a.id),
              eq(riskAlerts.kind, breach),
              isNull(riskAlerts.resolvedAt),
            ),
          )
          .limit(1);
        if (open === undefined) {
          const data =
            breach === "daily_loss"
              ? { lossPct: status.dailyLossPct, limitPct: limits.dailyLossPct }
              : {
                  drawdownPct: status.drawdownPct,
                  limitPct: limits.maxDrawdownPct,
                  peak: status.peakEquity,
                };
          await tx.insert(riskAlerts).values({
            sodexAccountId: a.id,
            kind: breach,
            severity: "critical",
            data,
            occurredAt: new Date(now),
          });
          await tx.insert(outbox).values({
            topic: "jobs.notify",
            payload: { userId, type: "risk_alert", data: { kind: breach, ...data } },
          });
        }
        return list.length;
      });
      paused += n;
    }
    // Hết vi phạm thì đóng alert đang mở (daily loss tự hết khi sang ngày mới).
    const resolved = (["daily_loss", "max_drawdown"] as const).filter(
      (k) => !status.breaches.includes(k),
    );
    if (resolved.length > 0) {
      await deps.db
        .update(riskAlerts)
        .set({ resolvedAt: new Date(now) })
        .where(
          and(
            eq(riskAlerts.sodexAccountId, a.id),
            inArray(riskAlerts.kind, resolved),
            isNull(riskAlerts.resolvedAt),
          ),
        );
    }
  }
  return { accounts: accounts.length, paused };
}
