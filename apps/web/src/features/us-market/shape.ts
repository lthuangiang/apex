import { US_MARKET_ANTHROPIC, type UsMarketEngine } from "@drift/shared";

import { formatMoney } from "@/lib/format";

// Hàm thuần của trang US Market (DEC-402, #591): tên market, chiến lược cho market Anthropic, "N days ago", tiền USD.

/** Tên market đúng như SoDEX trả (không logo, không đổi tên): perps giữ nguyên, spot `vANT_vUSDC` → `vANT / vUSDC`. */
export function marketLabel(symbol: string): string {
  return symbol.replace("_", " / ");
}

/** Tên ngắn trên chip: perps giữ nguyên, spot lấy coin base (`vANT_vUSDC` → `vANT`). */
export function shortMarketLabel(symbol: string): string {
  return symbol.split("_")[0] ?? symbol;
}

/**
 * Chiến lược sẵn có cho market Anthropic (bản phác màn 01, 02; DEC-402 mục 1, 8). Không có Funding Arbitrage trên ANT
 * (DEC-402 mục 8: phía mua của vANT quá mỏng). `news_signal` tạo từ Signal Research, không có route `/bots/new`.
 */
export const US_MARKET_STRATEGIES: Readonly<Record<UsMarketEngine, readonly string[]>> = {
  perps: ["futures_grid", "futures_dca", "news_signal"],
  spot: ["spot_dca", "spot_grid"],
};

export interface StrategyChip {
  strategy: string;
  symbol: string;
  engine: UsMarketEngine;
}

/** Chip "Futures Grid · ANT-USD" … theo thứ tự market Anthropic (perps trước). */
export function anthropicStrategyChips(): StrategyChip[] {
  return US_MARKET_ANTHROPIC.flatMap((m) =>
    US_MARKET_STRATEGIES[m.engine].map((strategy) => ({
      strategy,
      symbol: m.symbol,
      engine: m.engine,
    })),
  );
}

/** Market Anthropic chiến lược này giao dịch được (nhãn "Trades …" trên thẻ catalog); null khi không có. */
export function anthropicMarketOf(
  strategy: string,
): { symbol: string; engine: UsMarketEngine } | null {
  return US_MARKET_ANTHROPIC.find((m) => US_MARKET_STRATEGIES[m.engine].includes(strategy)) ?? null;
}

/** `$2,449.00`; `signed` → `+$12.05` / `−$3.05`. null → null (web hiện "Not provided"). */
export function usd(value: string | null, signed = false): string | null {
  const text = formatMoney(value, signed);
  if (text === null) return null;
  const sign = text.startsWith("+") || text.startsWith("−") ? text.slice(0, 1) : "";
  return `${sign}$${text.slice(sign.length)}`;
}

/** Khoảng thời gian từ `iso` tới `nowMs` theo đơn vị lớn nhất: phút, giờ hoặc ngày (không âm). */
export function agoParts(
  iso: string,
  nowMs: number,
): { unit: "now" | "minutes" | "hours" | "days"; n: number } {
  const ms = Math.max(0, nowMs - Date.parse(iso));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return { unit: "now", n: 0 };
  if (minutes < 60) return { unit: "minutes", n: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", n: hours };
  return { unit: "days", n: Math.floor(hours / 24) };
}

/** Giây kể từ lần đọc sổ lệnh ("Order book read N s ago"). */
export function secondsSince(iso: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
}
