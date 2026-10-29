import type { MarketList } from "@drift/shared";

import { formatAmount, stepDecimals } from "../../lib/format";

// Logic thuần của các ô chọn market / tài sản (UI_REVIEW G4, G6); component nằm trong `components/`.

export interface PickItem {
  value: string;
  label: string;
  /** Chữ phụ bên phải dòng (giá gần nhất…); không có thì không hiện. */
  secondary?: string | undefined;
  /** Nhóm khi chưa gõ gì; thứ tự nhóm theo thứ tự xuất hiện trong `items`. */
  group?: string | undefined;
  /** Khoá tìm kiếm thêm ngoài `label` (mã gốc, base asset). */
  keys?: readonly string[];
  /** Không chọn được (ví dụ market đã có trong Watchlist); `secondary` ghi lý do. */
  disabled?: boolean | undefined;
}

/** Chuẩn hoá để tìm: `vBTC_vUSDC`, `BTC/USDC`, `btc-usdc` → `btcusdc`. */
export function searchKey(s: string): string {
  return s
    .split(/[\s/_-]+/)
    .map((p) => p.replace(/^v(?=[A-Z])/, ""))
    .join("")
    .toLowerCase();
}

/** 0 = khớp đầu chuỗi, 1 = khớp giữa chuỗi, null = không khớp. */
export function matchRank(item: PickItem, query: string): 0 | 1 | null {
  const q = searchKey(query);
  if (q === "") return 0;
  const keys = [item.label, item.value, ...(item.keys ?? [])].map(searchKey);
  if (keys.some((k) => k.startsWith(q))) return 0;
  if (keys.some((k) => k.includes(q))) return 1;
  return null;
}

export type Market = MarketList["items"][number];

/** Danh sách cố định (UI_REVIEW G6, DEC-66). */
export const POPULAR_BASES = ["BTC", "ETH", "SOL"] as const;

/** Phần base / quote của tên hiển thị: `BTC/USDC` → BTC, USDC; `BTC-USD` → BTC, USD. */
export function displayParts(m: Pick<Market, "displayName">): { base: string; quote: string } {
  const [base = m.displayName, quote = ""] = m.displayName.split(/[/-]/);
  return { base, quote };
}

export function marketItems(
  markets: readonly Market[],
  engine: "spot" | "perps",
  labels: { popular: string; quote: (q: string) => string },
): PickItem[] {
  const rows = markets
    .filter((m) => m.engine === engine && m.trading)
    .map((m) => ({ m, ...displayParts(m) }))
    .sort((a, b) => a.m.displayName.localeCompare(b.m.displayName));
  const rank = (base: string) => POPULAR_BASES.indexOf(base as (typeof POPULAR_BASES)[number]);
  const popular = rows
    .filter((r) => rank(r.base) >= 0)
    .sort((a, b) => rank(a.base) - rank(b.base) || a.quote.localeCompare(b.quote));
  const rest = rows
    .filter((r) => rank(r.base) < 0)
    .sort(
      (a, b) => a.quote.localeCompare(b.quote) || a.m.displayName.localeCompare(b.m.displayName),
    );
  const item = (r: (typeof rows)[number], group: string): PickItem => ({
    value: r.m.name,
    label: r.m.displayName,
    secondary:
      r.m.last === null ? undefined : formatAmount(r.m.last, stepDecimals(r.m.tickSize))?.text,
    group,
    keys: [r.base],
  });
  return [
    ...popular.map((r) => item(r, labels.popular)),
    ...rest.map((r) => item(r, labels.quote(r.quote))),
  ];
}

export const popularFirst = (a: string, b: string) => {
  const ra = POPULAR_BASES.indexOf(a as (typeof POPULAR_BASES)[number]);
  const rb = POPULAR_BASES.indexOf(b as (typeof POPULAR_BASES)[number]);
  return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || a.localeCompare(b);
};

/** Cặp market Spot + Perps theo tài sản; Spot ưu tiên quote USDC (perps SoDEX ký quỹ USDC). */
export function arbPairs(markets: readonly Market[]): Map<string, { spot: Market; perp: Market }> {
  const spot = new Map<string, Market>();
  for (const m of markets) {
    if (m.engine !== "spot" || !m.trading) continue;
    const { base, quote } = displayParts(m);
    const prev = spot.get(base);
    if (prev === undefined || (quote === "USDC" && displayParts(prev).quote !== "USDC")) {
      spot.set(base, m);
    }
  }
  const out = new Map<string, { spot: Market; perp: Market }>();
  for (const m of markets) {
    if (m.engine !== "perps" || !m.trading) continue;
    const base = displayParts(m).base;
    const s = spot.get(base);
    if (s !== undefined && !out.has(base)) out.set(base, { spot: s, perp: m });
  }
  return out;
}
