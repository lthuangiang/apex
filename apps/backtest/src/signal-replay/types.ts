import type { Decimal } from "@drift/shared";

// Khuôn lệnh replay A / B / C (#274). Cùng các field mà lệnh paper của #271 cần (type, nhãn "Replay", asset, chiều,
// seen_at, độ trễ, entry, TP, SL, max hold, exit, lý do, kết quả sau phí, giá đã chạy trước khi vào, rule version), để
// PM ghi vào bảng của #271 sau. Báo cáo JSON: Decimal tự thành chuỗi qua `toJSON`.

export type Direction = "long" | "short";
export const SIGNAL_TYPES = ["whale", "funding", "price_structure"] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];
export type ExitReason = "take_profit" | "stop_loss" | "max_hold";

/** Kích thước paper cố định của một lệnh (USDC), như lệnh news của #269. */
export const PAPER_SIZE_USDC = "500";

export interface SignalTrade {
  type: SignalType;
  /** Biến thể luật trong một loại (C có hai: `range_breakout`, `squeeze_breakout`). */
  variant: string;
  label: "Replay";
  ruleVersion: string;
  asset: string;
  direction: Direction;
  /** Lúc sự kiện xảy ra (fill của cá voi, giờ funding, giờ đóng nến). */
  eventAt: number;
  /** Lúc DeskLabs thấy sự kiện. */
  seenAt: number;
  /** seenAt − eventAt (ms). */
  delayMs: number;
  status: "entered" | "skipped";
  skipReason: string | null;
  /** Một dòng mô tả bằng tiếng Anh, như cột "What happened" của #269. */
  what: string;
  /** Điểm theo trọng số chốt trước (chỉ cá voi có), để phân tích theo nhóm điểm; không có ngưỡng. */
  score: number | null;
  entryAt: number | null;
  entry: Decimal | null;
  tp: Decimal | null;
  sl: Decimal | null;
  maxHoldMs: number;
  exitAt: number | null;
  exit: Decimal | null;
  exitReason: ExitReason | null;
  /** Chi phí khứ hồi (bp): taker × 2 + builder fee × 2 + spread. */
  costBp: Decimal | null;
  /** Kết quả theo chiều lệnh trước phí (bp). */
  grossBp: Decimal | null;
  resultAfterFeesBp: Decimal | null;
  /** Kết quả sau phí trên `PAPER_SIZE_USDC`. */
  resultAfterFeesUsd: Decimal | null;
  /** Giá thay đổi bao nhiêu (bp, có dấu, không theo chiều lệnh) từ lúc sự kiện xảy ra tới lúc vào lệnh. */
  movedBeforeEntryBp: Decimal | null;
  /** Kết quả sau phí của cùng thời điểm nếu vào Long / Short (cùng TP / SL / max hold), cho random baseline. */
  longAfterFeesBp: Decimal | null;
  shortAfterFeesBp: Decimal | null;
  /** Kết quả kỳ vọng của lệnh vào ngẫu nhiên cùng thời điểm, cùng tỉ lệ Long / Short của nhóm (gắn sau, `attachRandom`). */
  randomAfterFeesBp: Decimal | null;
  /** Biến động thuận lợi / bất lợi lớn nhất trong lúc giữ (bp, theo chiều lệnh). */
  mfeBp: Decimal | null;
  maeBp: Decimal | null;
  /** Cờ chất lượng dữ liệu: `spread_default`, `tick_inferred`, `entry_mid_1s`, `vol_history_short`, `in_pause_window`… */
  flags: string[];
  detail: Record<string, string | number | boolean | null>;
}

/** Lệnh rỗng của một tín hiệu (chưa vào), để evaluator điền dần. */
export function blankTrade(
  base: Pick<
    SignalTrade,
    | "type"
    | "variant"
    | "ruleVersion"
    | "asset"
    | "direction"
    | "eventAt"
    | "seenAt"
    | "what"
    | "maxHoldMs"
  > &
    Partial<Pick<SignalTrade, "score" | "detail" | "flags">>,
): SignalTrade {
  return {
    label: "Replay",
    delayMs: base.seenAt - base.eventAt,
    status: "skipped",
    skipReason: null,
    entryAt: null,
    entry: null,
    tp: null,
    sl: null,
    exitAt: null,
    exit: null,
    exitReason: null,
    costBp: null,
    grossBp: null,
    resultAfterFeesBp: null,
    resultAfterFeesUsd: null,
    movedBeforeEntryBp: null,
    longAfterFeesBp: null,
    shortAfterFeesBp: null,
    randomAfterFeesBp: null,
    mfeBp: null,
    maeBp: null,
    score: null,
    flags: [],
    detail: {},
    ...base,
  };
}
