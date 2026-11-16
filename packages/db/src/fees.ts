import { FEE_TIERS } from "@drift/shared";
import { and, eq, gte, inArray, sql } from "drizzle-orm";

import type { Db } from "./client";
import { bots, fills, orders, userBuilderFees, userFeeTiers } from "./schema";

/**
 * Bot tiền thật (`mode = live`) của các chiến lược có bậc builder fee (DEC-258), mọi trạng thái. `userId` / `strategy` =
 * chỉ của một user / một chiến lược (thẻ phí ở GET /features); bỏ trống = tất cả (job theo giờ).
 */
export async function feeTierBotIds(
  db: Db,
  filter: { userId?: string; strategy?: string } = {},
): Promise<string[]> {
  const { userId, strategy } = filter;
  const strategies = Object.keys(FEE_TIERS).filter((s) => strategy === undefined || s === strategy);
  if (strategies.length === 0) return [];
  const rows = await db
    .select({ id: bots.id })
    .from(bots)
    .where(
      and(
        inArray(bots.strategy, strategies),
        eq(bots.mode, "live"),
        userId === undefined ? undefined : eq(bots.userId, userId),
      ),
    );
  return rows.map((b) => b.id);
}

/**
 * Volume tính bậc (DEC-258): Σ giá × khối lượng của mọi fill (mua và bán) từ `since` của các bot `botIds`, gộp theo
 * user × chiến lược, dạng chuỗi thập phân (USD). Bắt đầu từ bot (orders_bot_idx rồi fills_order_idx), không quét cả bảng
 * fills theo giờ khớp. Cặp không có fill nào trong cửa sổ thì không có dòng. Job theo giờ và API dùng chung.
 */
export async function feeTierVolumes(
  db: Db,
  botIds: readonly string[],
  since: Date,
): Promise<{ userId: string; strategy: string; volume: string }[]> {
  if (botIds.length === 0) return [];
  return db
    .select({
      userId: bots.userId,
      strategy: bots.strategy,
      volume: sql<string>`coalesce(sum(${fills.price} * ${fills.size}), 0)::text`,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .innerJoin(bots, eq(bots.id, orders.botId))
    .where(and(inArray(orders.botId, [...botIds]), gte(fills.filledAt, since)))
    .groupBy(bots.userId, bots.strategy);
}

/**
 * Mức builder fee riêng theo chiến lược của từng user: mức theo bậc volume (DEC-258), rồi mức team đặt tay
 * (DEC-159) ghi đè. Thiếu key = mặc định của chiến lược. Engine, API và backtest đọc cùng một nguồn này.
 */
export async function builderFeeOverridesOf(
  db: Db,
  userIds: readonly string[],
): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return out;
  const [tiers, team] = await Promise.all([
    db
      .select({
        userId: userFeeTiers.userId,
        strategy: userFeeTiers.strategy,
        rate: userFeeTiers.rate,
      })
      .from(userFeeTiers)
      .where(inArray(userFeeTiers.userId, ids)),
    db
      .select({
        userId: userBuilderFees.userId,
        strategy: userBuilderFees.strategy,
        rate: userBuilderFees.rate,
      })
      .from(userBuilderFees)
      .where(inArray(userBuilderFees.userId, ids)),
  ]);
  for (const r of [...tiers, ...team])
    out.set(r.userId, { ...out.get(r.userId), [r.strategy]: r.rate });
  return out;
}
