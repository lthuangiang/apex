import { dec, Decimal } from "@drift/shared";
import { z } from "zod";

import { gridPrices } from "./grid";

// Field Perps dùng chung. Trần đòn bẩy = min(cap của account, maxLeverage của market), kiểm tra lúc
// tạo bot bằng dữ liệu ngoài (STRATEGIES.md "Quy ước chung").

export const leverageSchema = z.number().int().min(1, { message: "Allowed 1×–3×." });
export const marginModeSchema = z.enum(["cross", "isolated"]);

export function leverageCapIssue(
  leverage: number,
  accountCap: number,
  marketMax: number,
): string | null {
  if (leverage > accountCap) return `Above your ${accountCap.toFixed(1)}× account cap.`;
  if (leverage > marketMax)
    return `Above the SoDEX maximum of ${String(marketMax)}× for this market.`;
  return null;
}

/** % stop tối đa (tính từ giá vốn) trước giá thanh lý isolated, hệ số an toàn 90%: 90 / đòn bẩy (DEC-237). */
export function perpsStopMaxPct(leverage: number): Decimal {
  return new Decimal(90).div(leverage).toDecimalPlaces(2, Decimal.ROUND_DOWN);
}

/** Giới hạn stop của Futures Grid isolated: lỗ khi chạm stop với vị thế đầy (giả định thận trọng) ≤ 90% margin. */
export function gridStopLimits(
  config: Record<string, unknown>,
  leverage: number,
): { below: Decimal | null; above: Decimal | null } {
  const tiny = { tickSize: "0.00000001", stepSize: "0", minQuantity: "0", minNotional: "0" };
  const spacing = config.spacing === "geometric" ? "geometric" : "arithmetic";
  const levels = gridPrices(
    String(config.lowerPrice),
    String(config.upperPrice),
    Number(config.gridLevels),
    spacing,
    tiny,
  ).map((p) => dec(p));
  const margin = dec(String(config.margin));
  if (levels.length < 2 || !margin.gt(0)) return { below: null, above: null };
  const mean = (xs: readonly Decimal[]) =>
    xs.reduce((a, x) => a.add(x), new Decimal(0)).div(xs.length);
  // Mỗi mức cùng một khối lượng (lõi grid: danh nghĩa / số mức / giá trung bình của các mức).
  const qty = margin.mul(leverage).div(levels.length).div(mean(levels));
  const room = margin.mul("0.9");
  const longSide = levels.slice(0, -1);
  const shortSide = levels.slice(1);
  const below =
    config.direction === "short" ? null : mean(longSide).sub(room.div(qty.mul(longSide.length)));
  const above =
    config.direction === "long" ? null : mean(shortSide).add(room.div(qty.mul(shortSide.length)));
  return { below, above };
}
