import { dec, ReasonCode } from "@drift/shared";
import { useTranslations } from "next-intl";

// Nhãn lý do dừng / tạm dừng của bot, dùng chung cho danh sách bot, Trading Agent, Backtest và Stats
// (DEC-TBD-mm-form-copy, artboard StopReasons). Market Making dùng chung reason code với chiến lược khác, nên
// nhãn tuỳ theo chiến lược và dữ liệu có được. Thiếu dữ liệu thì nhãn chung, không bao giờ khẳng định sai.
//
// Volume Maker (`packages/strategies/src/volume-maker/index.ts`, hàm `guards`):
// - BUDGET_DONE: chi phí chạm `costBudget` ("Stop when costs reach").
// - STOP_LOSS: lỗ chưa chốt trên vị thế chạm `inventoryLossStop` ("Position loss limit").
// - MAX_CYCLES: đủ `volumeTarget`, hoặc tới `untilAt` khi `runUntil` là season_end / date.

export interface StopReasonInput {
  reasonCode: string;
  strategy?: string | null | undefined;
  /** Config của version đang chạy (nếu nơi hiển thị có). */
  config?: Record<string, unknown> | null | undefined;
  /** Volume Maker: khối lượng phiên và volume target theo engine (`BotDetail.volumeMaker`). */
  volume?: { volume: string; volumeTarget: string | null } | null | undefined;
}

const POSITIVE = /^\d+(\.\d+)?$/;
const num = (v: unknown): string | null =>
  typeof v === "string" && POSITIVE.test(v) ? v : typeof v === "number" && v > 0 ? String(v) : null;

/** Key trong namespace `reasons`. */
export function stopReasonKey(i: StopReasonInput): string {
  const code = i.reasonCode;
  if (i.strategy === "volume_farm" && code === ReasonCode.maxCycles) return "MAX_CYCLES_VOLUME";
  if (i.strategy !== "volume_maker") return code;
  if (code === ReasonCode.budgetDone) return "MM_BUDGET_DONE";
  if (code === ReasonCode.stopLoss) return "MM_STOP_LOSS";
  if (code !== ReasonCode.maxCycles) return code;

  const target = i.volume?.volumeTarget ?? num(i.config?.volumeTarget);
  const traded = i.volume?.volume ?? null;
  // Engine xét volume target trước end time; có khối lượng thật thì biết chắc lý do.
  if (traded !== null && POSITIVE.test(traded)) {
    if (target !== null && POSITIVE.test(target) && dec(traded).gte(target))
      return "MAX_CYCLES_VOLUME";
    // MAX_CYCLES chỉ có hai nguồn: chưa đủ target thì là hết giờ.
    return "MAX_CYCLES_END_TIME";
  }
  if (i.config !== null && i.config !== undefined) {
    const timed = i.config.runUntil === "season_end" || i.config.runUntil === "date";
    if (timed && target === null) return "MAX_CYCLES_END_TIME";
    if (!timed && target !== null) return "MAX_CYCLES_VOLUME";
  }
  return "MAX_CYCLES_MM";
}

/** Hook: input → câu chữ lý do. */
export function useReasonLabel() {
  const tr = useTranslations("reasons");
  return (i: StopReasonInput) => {
    const key = stopReasonKey(i);
    return tr.has(key) ? tr(key) : i.reasonCode;
  };
}
