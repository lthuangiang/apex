import { inArray } from "drizzle-orm";

import type { Db } from "./client";
import { userBuilderFees, userFeeTiers } from "./schema";

/**
 * Mức builder fee riêng theo chiến lược của từng user: mức theo bậc volume (DEC-TBD-mm-fee-tiers), rồi mức team đặt tay
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
