import { Decimal, dec } from "../money";

// Giới hạn thanh khoản Copy Trading (DEC-163 mục 9): mỗi tín hiệu mở / tăng của một leader × market, tổng notional của
// mọi bot copy ≤ 50% độ sâu sổ SoDEX phía đối diện trong khoảng Max price move. Phân bổ ở MỘT chỗ (marketdata, nơi
// fan-out tín hiệu) vì bot của các account khác nhau chạy trên các shard engine khác nhau. Hàm thuần.

export const COPY_LIQUIDITY_SHARE = "0.5";

export interface CopyDemand {
  botId: string;
  /** Notional (USD) bot muốn dùng cho tín hiệu này (cận trên). */
  desired: string;
  /** Max price move của bot (%). */
  maxSlippagePct: string;
}

export type BookLevel = readonly [price: string, size: string];

/** Độ sâu (USD) phía đối diện trong khoảng `pct`% từ giá tham chiếu. Mua → ăn asks ≤ ref × (1 + pct). */
export function depthWithin(
  levels: readonly BookLevel[],
  side: "buy" | "sell",
  ref: string,
  pct: string,
): Decimal {
  const r = dec(ref);
  const k = dec(pct).div(100);
  const limit = side === "buy" ? r.mul(k.add(1)) : r.mul(new Decimal(1).sub(k));
  let total = new Decimal(0);
  for (const [p, q] of levels) {
    const price = dec(p);
    if (side === "buy" ? price.gt(limit) : price.lt(limit)) continue;
    total = total.add(price.mul(dec(q)));
  }
  return total;
}

/**
 * Hạn mức từng bot. `null` = không cần cắt (tổng nhu cầu ≤ 50% độ sâu): message không kèm hạn mức, bot vừa start
 * cũng không bị ảnh hưởng. Khi phải cắt: chia theo tỷ lệ nhu cầu. Độ sâu đo trong khoảng trượt giá nhỏ nhất của các
 * bot (an toàn: không tính phần sổ mà bot chặt nhất không được ăn).
 */
export function allocateCopy(
  demands: readonly CopyDemand[],
  levels: readonly BookLevel[],
  side: "buy" | "sell",
  ref: string,
): Record<string, string> | null {
  const live = demands.filter((d) => dec(d.desired).gt(0));
  if (live.length === 0) return null;
  const minPct = live.reduce(
    (m, d) => Decimal.min(m, dec(d.maxSlippagePct)),
    dec(live[0]?.maxSlippagePct ?? "0"),
  );
  const cap = depthWithin(levels, side, ref, minPct.toString()).mul(COPY_LIQUIDITY_SHARE);
  const want = live.reduce((s, d) => s.add(dec(d.desired)), new Decimal(0));
  if (want.lte(cap)) return null;
  const ratio = cap.div(want);
  return Object.fromEntries(
    demands.map((d) => [
      d.botId,
      Decimal.max(0, dec(d.desired)).mul(ratio).toDecimalPlaces(2, Decimal.ROUND_DOWN).toString(),
    ]),
  );
}
