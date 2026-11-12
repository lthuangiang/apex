import { Decimal, dec, type DecimalInput } from "../money";
import { analyze, ANALYST_THRESHOLDS, type AnalystBot } from "../portfolio/analyst";

// AI Desk (AI_DESK_RECOMMENDED.md, DEC-105): quy tắc cố định cho thẻ đề xuất, trang kết quả paper và nhận xét bot.
// Trả mã + số liệu; câu chữ nằm trong messages của web. Không dự báo, không kết luận "nên dùng tiền thật".

export const DESK_CONFIG = {
  /** Số bot paper đang chạy tối đa mỗi tài khoản (DEC-105, chờ duyệt). */
  maxRunningPaperBots: 3,
  /** Trang kết quả: dưới chừng này ngày thì "Too early to judge" (dùng chung ngưỡng của AI Analyst). */
  minDaysForComparison: ANALYST_THRESHOLDS.minDaysForComparison,
  /** Tài sản mặc định khi hỏi đề xuất (DEC-105). */
  defaultAssets: ["BTC", "ETH"],
} as const;

const DAY = 86_400_000;

/** Mức lỗ hiện trên thẻ: chiến lược có `maxLoss` thì có giới hạn; Recurring Buy và Rebalancing thì không. */
export type LossLimit = { kind: "limit"; amount: string } | { kind: "none" };

export function lossLimitOf(values: Readonly<Record<string, unknown>>): LossLimit {
  const v = values.maxLoss;
  if (typeof v === "string" && v !== "") {
    try {
      if (dec(v).gt(0)) return { kind: "limit", amount: dec(v).toString() };
    } catch {
      return { kind: "none" };
    }
  }
  return { kind: "none" };
}

export type PaperVerdict = "loss_limit" | "too_early" | "lost" | "made";

/**
 * Kết luận trang Test results, xét theo thứ tự (mục 8.5): chạm giới hạn lỗ → quá sớm (< 14 ngày) → lỗ → lãi.
 * `net` là lãi / lỗ sau phí và funding.
 */
export function paperVerdict(input: {
  stoppedByLossLimit: boolean;
  startedAt: number;
  now: number;
  net: DecimalInput;
}): PaperVerdict {
  if (input.stoppedByLossLimit) return "loss_limit";
  if (input.now - input.startedAt < DESK_CONFIG.minDaysForComparison * DAY) return "too_early";
  return dec(input.net).gt(0) ? "made" : "lost";
}

/** Ngày thứ mấy của bài test (ngày đầu là Day 1). */
export function paperDay(startedAt: number, now: number): number {
  return Math.max(1, Math.floor((now - startedAt) / DAY) + 1);
}

/** Chỉ giữ coin: vốn × (giá cuối / giá đầu − 1). null khi thiếu giá. */
export function holdResult(
  capital: DecimalInput,
  startPrice: DecimalInput | null,
  lastPrice: DecimalInput | null,
): string | null {
  if (startPrice === null || lastPrice === null) return null;
  const s = dec(startPrice);
  if (!s.gt(0)) return null;
  return dec(capital)
    .mul(dec(lastPrice).div(s).sub(1))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toString();
}

export type PaperReason =
  | { key: "noFills" }
  | { key: "stopped" }
  | { key: "feeShareOfProfit"; pct: string }
  | { key: "feeShareOfLoss"; pct: string }
  | { key: "limitUsed"; pct: string }
  | { key: "fills"; count: number };

/** "Why it turned out this way": câu theo quy tắc từ số liệu của bài test, tối đa 3 câu. */
export function paperReasons(input: {
  fills: number;
  net: DecimalInput;
  fees: DecimalInput;
  maxDrawdown: DecimalInput;
  lossLimit: LossLimit;
  stoppedByLossLimit: boolean;
}): PaperReason[] {
  const out: PaperReason[] = [];
  if (input.fills === 0) return [{ key: "noFills" }];
  if (input.stoppedByLossLimit) out.push({ key: "stopped" });
  const net = dec(input.net);
  const fees = dec(input.fees);
  const gross = net.add(fees);
  const pct = (v: Decimal) => v.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toString();
  if (fees.gt(0) && gross.gt(0) && net.gt(0))
    out.push({ key: "feeShareOfProfit", pct: pct(fees.div(gross)) });
  else if (fees.gt(0) && net.lt(0))
    out.push({ key: "feeShareOfLoss", pct: pct(fees.div(net.abs())) });
  if (input.lossLimit.kind === "limit" && dec(input.lossLimit.amount).gt(0))
    out.push({ key: "limitUsed", pct: pct(dec(input.maxDrawdown).div(input.lossLimit.amount)) });
  out.push({ key: "fills", count: input.fills });
  return out.slice(0, 3);
}

export type DeskNoteKind = "fees" | "attention" | "fine";

export interface DeskNote {
  botId: string;
  kind: DeskNoteKind;
  /** Số liệu quan sát được (chỉ có với `fees`). */
  fills: number;
  fees: string | null;
  net: string | null;
  quote: string;
  /** ms, chỉ có với `attention`. */
  since: number | null;
}

/**
 * Your bots: một nhận xét cho mỗi bot thật, dùng đúng quy tắc của AI Analyst (`analyze()`): lỗ chủ yếu vì phí,
 * bot báo cần chú ý; không khớp quy tắc nào thì "fine". Nhận xét không bao giờ tự sửa bot.
 */
export function deskNotes(bots: readonly AnalystBot[], now: number): DeskNote[] {
  const out = analyze({ now, portfolio: null, portfolioAt: null, bots, limitsBreached: null });
  const ids = new Set(out.insights.map((i) => i.id));
  return bots.map((b) => {
    const base = {
      botId: b.id,
      fills: b.fills,
      fees: b.fees,
      net: b.netPnl,
      quote: b.quote,
      since: null,
    };
    if (ids.has(`attention:${b.id}`))
      return { ...base, kind: "attention", since: b.attentionSince };
    if (ids.has(`fees:${b.id}`)) return { ...base, kind: "fees" };
    return { ...base, kind: "fine" };
  });
}
export * from "./needs-you";
