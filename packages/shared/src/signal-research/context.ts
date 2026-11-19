import { dec, Decimal, type DecimalInput } from "../money";
import { diffByDayBootstrap, type DayObs } from "../stats/day-bootstrap";

import { TradeDirection } from "./rules";

// Ngữ cảnh của tín hiệu tin (#329, giai đoạn 1: chỉ ghi, không chặn lệnh). Tin là trigger duy nhất; cá voi Hyperliquid,
// funding SoDEX và giá đã chạy là NGỮ CẢNH, chụp đúng lúc quyết định (bước 4, sau Score, trước Filter), lưu một lần, không
// tính lại. Ba giả thuyết đăng ký trước, ngưỡng cố định (không đổi sau khi xem kết quả):
//   H1 cá voi cùng chiều, H2 funding ngược đám đông, H3 giá đã chạy.
// Review PR #349 (trước khi có lệnh nào được tính, nên sửa định nghĩa là hợp lệ): H1 chỉ xét ví DeskLabs ĐANG THEO DÕI
// (được follow, và đã có trong leaderboard trước thời điểm đó), vì sự kiện live chỉ có cho các ví này (DEC-321), không phải
// toàn leaderboard; H3 đo từ giờ đăng của bài ĐẦU TIÊN của story, cùng con số với `moved_before_entry` (#312).
// Mọi hàm ở đây thuần, không I/O; nơi gọi chỉ đưa vào dữ liệu có timestamp < thời điểm quyết định (không nhìn trước).

/** Version của cách tính ngữ cảnh; đổi ngưỡng / định nghĩa = version mới, snapshot cũ giữ nguyên. */
export const SIGNAL_CONTEXT_VERSION = "context-v1";

export const SIGNAL_CONTEXT_RULES = {
  /** H1: cửa sổ trước quyết định để tìm ví mở / tăng vị thế cùng chiều. */
  h1WindowMinutes: 60,
  /** H1: loại sự kiện tính là mở / tăng vị thế (flip = mở vị thế mới theo chiều sau sự kiện). */
  h1Kinds: ["open", "add", "flip"] as readonly string[],
  /** H2: khoảng lịch sử funding để tính percentile. */
  h2LookbackDays: 30,
  /** H2: Long khi percentile ≤ mức này. */
  h2LongMaxPercentile: 20,
  /** H2: Short khi percentile ≥ mức này. */
  h2ShortMinPercentile: 80,
  /** H2: ít hơn ngần này kỳ funding trong 30 ngày → `na` (không đủ lịch sử). */
  h2MinSamples: 30,
  /** H2: kỳ funding gần nhất cũ hơn ngần này giờ → `na` (không có funding hiện tại). */
  h2MaxStaleHours: 24,
  /** H3: giá đã chạy ≥ bội số này × biến động 1 giờ thường gặp, theo chiều tín hiệu → `yes`. */
  h3Multiple: 1,
  /** H3: biến động thường gặp đo trong ngần này giờ. */
  h3TypicalHours: 1,
  /** So sánh: mỗi nhóm (có / không) cần ít nhất ngần này lệnh đóng mới có kết luận. */
  compareMinClosed: 30,
} as const;

export const ContextSource = { live: "live", backfilled: "backfilled" } as const;
export type ContextSource = (typeof ContextSource)[keyof typeof ContextSource];
export const CONTEXT_SOURCES = Object.values(ContextSource) as [ContextSource, ...ContextSource[]];

/**
 * H1: `against` = chỉ có ví ngược chiều (lưu riêng để phân tích khám phá; trong so sánh chính tính vào nhóm "without");
 * `na` = tài sản không có trên Hyperliquid hoặc không có ví theo dõi nào có dữ liệu (không bao giờ trộn với `no`).
 */
export const H1_STATUSES = ["yes", "no", "against", "na"] as const;
export type H1Status = (typeof H1_STATUSES)[number];
export const H2_STATUSES = ["yes", "no", "na"] as const;
export type H2Status = (typeof H2_STATUSES)[number];
/** H3: `na` khi thiếu giá lúc đăng / giá lúc quyết định / biến động thường gặp. */
export const H3_STATUSES = ["yes", "no", "na"] as const;
export type H3Status = (typeof H3_STATUSES)[number];

export const FUNDING_PAYERS = ["long", "short", "none"] as const;
export type FundingPayer = (typeof FUNDING_PAYERS)[number];
export const RANGE_BREAKOUTS = ["up", "down", "none"] as const;
export type RangeBreakout = (typeof RANGE_BREAKOUTS)[number];

const HUNDRED = new Decimal(100);
const HOUR_MS = 3_600_000;

// ── H1 cá voi cùng chiều ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Một lần mở / tăng vị thế của một ví đang theo dõi (được follow, đã có trong leaderboard trước quyết định); nơi gọi đã lọc
 * ví, loại, cửa sổ, seen_at.
 */
export interface WhaleMove {
  address: string;
  /** Vị thế có dấu SAU sự kiện: > 0 long, < 0 short. */
  positionAfter: DecimalInput;
  /** Notional thay đổi (USD, dương). */
  notional: DecimalInput;
  /** Giờ fill đầu tiên (ms). */
  at: number;
}

export interface H1Result {
  status: H1Status;
  /**
   * N = số ví thật sự được kiểm: ví DeskLabs đang theo dõi (được follow trước quyết định, đã có trong một lần xếp hạng xong
   * trước quyết định) mà marketdata đã đọc fill ("N wallets checked"; không bao giờ là số ví của cả leaderboard).
   */
  walletsChecked: number;
  /** Tài sản có trên Hyperliquid (theo dữ liệu đã lưu trước quyết định). */
  assetOnHyperliquid: boolean;
  agreeingWallets: number;
  opposingWallets: number;
  /** Tổng notional (USD) của các sự kiện cùng chiều; null khi không có. */
  agreeingUsdc: Decimal | null;
  /** Giờ fill đầu tiên của sự kiện cùng chiều sớm nhất; null khi không có. */
  firstAt: number | null;
}

/**
 * H1: ít nhất 1 ví DeskLabs đang theo dõi (được follow, và đã có trong leaderboard trước thời điểm đó) mở / tăng vị thế cùng
 * chiều trong 60 phút trước quyết định → `yes`; chỉ ví ngược chiều → `against`; tài sản không có trên Hyperliquid, hoặc số ví
 * theo dõi có dữ liệu = 0 → `na`; còn lại → `no` (N ví đã kiểm đều im lặng).
 */
export function h1Of(input: {
  direction: TradeDirection;
  walletsChecked: number;
  assetOnHyperliquid: boolean;
  moves: readonly WhaleMove[];
}): H1Result {
  const agree = new Set<string>();
  const oppose = new Set<string>();
  let usdc = new Decimal(0);
  let firstAt: number | null = null;
  const long = input.direction === TradeDirection.long;
  for (const m of input.moves) {
    const after = dec(m.positionAfter);
    if (after.isZero()) continue;
    const key = m.address.toLowerCase();
    if (after.gt(0) === long) {
      agree.add(key);
      usdc = usdc.add(dec(m.notional).abs());
      firstAt = firstAt === null ? m.at : Math.min(firstAt, m.at);
    } else oppose.add(key);
  }
  const base = {
    walletsChecked: input.walletsChecked,
    assetOnHyperliquid: input.assetOnHyperliquid,
    agreeingWallets: agree.size,
    opposingWallets: oppose.size,
    agreeingUsdc: agree.size === 0 ? null : usdc,
    firstAt,
  };
  if (!input.assetOnHyperliquid || input.walletsChecked === 0)
    return {
      ...base,
      status: "na",
      agreeingWallets: 0,
      opposingWallets: 0,
      agreeingUsdc: null,
      firstAt: null,
    };
  if (agree.size > 0) return { ...base, status: "yes" };
  if (oppose.size > 0) return { ...base, status: "against" };
  return { ...base, status: "no" };
}

// ── H2 funding ngược đám đông ────────────────────────────────────────────────────────────────────────────────────────

export interface ContextFundingPoint {
  at: number;
  rate: DecimalInput;
}

export interface H2Result {
  status: H2Status;
  /** Funding kỳ gần nhất trước quyết định (tỷ lệ thô mỗi kỳ); null khi không có. */
  rate: Decimal | null;
  rateAt: number | null;
  /** Percentile (0–100, hạng giữa) của funding hiện tại trong 30 ngày; null khi `na`. */
  percentile: number | null;
  samples: number;
  /** Bên trả funding: rate > 0 → long trả, < 0 → short trả. */
  payer: FundingPayer | null;
  /** Kỳ funding (giờ) suy từ khoảng cách trung vị giữa các kỳ; null khi < 2 kỳ. */
  intervalHours: number | null;
}

/**
 * Percentile hạng giữa: 100 × (số giá trị nhỏ hơn + ½ số giá trị bằng) ÷ n. Hạng giữa để các kỳ funding bằng nhau (SoDEX
 * hay đứng ở một mức sàn) không bị đẩy hết về một phía.
 */
export function midRankPercentile(
  value: DecimalInput,
  all: readonly DecimalInput[],
): number | null {
  if (all.length === 0) return null;
  const v = dec(value);
  let below = 0;
  let equal = 0;
  for (const x of all) {
    const c = dec(x).cmp(v);
    if (c < 0) below += 1;
    else if (c === 0) equal += 1;
  }
  return new Decimal(below)
    .add(new Decimal(equal).div(2))
    .div(all.length)
    .mul(HUNDRED)
    .toDecimalPlaces(4)
    .toNumber();
}

function medianGapHours(points: readonly ContextFundingPoint[]): number | null {
  if (points.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a !== undefined && b !== undefined && b.at > a.at) gaps.push(b.at - a.at);
  }
  if (gaps.length === 0) return null;
  gaps.sort((x, y) => x - y);
  const mid = gaps[Math.floor(gaps.length / 2)] ?? 0;
  return Math.round((mid / HOUR_MS) * 100) / 100;
}

/**
 * H2: funding kỳ gần nhất (trước quyết định) so với 30 ngày trước đó (gồm kỳ đó). Long: percentile ≤ 20 → `yes`; Short:
 * ≥ 80 → `yes`; ít hơn 30 kỳ hoặc kỳ gần nhất cũ hơn 24 giờ → `na`. `points` chỉ gồm kỳ có funding_time < quyết định.
 */
export function h2Of(input: {
  direction: TradeDirection;
  decidedAt: number;
  points: readonly ContextFundingPoint[];
}): H2Result {
  const r = SIGNAL_CONTEXT_RULES;
  const since = input.decidedAt - r.h2LookbackDays * 24 * HOUR_MS;
  const pts = input.points
    .filter((p) => p.at < input.decidedAt && p.at >= since)
    .sort((a, b) => a.at - b.at);
  const last = pts.at(-1);
  const rate = last === undefined ? null : dec(last.rate);
  const payer: FundingPayer | null =
    rate === null ? null : rate.gt(0) ? "long" : rate.lt(0) ? "short" : "none";
  const base = {
    rate,
    rateAt: last?.at ?? null,
    samples: pts.length,
    payer,
    intervalHours: medianGapHours(pts),
  };
  if (
    last === undefined ||
    rate === null ||
    pts.length < r.h2MinSamples ||
    input.decidedAt - last.at > r.h2MaxStaleHours * HOUR_MS
  )
    return { ...base, status: "na", percentile: null };
  const percentile = midRankPercentile(
    rate,
    pts.map((p) => p.rate),
  );
  if (percentile === null) return { ...base, status: "na", percentile: null };
  const yes =
    input.direction === TradeDirection.long
      ? percentile <= r.h2LongMaxPercentile
      : percentile >= r.h2ShortMinPercentile;
  return { ...base, status: yes ? "yes" : "no", percentile };
}

/** Ngưỡng percentile của H2 theo chiều (để web ghi "Long needs ≤ 20th"). */
export const h2ThresholdOf = (direction: TradeDirection): number =>
  direction === TradeDirection.long
    ? SIGNAL_CONTEXT_RULES.h2LongMaxPercentile
    : SIGNAL_CONTEXT_RULES.h2ShortMinPercentile;

// ── H3 giá đã chạy ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface H3Result {
  status: H3Status;
  /**
   * Giá đã chạy (%, có dấu như `movedPct`: dương = tăng) từ giờ đăng của bài ĐẦU TIÊN của story tới giá giữa lúc quyết định;
   * cùng con số với `moved_before_entry` của lệnh (#312). null khi thiếu giá.
   */
  movedPct: Decimal | null;
  typicalMovePct: Decimal | null;
  /** Ngưỡng = bội số × biến động 1 giờ thường gặp; null khi không có. */
  thresholdPct: Decimal | null;
}

/** H3: giá đã chạy theo chiều tín hiệu ≥ 1 × biến động 1 giờ thường gặp → `yes`; thiếu số → `na`. */
export function h3Of(input: {
  direction: TradeDirection;
  movedPct: Decimal | null;
  typicalMovePct: Decimal | null;
}): H3Result {
  const threshold =
    input.typicalMovePct === null
      ? null
      : input.typicalMovePct.mul(SIGNAL_CONTEXT_RULES.h3Multiple);
  const base = {
    movedPct: input.movedPct,
    typicalMovePct: input.typicalMovePct,
    thresholdPct: threshold,
  };
  if (input.movedPct === null || threshold === null || threshold.lte(0))
    return { ...base, status: "na" };
  const inDirection =
    input.direction === TradeDirection.long ? input.movedPct : input.movedPct.neg();
  return { ...base, status: inDirection.gte(threshold) ? "yes" : "no" };
}

// ── Chỉ số khám phá (exploratory, không bao giờ thành tuỳ chọn version) ──────────────────────────────────────────────

/** Khối lượng giờ cuối ÷ khối lượng trung bình mỗi giờ của 24 giờ (cả hai kết thúc lúc quyết định); không có → null. */
export function volumeVs24h(
  lastHour: DecimalInput | null,
  day: DecimalInput | null,
): Decimal | null {
  if (lastHour === null || day === null) return null;
  const avg = dec(day).div(24);
  if (avg.lte(0)) return null;
  return dec(lastHour).div(avg);
}

/** Giá đóng gần nhất so với đỉnh / đáy 24 giờ trước đó (không gồm giờ cuối); thiếu số → null. */
export function rangeBreakoutOf(input: {
  last: DecimalInput | null;
  high: DecimalInput | null;
  low: DecimalInput | null;
}): RangeBreakout | null {
  if (input.last === null || input.high === null || input.low === null) return null;
  const last = dec(input.last);
  if (last.gt(dec(input.high))) return "up";
  if (last.lt(dec(input.low))) return "down";
  return "none";
}

// ── So sánh có / không ngữ cảnh ──────────────────────────────────────────────────────────────────────────────────────

export const CONTEXT_COMPARE_STATUSES = [
  "collecting",
  "no_clear_difference",
  "better_with",
  "worse_with",
] as const;
export type ContextCompareStatus = (typeof CONTEXT_COMPARE_STATUSES)[number];

export interface ContextCompare {
  status: ContextCompareStatus;
  withClosed: number;
  withoutClosed: number;
  /** Trung bình sau phí (%) từng nhóm, chênh (có − không) và khoảng 95% bootstrap ngày; null khi đang `collecting`. */
  withMean: Decimal | null;
  withoutMean: Decimal | null;
  diff: Decimal | null;
  ciLow: Decimal | null;
  ciHigh: Decimal | null;
  clusters: number;
  /** Còn thiếu bao nhiêu lệnh đóng ở mỗi nhóm trước khi so (0 khi đủ). */
  needWith: number;
  needWithout: number;
}

const meanOf = (xs: readonly DayObs[]): Decimal | null =>
  xs.length === 0 ? null : xs.reduce((s, o) => s.add(o.v), new Decimal(0)).div(xs.length);

/**
 * So kết quả sau phí của lệnh có / không ngữ cảnh. Mỗi nhóm < 30 lệnh đóng → `collecting` (không trả trung bình, chênh hay
 * khoảng, để không ai nhìn trộm trước khi đủ mẫu). Đủ: chênh hai trung bình + khoảng 95% block bootstrap theo ngày ghép
 * cặp (`diffByDayBootstrap`); cả khoảng trên 0 → `better_with`, dưới 0 → `worse_with`, còn lại (gồm khoảng không tính
 * được) → `no_clear_difference`.
 */
export function compareContext(
  withObs: readonly DayObs[],
  withoutObs: readonly DayObs[],
): ContextCompare {
  const min = SIGNAL_CONTEXT_RULES.compareMinClosed;
  const needWith = Math.max(0, min - withObs.length);
  const needWithout = Math.max(0, min - withoutObs.length);
  const base = {
    withClosed: withObs.length,
    withoutClosed: withoutObs.length,
    needWith,
    needWithout,
  };
  if (needWith > 0 || needWithout > 0)
    return {
      ...base,
      status: "collecting",
      withMean: null,
      withoutMean: null,
      diff: null,
      ciLow: null,
      ciHigh: null,
      clusters: 0,
    };
  const d = diffByDayBootstrap(withObs, withoutObs);
  const status: ContextCompareStatus =
    d.ciLow?.gt(0) === true
      ? "better_with"
      : d.ciHigh?.lt(0) === true
        ? "worse_with"
        : "no_clear_difference";
  return {
    ...base,
    status,
    withMean: meanOf(withObs),
    withoutMean: meanOf(withoutObs),
    diff: d.diff,
    ciLow: d.ciLow,
    ciHigh: d.ciHigh,
    clusters: d.clusters,
  };
}

/**
 * Nhóm của một lệnh theo một giả thuyết: `with` / `without`; `na` (không biết) bị loại khỏi cả hai nhóm. Nhận mọi trạng
 * thái H1 / H2 / H3 (H2 / H3 là tập con của H1).
 */
export function contextGroupOf(status: H1Status): "with" | "without" | null {
  if (status === "yes") return "with";
  if (status === "na") return null;
  return "without";
}
