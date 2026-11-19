import { feeRateToPercent, SODEX_BASE_FEE_PCT } from "../fees";
import { dec, Decimal, type DecimalInput } from "../money";

import {
  AssetKind,
  PaperExitReason,
  NEWS_RULES,
  SignalLevel,
  SignalReason,
  SOSO_OFFICIAL_CATEGORY,
  SOURCE_TIERS,
  SourceTier,
  STOCK_BRAND_ALIASES,
  STOCK_MARKET_SET,
  STOCK_SYMBOL_ALIASES,
  TradeDirection,
  type SignalCatalyst,
} from "./rules";

// Hàm thuần của lane tin tức (#271): không I/O, không đọc đồng hồ (giờ truyền vào). Tiền / giá bằng Decimal; phần trăm
// lưu dạng số phần trăm ("0.10" = 0,10%).

const HOUR_MS = 3_600_000;
const HUNDRED = new Decimal(100);

// ── Normalize ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MatchedCurrency {
  symbol: string;
  name: string | null;
}

export interface Candidate {
  /** Mã SoSoValue (viết hoa). */
  symbol: string;
  /** Market perps trên SoDEX, ví dụ "SOL-USD". */
  market: string;
  kind: AssetKind;
}

/** SoSoValue ghi tên cổ phiếu dạng JSON `{"EN": "NVIDIA CORPORATION"}`; coin là chuỗi thường ("Bitcoin"). */
function isStockName(name: string | null): boolean {
  return name !== null && /^\s*\{.*"EN"\s*:/i.test(name);
}

/**
 * Token ứng viên của một bài: các currency SoSoValue gắn với bài, chỉ giữ market có trên SoDEX (`markets`: perps đang
 * giao dịch). Coin → `<SYM>-USD` hoặc `1000<SYM>-USD`, không bao giờ trùng một market cổ phiếu (coin "COIN" không phải
 * Coinbase). Tag công ty (tên JSON) hoặc xStock (mã có thêm "X") → `STOCK_SYMBOL_ALIASES` nếu có (GOOG, SPACEX), không thì
 * `<SYMBOL>-USD`; chỉ nhận khi market có trên SoDEX **và** nằm trong `STOCK_MARKET_SET` (news-v4, #309), để tag công ty
 * không bao giờ rơi vào market coin trùng mã.
 */
export function candidatesOf(
  matched: readonly MatchedCurrency[],
  markets: ReadonlySet<string>,
): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const m of matched) {
    const symbol = m.symbol.trim().toUpperCase();
    if (symbol === "") continue;
    const xstock = (m.name ?? "").toUpperCase().trim().endsWith("XSTOCK") && symbol.endsWith("X");
    if (isStockName(m.name) || xstock) {
      const ticker = xstock ? symbol.slice(0, -1) : symbol;
      const market = STOCK_SYMBOL_ALIASES[ticker] ?? `${ticker}-USD`;
      if (markets.has(market) && STOCK_MARKET_SET.has(market) && !out.has(market))
        out.set(market, { symbol, market, kind: AssetKind.stock });
      continue;
    }
    for (const market of [`${symbol}-USD`, `1000${symbol}-USD`]) {
      if (!markets.has(market) || STOCK_MARKET_SET.has(market)) continue;
      if (!out.has(market)) out.set(market, { symbol, market, kind: AssetKind.crypto });
      break;
    }
  }
  return [...out.values()].sort((a, b) => a.market.localeCompare(b.market));
}

/** Văn bản dùng để băm khi loại bài trùng y hệt: bỏ thẻ HTML, gộp khoảng trắng, viết thường. */
export function normalizedText(title: string | null, content: string | null): string {
  return `${title ?? ""}\n${stripHtml(content ?? "")}`.toLowerCase().replace(/\s+/g, " ").trim();
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

// ── Understand ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Một cách viết của tài sản trong bài và cách khớp (review PM #301):
 * - `symbol`: ký hiệu, luôn phân biệt hoa thường (chỉ chữ HOA: "LINK" khớp, "link" không);
 * - `word`: tên một từ, phải viết hoa chữ đầu ("Near" / "NEAR" khớp, "near" không);
 * - `phrase`: tên ≥ 2 từ, khớp cả cụm, không phân biệt hoa thường ("taiwan semiconductor").
 */
export interface AssetAlias {
  text: string;
  match: "symbol" | "word" | "phrase";
}

/** Đuôi pháp lý / loại cổ phiếu bỏ khỏi tên ("ADVANCED MICRO DEVICES, INC." → "ADVANCED MICRO DEVICES"). */
const NAME_SUFFIX =
  /[\s,]+(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|sa|nv|ag|se|adr|xstock|class\s+[a-c]|common\s+stock|ordinary\s+shares)\.?$/i;

const tidy = (s: string) => s.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, " ").trim();

function plainName(name: string | null): string | null {
  if (name === null) return null;
  if (isStockName(name)) return /"EN"\s*:\s*"([^"]*)"/i.exec(name)?.[1] ?? null;
  return name;
}

function stripSuffixes(name: string): string {
  let out = name.replace(/[.,]+$/, "");
  for (let prev = ""; prev !== out;) {
    prev = out;
    out = out.replace(NAME_SUFFIX, "").replace(/[.,]+$/, "");
  }
  return out;
}

const wordsOf = (s: string) => s.split(" ").length;

/**
 * Các cách viết của một ứng viên để kiểm "tài sản có trong bài" (news-v3, #298): ký hiệu SoSoValue và gốc market SoDEX
 * ("1000PEPE-USD" → "1000PEPE", "PEPE") khớp chữ HOA; tên SoSoValue gắn với ký hiệu đó và tên đã bỏ đuôi pháp lý. Cổ
 * phiếu: tên đã bỏ đuôi chỉ dùng khi còn ≥ 2 từ ("BLOCK, INC." → "Block" là từ thường, không dùng); tên thương hiệu một từ
 * chỉ đến từ bảng tường minh `STOCK_BRAND_ALIASES` (Nvidia, Google…). Không đoán tên từ chữ đầu.
 */
export function assetAliases(
  candidate: Candidate,
  matched: readonly MatchedCurrency[],
): AssetAlias[] {
  const out = new Map<string, AssetAlias>();
  const add = (raw: string, symbol: boolean) => {
    const text = tidy(raw);
    if (text.length === 0) return;
    const match = symbol ? "symbol" : wordsOf(text) >= 2 ? "phrase" : "word";
    const key = `${match}:${match === "symbol" ? text.toUpperCase() : text.toLowerCase()}`;
    if (!out.has(key))
      out.set(key, { text: match === "symbol" ? text.toUpperCase() : text, match });
  };
  const stock = candidate.kind === AssetKind.stock;
  const base = candidate.market.replace(/-USD$/i, "");
  add(candidate.symbol, true);
  add(base, true);
  if (/^1000./.test(base)) add(base.slice(4), true);
  for (const m of matched) {
    if (m.symbol.trim().toUpperCase() !== candidate.symbol.toUpperCase()) continue;
    const name = plainName(m.name);
    if (name === null || tidy(name).length < 2) continue;
    const full = tidy(name);
    if (!stock || wordsOf(full) >= 2) add(full, false);
    const short = stripSuffixes(full);
    if (short.length >= 2 && (!stock || wordsOf(short) >= 2)) add(short, false);
  }
  if (stock) for (const brand of STOCK_BRAND_ALIASES[candidate.market] ?? []) add(brand, false);
  return [...out.values()];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const startsUpper = (s: string) => {
  const c = s.charAt(0);
  return c === c.toUpperCase();
};

/** Có cách viết nào của tài sản trong văn bản, đứng riêng một từ ("ETH" không khớp "ETHENA"). */
export function mentionsAsset(text: string, aliases: readonly AssetAlias[]): boolean {
  const t = tidy(text);
  return aliases.some((a) => {
    const body = `(?<![\\p{L}\\p{N}])${escapeRe(a.text)}(?![\\p{L}\\p{N}])`;
    if (a.match === "symbol") return new RegExp(body, "u").test(t);
    if (a.match === "phrase") return new RegExp(body, "iu").test(t);
    return [...t.matchAll(new RegExp(body, "giu"))].some((m) => startsUpper(m[0]));
  });
}

/** Tài sản Claude chọn phải có trong tiêu đề hoặc nội dung bài (news-v3, #298); không thì `ASSET_NOT_IN_TEXT`. */
export function assetInText(
  title: string | null,
  content: string | null,
  candidate: Candidate,
  matched: readonly MatchedCurrency[],
): boolean {
  return mentionsAsset(`${title ?? ""}\n${content ?? ""}`, assetAliases(candidate, matched));
}

const isTreasury = (c: SignalCatalyst) => c === "treasury_buy" || c === "treasury_sell";
const TREASURY_EXCLUDED: ReadonlySet<string> = new Set(NEWS_RULES.treasuryExcludedMarkets);

/** news-v3 (#298): treasury buy / sell trên BTC / ETH không bao giờ giao dịch (`TREASURY_MAJOR_ASSET`). */
export function treasuryOnMajorAsset(catalyst: SignalCatalyst, market: string): boolean {
  return isTreasury(catalyst) && TREASURY_EXCLUDED.has(market);
}

/**
 * Cờ "small treasury?" (#298): tin treasury mà Claude không trích được số tiền (thiếu, rỗng hoặc "unknown"). Chỉ để phân
 * tích sau, không chặn lệnh; không bao giờ tự đoán số tiền.
 */
export function smallTreasury(
  catalyst: SignalCatalyst,
  amount: string | null | undefined,
): boolean {
  if (!isTreasury(catalyst)) return false;
  const a = (amount ?? "").trim().toLowerCase();
  return a === "" || a === "unknown";
}

export function sourceTierOf(author: string, category: number | null): SourceTier {
  const known = SOURCE_TIERS[author.trim().toLowerCase()];
  if (known !== undefined) return known;
  return category === SOSO_OFFICIAL_CATEGORY ? SourceTier.mid : SourceTier.low;
}

export interface StorySource {
  name: string;
  tier: SourceTier;
}

/**
 * Mức tin cậy theo nguồn độc lập (tên tác giả khác nhau): High = ≥ 2 nguồn có ít nhất 1 top; Medium = 1 top hoặc
 * ≥ 2 mid; Low = còn lại. Một nguồn xuất hiện nhiều lần chỉ tính một, với hạng cao nhất của nó.
 */
export function levelOf(sources: readonly StorySource[]): SignalLevel {
  const best = new Map<string, SourceTier>();
  const rank = { top: 2, mid: 1, low: 0 } as const;
  for (const s of sources) {
    const k = s.name.trim().toLowerCase();
    const prev = best.get(k);
    if (prev === undefined || rank[s.tier] > rank[prev]) best.set(k, s.tier);
  }
  const tiers = [...best.values()];
  const top = tiers.filter((t) => t === SourceTier.top).length;
  const mid = tiers.filter((t) => t === SourceTier.mid).length;
  if (tiers.length >= 2 && top >= 1) return SignalLevel.high;
  if (top >= 1 || mid >= 2) return SignalLevel.medium;
  return SignalLevel.low;
}

export function storyKey(market: string, catalyst: SignalCatalyst): string {
  return `${market}|${catalyst}`;
}

/**
 * Sự kiện cũ hơn `maxEventAgeHours` so với giờ đăng. Claude chỉ cho ngày (UTC), nên tính theo cuối ngày đó: chỉ bỏ khi
 * cả ngày sự kiện đã qua hơn 24 giờ trước giờ đăng. Không có ngày → không bỏ.
 */
export function eventTooOld(eventDate: string | null, publishedAt: number): boolean {
  if (eventDate === null || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return false;
  const endOfDay = Date.parse(`${eventDate}T00:00:00Z`) + 24 * HOUR_MS;
  if (Number.isNaN(endOfDay)) return false;
  return publishedAt - endOfDay > NEWS_RULES.maxEventAgeHours * HOUR_MS;
}

// ── Filter ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Quote {
  bid: Decimal;
  ask: Decimal;
  /** `book`: giá tốt nhất SoDEX từ marketdata; `last_spread`: giá gần nhất ± nửa spread đo theo giờ. */
  source: "book" | "last_spread";
}

export function midOf(q: Pick<Quote, "bid" | "ask">): Decimal {
  return q.bid.add(q.ask).div(2);
}

/** Spread (%) = (ask − bid) ÷ mid × 100. */
export function spreadPctOf(q: Pick<Quote, "bid" | "ask">): Decimal {
  return q.ask.sub(q.bid).div(midOf(q)).mul(HUNDRED);
}

/** Phí một chiều (%) = taker SoDEX của market (tỷ lệ thô, thiếu thì mặc định) + builder fee. */
export function oneWayFeePct(takerFraction: DecimalInput | null, builderRate: number): Decimal {
  const taker =
    takerFraction === null ? dec(SODEX_BASE_FEE_PCT.perps.taker) : dec(takerFraction).mul(HUNDRED);
  return taker.add(feeRateToPercent(builderRate));
}

export interface RoundTripCost {
  /** taker ×2 + builder ×2 (%). */
  feePct: Decimal;
  spreadPct: Decimal;
  totalPct: Decimal;
}

export function roundTripCost(oneWayFee: Decimal, spreadPct: Decimal): RoundTripCost {
  const feePct = oneWayFee.mul(2);
  return { feePct, spreadPct, totalPct: feePct.add(spreadPct) };
}

/**
 * TP phải ≥ 2 × chi phí khứ hồi. Không đạt: "Too thin to trade" khi spread chiếm phần lớn chi phí (spread ≥ phí), không
 * thì "move too small for cost".
 */
export function costCheck(tpPct: Decimal, cost: RoundTripCost): SignalReason | null {
  if (tpPct.gte(cost.totalPct.mul(NEWS_RULES.minTpCostMultiple))) return null;
  return cost.spreadPct.gte(cost.feePct) ? SignalReason.tooThin : SignalReason.moveTooSmall;
}

/**
 * Biến động thường gặp (%) trong `holdHours`: trung vị |close(t + H) − close(t)| ÷ close(t) × 100, với `closes` là giá
 * đóng mỗi giờ (tăng dần theo thời gian, không cần liên tục: chỉ ghép cặp đúng t và t + H). Ít mẫu → null.
 */
export function typicalMovePct(
  closes: readonly { hour: number; close: DecimalInput }[],
  holdHours: number,
): Decimal | null {
  const byHour = new Map<number, Decimal>();
  for (const c of closes) byHour.set(c.hour, dec(c.close));
  const moves: Decimal[] = [];
  for (const [hour, close] of byHour) {
    const later = byHour.get(hour + holdHours * HOUR_MS);
    if (later === undefined || close.lte(0)) continue;
    moves.push(later.sub(close).abs().div(close).mul(HUNDRED));
  }
  if (moves.length < NEWS_RULES.volatilityMinSamples) return null;
  moves.sort((a, b) => a.cmp(b));
  const mid = Math.floor(moves.length / 2);
  const hi = moves[mid];
  const lo = moves[mid - 1];
  if (hi === undefined || lo === undefined) return null;
  return moves.length % 2 === 1 ? hi : hi.add(lo).div(2);
}

// ── Decide ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TradePlan {
  direction: TradeDirection;
  entryPrice: Decimal;
  entryMid: Decimal;
  qty: Decimal;
  sizeUsdc: Decimal;
  tpPct: Decimal;
  slPct: Decimal;
  tpPrice: Decimal;
  slPrice: Decimal;
  entryFee: Decimal;
  feePct: Decimal;
}

/**
 * Lệnh paper như lệnh market: long vào ở ask, short ở bid (= mid ± nửa spread), phí một chiều tính trên cỡ lệnh.
 * TP = 1.5 ×, SL = 0.75 × biến động thường gặp, tính từ giá vào.
 */
export function planTrade(input: {
  direction: TradeDirection;
  quote: Pick<Quote, "bid" | "ask">;
  typicalMovePct: Decimal;
  oneWayFeePct: Decimal;
  sizeUsdc?: DecimalInput;
}): TradePlan {
  const long = input.direction === TradeDirection.long;
  const entryPrice = long ? input.quote.ask : input.quote.bid;
  const sizeUsdc = dec(input.sizeUsdc ?? NEWS_RULES.sizeUsdc);
  const tpPct = input.typicalMovePct.mul(NEWS_RULES.tpMultiple);
  const slPct = input.typicalMovePct.mul(NEWS_RULES.slMultiple);
  const up = (p: Decimal) => entryPrice.mul(HUNDRED.add(p)).div(HUNDRED);
  const down = (p: Decimal) => entryPrice.mul(HUNDRED.sub(p)).div(HUNDRED);
  return {
    direction: input.direction,
    entryPrice,
    entryMid: midOf(input.quote),
    qty: sizeUsdc.div(entryPrice),
    sizeUsdc,
    tpPct,
    slPct,
    tpPrice: long ? up(tpPct) : down(tpPct),
    slPrice: long ? down(slPct) : up(slPct),
    entryFee: sizeUsdc.mul(input.oneWayFeePct).div(HUNDRED),
    feePct: input.oneWayFeePct,
  };
}

/** Giá đã chạy (%) từ lúc tin ra tới lúc vào lệnh (giá giữa), dấu theo giá: dương = giá tăng. */
export function movedPct(before: DecimalInput, after: DecimalInput): Decimal | null {
  const b = dec(before);
  if (b.lte(0)) return null;
  return dec(after).sub(b).div(b).mul(HUNDRED);
}

/** Giờ giao dịch chính của sàn Mỹ: thứ 2–6, 9:30–16:00 America/New_York (không tính ngày lễ). */
export function isUsMarketOpen(at: number): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = get("weekday");
  if (day === "Sat" || day === "Sun") return false;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

// ── Watch ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface OpenTradeView {
  direction: TradeDirection;
  tpPrice: Decimal;
  slPrice: Decimal;
  maxHoldUntil: number;
}

export interface ExitDecision {
  reason: PaperExitReason;
  price: Decimal;
}

/**
 * Lệnh long đóng theo bid, short theo ask (như lệnh market). Chạm hoặc nhảy qua TP thì đóng đúng ở TP (thận trọng, như
 * DEC-321); chạm SL thì đóng ở giá quan sát được (có thể tệ hơn SL); hết thời gian giữ thì đóng ở giá hiện tại. Không có
 * giá → chờ (null), kể cả khi đã quá hạn giữ.
 */
export function exitCheck(
  t: OpenTradeView,
  quote: Pick<Quote, "bid" | "ask"> | null,
  now: number,
): ExitDecision | null {
  if (quote === null) return null;
  const long = t.direction === TradeDirection.long;
  const px = long ? quote.bid : quote.ask;
  if (long ? px.gte(t.tpPrice) : px.lte(t.tpPrice))
    return { reason: PaperExitReason.takeProfit, price: t.tpPrice };
  if (long ? px.lte(t.slPrice) : px.gte(t.slPrice))
    return { reason: PaperExitReason.stopLoss, price: px };
  if (now >= t.maxHoldUntil) return { reason: PaperExitReason.maxHold, price: px };
  return null;
}

/** Kết quả sau phí (USDC và % trên cỡ lệnh): lãi giá − phí vào − phí ra (phí ra tính trên notional lúc ra). */
export function closeResult(input: {
  direction: TradeDirection;
  entryPrice: DecimalInput;
  exitPrice: DecimalInput;
  qty: DecimalInput;
  sizeUsdc: DecimalInput;
  entryFee: DecimalInput;
  feePct: DecimalInput;
}): { exitFee: Decimal; resultUsdc: Decimal; resultPct: Decimal } {
  const qty = dec(input.qty);
  const exit = dec(input.exitPrice);
  const move = exit.sub(dec(input.entryPrice));
  const gross = qty.mul(input.direction === TradeDirection.long ? move : move.neg());
  const exitFee = qty.mul(exit).mul(dec(input.feePct)).div(HUNDRED);
  const resultUsdc = gross.sub(dec(input.entryFee)).sub(exitFee);
  return { exitFee, resultUsdc, resultPct: resultUsdc.div(dec(input.sizeUsdc)).mul(HUNDRED) };
}

/**
 * Biến động thuận lợi / bất lợi (%, theo chiều lệnh) của giá giữa so với giá vào: dương = có lợi. MFE = max, MAE = min
 * (âm hoặc 0) qua các lần quan sát.
 */
export function favourableMovePct(
  direction: TradeDirection,
  entry: Decimal,
  mid: Decimal,
): Decimal {
  const move = mid.sub(entry).div(entry).mul(HUNDRED);
  return direction === TradeDirection.long ? move : move.neg();
}
