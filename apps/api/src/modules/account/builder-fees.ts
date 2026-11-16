import {
  botEvents,
  bots,
  builderFeeOverridesOf,
  feeTierBotIds,
  feeTierVolumes,
  userBuilderFees,
  userFeeTiers,
  users,
  type Db,
} from "@drift/db";
import {
  AppError,
  BOT_STRATEGIES,
  builderFeeRateFor,
  builderFeeRateOf,
  ENGINE_ACTIVE_STATES,
  Decimal,
  ErrorCode,
  FEE_TIER_WINDOW_DAYS,
  feeRateToPercent,
  nextFeeTierOf,
  Strategy,
  type AdminBuilderFee,
  type BuilderFeeOverrides,
  type BuilderFeeRow,
  type MmFee,
} from "@drift/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { AuditAction, audit } from "../../lib/audit";

import { requireTeam } from "./team";

// Builder fee riêng theo user × chiến lược (DEC-159). Team đặt 0–0.01% ở Users; lệnh mới của user dùng ngay mức này
// (engine đọc lại mỗi vòng). Không có dòng = mặc định `builderFeeRateOf`.

/** Mức team đã đặt tay cho user (chỉ `user_builder_fees`). */
async function teamOverrides(db: Db, userId: string): Promise<BuilderFeeOverrides> {
  const rows = await db
    .select({ strategy: userBuilderFees.strategy, rate: userBuilderFees.rate })
    .from(userBuilderFees)
    .where(eq(userBuilderFees.userId, userId));
  return Object.fromEntries(rows.map((r) => [r.strategy, r.rate]));
}

/** Mức riêng hiệu lực của user: theo bậc volume, team đặt tay ghi đè (DEC-258). */
export async function builderFeeOverrides(db: Db, userId: string): Promise<BuilderFeeOverrides> {
  return (await builderFeeOverridesOf(db, [userId])).get(userId) ?? {};
}

/** Builder fee hiệu lực của user cho mọi chiến lược (GET /features). */
export async function builderFeesOf(db: Db, userId: string): Promise<Record<string, number>> {
  const own = await builderFeeOverrides(db, userId);
  return Object.fromEntries(BOT_STRATEGIES.map((s) => [s, builderFeeRateFor(s, own)]));
}

/**
 * Thẻ builder fee Market Making của user (GET /features, DEC-TBD-mm-fee-card). Volume tính trực tiếp cho riêng user này
 * bằng cùng hàm với job theo giờ (`feeTierVolumes`): đi từ bot MM tiền thật của user qua orders_bot_idx rồi
 * fills_order_idx, nên chi phí tỷ lệ với số fill MM 30 ngày của một user, không quét bảng fills. Mức hiệu lực vẫn là mức
 * engine đang dùng (bảng `user_fee_tiers` do job ghi), có thể chậm tới một giờ so với volume ở đây.
 */
export async function mmFeeOf(db: Db, userId: string, now: Date): Promise<MmFee> {
  const strategy = Strategy.volumeMaker;
  const [team, tier, botIds] = await Promise.all([
    db
      .select({ rate: userBuilderFees.rate })
      .from(userBuilderFees)
      .where(and(eq(userBuilderFees.userId, userId), eq(userBuilderFees.strategy, strategy)))
      .limit(1),
    db
      .select({ rate: userFeeTiers.rate })
      .from(userFeeTiers)
      .where(and(eq(userFeeTiers.userId, userId), eq(userFeeTiers.strategy, strategy)))
      .limit(1),
    feeTierBotIds(db, { userId, strategy }),
  ]);
  const custom = team[0]?.rate;
  const tiered = tier[0]?.rate;
  const source = custom !== undefined ? "custom" : tiered !== undefined ? "tier" : "default";
  const rate = builderFeeRateFor(
    strategy,
    custom !== undefined
      ? { [strategy]: custom }
      : tiered !== undefined
        ? { [strategy]: tiered }
        : undefined,
  );
  // Chưa từng có bot MM tiền thật → null (UI tự xử lý, không hiện $0). Có bot mà không khớp gì → "0" là dữ liệu thật.
  const since = new Date(now.getTime() - FEE_TIER_WINDOW_DAYS * 86_400_000);
  const sum =
    botIds.length === 0
      ? null
      : ((await feeTierVolumes(db, botIds, since)).find((v) => v.strategy === strategy)?.volume ??
        "0");
  const volume30d = sum === null ? null : new Decimal(sum).toFixed();
  const next = source === "custom" ? null : nextFeeTierOf(strategy, volume30d ?? "0");
  const better = next !== null && next.rate < rate ? next : null;
  return {
    rate,
    source,
    volume30d,
    nextVolume: better === null ? null : String(better.minVolume),
    nextRate: better?.rate ?? null,
  };
}

/** Bảng builder fee của user cho trang Users của team. */
export async function builderFeeRows(db: Db, userId: string): Promise<BuilderFeeRow[]> {
  const [own, team] = await Promise.all([
    builderFeeOverrides(db, userId),
    teamOverrides(db, userId),
  ]);
  return BOT_STRATEGIES.map((strategy) => ({
    strategy,
    defaultRate: builderFeeRateOf(strategy),
    rate: builderFeeRateFor(strategy, own),
    custom: team[strategy] !== undefined,
  }));
}

const pct = (rate: number) => `${feeRateToPercent(rate).toString()}%`;

/**
 * Team đặt (hoặc bỏ, `rate = null`) builder fee riêng cho một chiến lược của user. Bot đang chạy của chiến lược đó
 * nhận một dòng Decisions để user biết mức mới; lệnh đã gửi giữ mức cũ.
 */
export async function setBuilderFee(
  deps: { db: Db; now: () => Date },
  actorId: string,
  targetId: string,
  strategy: (typeof BOT_STRATEGIES)[number],
  rate: number | null,
  ip: string | null,
): Promise<AdminBuilderFee> {
  await requireTeam(deps.db, actorId, "Users is for the DeskLabs team only.");
  const now = deps.now();
  const notified = await deps.db.transaction(async (tx) => {
    const [u] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, targetId), isNull(users.deletedAt)))
      .limit(1);
    if (u === undefined) throw new AppError(ErrorCode.notFound, "User not found.");
    const before = builderFeeRateFor(strategy, await builderFeeOverrides(tx, targetId));
    if (rate === null)
      await tx
        .delete(userBuilderFees)
        .where(and(eq(userBuilderFees.userId, targetId), eq(userBuilderFees.strategy, strategy)));
    else
      await tx
        .insert(userBuilderFees)
        .values({ userId: targetId, strategy, rate, updatedBy: actorId })
        .onConflictDoUpdate({
          target: [userBuilderFees.userId, userBuilderFees.strategy],
          set: { rate, updatedBy: actorId, updatedAt: now },
        });
    // Xoá mức đặt tay thì quay về mức theo bậc (nếu có), không phải mặc định.
    const after = builderFeeRateFor(strategy, await builderFeeOverrides(tx, targetId));
    let count = 0;
    if (after !== before) {
      const running = await tx
        .select({ id: bots.id })
        .from(bots)
        .where(
          and(
            eq(bots.userId, targetId),
            eq(bots.strategy, strategy),
            inArray(bots.state, [...ENGINE_ACTIVE_STATES]),
          ),
        );
      if (running.length > 0)
        await tx.insert(botEvents).values(
          running.map((b) => ({
            botId: b.id,
            type: "decision",
            decision: "Builder fee changed",
            why: `The team set your builder fee for this strategy to ${pct(after)} (was ${pct(before)}). New orders use it.`,
            occurredAt: now,
          })),
        );
      count = running.length;
    }
    await audit(tx, {
      userId: actorId,
      action: AuditAction.builderFeeChanged,
      target: targetId,
      metadata: { strategy, before, after, custom: rate !== null, notified: count },
      ip,
    });
    return count;
  });
  return { builderFees: await builderFeeRows(deps.db, targetId), notified };
}
