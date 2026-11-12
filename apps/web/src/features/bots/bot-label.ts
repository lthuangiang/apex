import type { BotSummary } from "@drift/shared";

import { formatAmount, formatMoney } from "@/lib/format";
import type { MarketNames } from "@/lib/markets";

import { unitsOf } from "./preview";

// Nhãn market và vốn của một bot trong danh sách (UI_REVIEW N2): Rebalancing hiện cả rổ tài sản thay cho market
// của tài sản đầu; TWAP hiện tổng khối lượng theo base thay cho "Not available".

type Bot = Pick<BotSummary, "market" | "marketLabel" | "capital" | "capitalUnit">;

export function botMarket(b: Bot, names: MarketNames): string {
  return b.marketLabel ?? names.market(b.market);
}

/** "1,000.00 USDC" hoặc "0.5 ETH" (TWAP); null khi backend không trả vốn. */
export function botCapital(b: Bot, names: MarketNames): string | null {
  if (b.capital === null) return null;
  const units = unitsOf(b.market);
  if (b.capitalUnit === "base") {
    const qty = formatAmount(b.capital, names.qtyDigits(b.market))?.text ?? b.capital;
    return `${qty} ${names.asset(units?.base ?? "")}`.trim();
  }
  return `${formatMoney(b.capital) ?? b.capital} ${names.asset(units?.quote ?? "")}`.trim();
}
