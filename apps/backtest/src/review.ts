import { botReviews, bots, botVersions, fills, orders } from "@drift/db";
import { dec, feeRateToFraction, SODEX_BASE_FEE_PCT } from "@drift/shared";
import { reviewVolumeFarm, volumeFarmSchema, type ReviewFill } from "@drift/strategies";
import { and, eq, like } from "drizzle-orm";

import { loadCandles, userBuilderRate, type RunDeps } from "./run";

// Job review sau khi chạy của Volume Builder (DEC-131): nạp fill của bot (mọi version), nến 1 phút của cùng giai đoạn,
// gọi `reviewVolumeFarm` (packages/strategies), lưu kết quả vào `bot_reviews`.

/** Nến cần sau lượt cuối: mô phỏng tối đa 15 phút sau khi vào lệnh. */
const TAIL_MS = 20 * 60_000;

function seedOf(id: string): number {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

export async function runReview(deps: RunDeps, reviewId: string): Promise<void> {
  const [rv] = await deps.db.select().from(botReviews).where(eq(botReviews.id, reviewId)).limit(1);
  if (rv === undefined || rv.status === "done" || rv.status === "unavailable") return;
  await deps.db.update(botReviews).set({ status: "running" }).where(eq(botReviews.id, reviewId));
  const finish = (set: Partial<typeof botReviews.$inferInsert>) =>
    deps.db
      .update(botReviews)
      .set({ ...set, finishedAt: deps.now() })
      .where(eq(botReviews.id, reviewId));
  try {
    const [b] = await deps.db.select().from(bots).where(eq(bots.id, rv.botId)).limit(1);
    const [v] = await deps.db
      .select({ config: botVersions.config })
      .from(botVersions)
      .where(eq(botVersions.id, b?.activeVersionId ?? ""))
      .limit(1);
    const parsed = volumeFarmSchema.safeParse(v?.config);
    if (b === undefined || !parsed.success) {
      await finish({ status: "unavailable", error: "config" });
      return;
    }
    const rows = await deps.db
      .select({
        tag: orders.tag,
        side: orders.side,
        price: fills.price,
        size: fills.size,
        fee: fills.fee,
        builderFee: fills.builderFee,
        isMaker: fills.isMaker,
        at: fills.filledAt,
      })
      .from(fills)
      .innerJoin(orders, eq(orders.id, fills.orderId))
      .where(and(eq(orders.botId, b.id), like(orders.tag, "vf:%")));
    const fs: ReviewFill[] = rows.map((r) => ({
      tag: r.tag,
      side: r.side,
      price: Number(r.price),
      size: Number(r.size),
      fee: Number(r.fee),
      builderFee: Number(r.builderFee ?? "0"),
      isMaker: r.isMaker === true,
      at: r.at.getTime(),
    }));
    let first = Infinity;
    let last = -Infinity;
    for (const f of fs) {
      first = Math.min(first, f.at);
      last = Math.max(last, f.at);
    }
    const candles =
      fs.length === 0
        ? []
        : await loadCandles(
            deps,
            "perps",
            b.market,
            "1m",
            Math.floor(first / 60_000) * 60_000,
            last + TAIL_MS,
          );
    const builder = feeRateToFraction(
      await userBuilderRate(deps.db, b.userId, b.strategy),
    ).toNumber();
    const pct = (x: string) => dec(x).div(100).toNumber();
    const result = reviewVolumeFarm({
      config: parsed.data,
      fills: fs,
      candles,
      fallbackFee: {
        maker: pct(SODEX_BASE_FEE_PCT.perps.maker) + builder,
        taker: pct(SODEX_BASE_FEE_PCT.perps.taker) + builder,
      },
      seed: seedOf(reviewId),
    });
    await finish({ status: "done", result, error: null });
  } catch (error) {
    await finish({ status: "failed", error: "internal" });
    throw error;
  }
}
