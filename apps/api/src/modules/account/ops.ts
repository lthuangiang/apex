import { botEvents, botRuntime, bots, fills, orders, outbox, type Db } from "@drift/db";
import { dec, Strategy, type TeamOpsView } from "@drift/shared";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";

import { botCostPerMillion } from "../bots/service";

import { requireTeam } from "./team";

// Trang Ops của team (PR C, DEC-TBD-ops-page; DevOps chọn theo ủy quyền, chờ người dùng xác nhận). Chỉ role team.
// Một hàng mỗi bot Market Making / Volume Farm thật: running / paused / stopping, hoặc dừng trong 24 giờ. Chỉ đọc,
// truy vấn lọc theo các bot đó (không quét cả bảng). Số không tính được → null ("Not available"), không bao giờ 0.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Dòng "Order requests" cũ hơn mức này thì không dùng cho Requests / min. */
const REQUESTS_FRESH_MS = 5 * 60_000;
/**
 * Fill trong 60 phút đi qua `orders_bot_idx`: lệnh tạo trước mức này coi như không còn khớp trong giờ qua. Biên an
 * toàn rộng (lệnh Market Making nằm trên sổ vài phút; lệnh Volume Farm giữ tối đa 1 giờ).
 */
const ORDER_AGE_BOUND_MS = 25 * HOUR;

/** "Last 61 s: 40 requests to SoDEX (…). Longest gap between quotes: 3.0 s." → số đọc được. */
export function parseOrderRequests(why: string | null): {
  perMinute: string | null;
  gapSec: string | null;
} {
  if (why === null) return { perMinute: null, gapSec: null };
  const m = /^Last (\d+) s: (\d+) requests/.exec(why);
  const g = /Longest gap between quotes: (\d+(?:\.\d+)?) s\./.exec(why);
  const secs = m?.[1] === undefined ? 0 : Number(m[1]);
  return {
    perMinute:
      m?.[2] === undefined || secs <= 0
        ? null
        : dec(m[2]).mul(60).div(secs).toDecimalPlaces(1).toString(),
    gapSec: g?.[1] ?? null,
  };
}

/** "Cancelled 3 untracked orders" → 3. */
export function untrackedCount(decision: string | null): number {
  const m = /^Cancelled (\d+) untracked order/.exec(decision ?? "");
  return m?.[1] === undefined ? 0 : Number(m[1]);
}

export async function teamOps(
  deps: { db: Db; now: () => Date; log?: { info: (o: object, m: string) => void } },
  userId: string,
): Promise<TeamOpsView> {
  await requireTeam(deps.db, userId, "Ops is for the DeskLabs team only.");
  const started = Date.now();
  const now = deps.now().getTime();
  const rows = await deps.db
    .select({ b: bots, state: botRuntime.state })
    .from(bots)
    .leftJoin(botRuntime, eq(botRuntime.botId, bots.id))
    .where(
      and(
        eq(bots.mode, "live"),
        inArray(bots.strategy, [Strategy.volumeMaker, Strategy.volumeFarm]),
        or(
          inArray(bots.state, ["running", "paused", "stopping"]),
          and(
            inArray(bots.state, ["stopped", "archived"]),
            gte(bots.updatedAt, new Date(now - DAY)),
          ),
        ),
      ),
    );
  if (rows.length === 0) return { checkedAt: new Date(now).toISOString(), bots: [] };
  const ids = rows.map((r) => r.b.id);

  const notional = sql`${fills.price} * ${fills.size}`;
  const volumes = await deps.db
    .select({
      botId: orders.botId,
      total: sql<string>`sum(${notional})::text`,
      maker: sql<string>`coalesce(sum(case when ${fills.isMaker} then ${notional} else 0 end), 0)::text`,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(
      and(
        inArray(orders.botId, ids),
        gte(orders.createdAt, new Date(now - ORDER_AGE_BOUND_MS)),
        gte(fills.filledAt, new Date(now - HOUR)),
      ),
    )
    .groupBy(orders.botId);

  const events = await deps.db
    .select({
      botId: botEvents.botId,
      decision: botEvents.decision,
      why: botEvents.why,
      at: botEvents.occurredAt,
    })
    .from(botEvents)
    .where(
      and(
        inArray(botEvents.botId, ids),
        gte(botEvents.occurredAt, new Date(now - DAY)),
        or(
          eq(botEvents.decision, "Position cut"),
          eq(botEvents.decision, "Order requests"),
          sql`${botEvents.decision} like 'Cancelled % untracked order%'`,
        ),
      ),
    )
    .orderBy(desc(botEvents.occurredAt));

  const violations = await deps.db
    .select({ payload: outbox.payload, at: outbox.createdAt })
    .from(outbox)
    .where(
      and(
        eq(outbox.topic, "jobs.team_ops"),
        sql`${outbox.payload}->>'type' = 'team_invariant'`,
        sql`${outbox.payload}->>'status' = 'failing'`,
        inArray(sql<string>`${outbox.payload}->>'botId'`, ids),
      ),
    )
    .orderBy(desc(outbox.createdAt))
    .limit(500);

  const out = rows.map(({ b, state }) => {
    const v = volumes.find((x) => x.botId === b.id);
    const total = v === undefined ? null : dec(v.total);
    const mine = events.filter((e) => e.botId === b.id);
    const requests = mine.filter((e) => e.decision === "Order requests");
    const latest = requests[0];
    const lastHour = requests.filter((e) => now - e.at.getTime() <= HOUR);
    const gaps = lastHour
      .map((e) => parseOrderRequests(e.why).gapSec)
      .filter((g): g is string => g !== null);
    const inv = violations.find((x) => (x.payload as { botId?: string }).botId === b.id);
    const p = inv?.payload as { invariant?: string; detail?: string } | undefined;
    return {
      botId: b.id,
      name: b.name,
      strategy: b.strategy,
      market: b.market,
      state: b.state,
      costPerMillion: botCostPerMillion(b.strategy, state),
      volumeHour: total === null || total.isZero() ? null : total.toDecimalPlaces(2).toString(),
      requestsPerMinute:
        latest === undefined || now - latest.at.getTime() > REQUESTS_FRESH_MS
          ? null
          : parseOrderRequests(latest.why).perMinute,
      makerSharePct:
        total === null || total.isZero() || v === undefined
          ? null
          : dec(v.maker).div(total).mul(100).toDecimalPlaces(1).toString(),
      untrackedCancels: mine.reduce((n, e) => n + untrackedCount(e.decision), 0),
      positionCuts: mine.filter((e) => e.decision === "Position cut").length,
      maxQuoteGapSec:
        gaps.length === 0 ? null : gaps.reduce((a, g) => (dec(g).gt(a) ? g : a), gaps[0] ?? "0"),
      latestInvariant:
        inv === undefined || p?.invariant === undefined
          ? null
          : { invariant: p.invariant, at: inv.at.toISOString(), detail: p.detail ?? "" },
    };
  });
  deps.log?.info({ bots: out.length, ms: Date.now() - started }, "team ops computed");
  return { checkedAt: new Date(now).toISOString(), bots: out };
}
