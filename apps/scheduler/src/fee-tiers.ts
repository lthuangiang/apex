import { botEvents, bots, fills, orders, userBuilderFees, userFeeTiers, type Db } from "@drift/db";
import {
  builderFeeRateOf,
  Decimal,
  ENGINE_ACTIVE_STATES,
  FEE_TIER_WINDOW_DAYS,
  FEE_TIERS,
  feeRateToPercent,
  tierRateOf,
} from "@drift/shared";
import { and, eq, gte, inArray, sql } from "drizzle-orm";

// Builder fee theo bậc volume (DEC-258): tính lại volume tiền thật 30 ngày của từng user cho mỗi chiến
// lược có bậc, ghi `user_fee_tiers` (chỉ khi khác mặc định). Engine đọc lại mức mỗi vòng nên lệnh mới dùng ngay; không
// phải ký lại vì mọi bậc đều dưới mức user đã approve. Mức team đặt tay (`user_builder_fees`) luôn thắng.

/** Tính lại không dày hơn ngần này. */
export const FEE_TIER_REFRESH_MS = 60 * 60_000;

const pct = (rate: number) => `${feeRateToPercent(rate).toString()}%`;
const usd = (v: Decimal) => v.toDecimalPlaces(0).toNumber().toLocaleString("en-US");

export async function refreshFeeTiers(
  db: Db,
  now: number,
): Promise<{ users: number; changed: number }> {
  const strategies = Object.keys(FEE_TIERS);
  if (strategies.length === 0) return { users: 0, changed: 0 };
  const since = new Date(now - FEE_TIER_WINDOW_DAYS * 86_400_000);
  const volumes = await db
    .select({
      userId: bots.userId,
      strategy: bots.strategy,
      volume: sql<string>`coalesce(sum(${fills.price} * ${fills.size}), 0)::text`,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .innerJoin(bots, eq(bots.id, orders.botId))
    .where(
      and(inArray(bots.strategy, strategies), eq(bots.mode, "live"), gte(fills.filledAt, since)),
    )
    .groupBy(bots.userId, bots.strategy);
  const current = await db
    .select()
    .from(userFeeTiers)
    .where(inArray(userFeeTiers.strategy, strategies));
  const key = (u: string, s: string) => `${u}|${s}`;
  const volOf = new Map(volumes.map((v) => [key(v.userId, v.strategy), new Decimal(v.volume)]));
  const oldOf = new Map(current.map((t) => [key(t.userId, t.strategy), t.rate]));
  const pairs = new Map<string, { userId: string; strategy: string }>();
  for (const x of [...volumes, ...current]) pairs.set(key(x.userId, x.strategy), x);

  let changed = 0;
  for (const [k, { userId, strategy }] of pairs) {
    const volume = volOf.get(k) ?? new Decimal(0);
    const rate = tierRateOf(strategy, volume);
    const before = oldOf.get(k) ?? builderFeeRateOf(strategy);
    await db.transaction(async (tx) => {
      if (rate === builderFeeRateOf(strategy))
        await tx
          .delete(userFeeTiers)
          .where(and(eq(userFeeTiers.userId, userId), eq(userFeeTiers.strategy, strategy)));
      else
        await tx
          .insert(userFeeTiers)
          .values({ userId, strategy, rate, volume: volume.toString(), computedAt: new Date(now) })
          .onConflictDoUpdate({
            target: [userFeeTiers.userId, userFeeTiers.strategy],
            set: { rate, volume: volume.toString(), computedAt: new Date(now) },
          });
      if (rate === before) return;
      // Team đã đặt tay cho chiến lược này: mức hiệu lực không đổi, không báo.
      const [team] = await tx
        .select({ rate: userBuilderFees.rate })
        .from(userBuilderFees)
        .where(and(eq(userBuilderFees.userId, userId), eq(userBuilderFees.strategy, strategy)))
        .limit(1);
      if (team !== undefined) return;
      changed += 1;
      const running = await tx
        .select({ id: bots.id })
        .from(bots)
        .where(
          and(
            eq(bots.userId, userId),
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
            why: `Your volume with this strategy over the last ${String(FEE_TIER_WINDOW_DAYS)} days is ${usd(volume)} USDC, so your builder fee is now ${pct(rate)} (was ${pct(before)}). New orders use it.`,
            occurredAt: new Date(now),
          })),
        );
    });
  }
  return { users: pairs.size, changed };
}
