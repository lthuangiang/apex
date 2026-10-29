import { z } from "zod";

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
