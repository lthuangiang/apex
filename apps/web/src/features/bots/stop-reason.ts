import { dec, ReasonCode } from "@drift/shared";
import { useTranslations } from "next-intl";

// Nhãn lý do dừng / tạm dừng của bot, dùng chung cho danh sách bot, Trading Agent, Backtest và Stats
// (DEC-262, artboard StopReasons). Market Making dùng chung reason code với chiến lược khác, nên
// nhãn tuỳ theo chiến lược và dữ liệu có được. Thiếu dữ liệu thì nhãn chung, không bao giờ khẳng định sai.
//
// Volume Maker (`packages/strategies/src/volume-maker/index.ts`, hàm `guards`):
// - BUDGET_DONE: chi phí chạm `costBudget` ("Stop when costs reach").
// - STOP_LOSS: lỗ chưa chốt trên vị thế chạm `inventoryLossStop` ("Position loss limit").
// - MAX_CYCLES: đủ `volumeTarget`, hoặc tới `untilAt` khi `runUntil` là season_end / date. API tính sẵn
//   `BotSummary.stopDetail` từ state runtime + config; nơi không có thì tự suy từ khối lượng / config.

export interface StopReasonInput {
  reasonCode: string;
  strategy?: string | null | undefined;
  /** `bots.mode`: bot paper không gửi gì tới SoDEX (DEC-105), nên lệnh bị từ chối là lệnh giả (PB-01). */
  mode?: string | null | undefined;
  /** `BotSummary.stopDetail` do API tính (Market Making dừng với MAX_CYCLES). */
  stopDetail?: "volume_target" | "end_time" | null | undefined;
  /** Config của version đang chạy (nếu nơi hiển thị có). */
  config?: Record<string, unknown> | null | undefined;
  /** Volume Maker: khối lượng phiên và volume target theo engine (`BotDetail.volumeMaker`). */
  volume?: { volume: string; volumeTarget: string | null } | null | undefined;
}

const POSITIVE = /^\d+(\.\d+)?$/;
/** Số dương (volume target); "0", số âm hay chữ thì null. */
const num = (v: unknown): string | null => {
  const s = typeof v === "number" && Number.isFinite(v) ? String(v) : v;
  return typeof s === "string" && POSITIVE.test(s) && dec(s).gt(0) ? s : null;
};

/** Key trong namespace `reasons`. */
export function stopReasonKey(i: StopReasonInput): string {
  const code = i.reasonCode;
  if (i.mode === "paper" && code === ReasonCode.orderRejected) return "ORDER_REJECTED_PAPER";
  if (i.strategy === "volume_farm" && code === ReasonCode.maxCycles) return "MAX_CYCLES_VOLUME";
  if (i.strategy !== "volume_maker") return code;
  if (code === ReasonCode.budgetDone) return "MM_BUDGET_DONE";
  if (code === ReasonCode.stopLoss) return "MM_STOP_LOSS";
  if (code !== ReasonCode.maxCycles) return code;
  if (i.stopDetail === "volume_target") return "MAX_CYCLES_VOLUME";
  if (i.stopDetail === "end_time") return "MAX_CYCLES_END_TIME";

  const target = num(i.volume?.volumeTarget ?? i.config?.volumeTarget);
  const traded = i.volume?.volume ?? null;
  // Engine xét volume target trước end time; có khối lượng thật thì biết chắc lý do.
  if (traded !== null && POSITIVE.test(traded)) {
    if (target !== null && dec(traded).gte(target)) return "MAX_CYCLES_VOLUME";
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

/** Id của sự kiện mới nhất có `why` = mã lý do bot đang mang (lần dừng hiện tại); undefined khi không có. */
export function stopEventIdOf(
  d:
    | {
        bot: { reasonCode: string | null };
        events: readonly { id: string; why: string | null; occurredAt: string }[];
      }
    | undefined,
): string | undefined {
  const code = d?.bot.reasonCode;
  if (d === undefined || code === null || code === undefined) return undefined;
  let best: { id: string; at: number } | undefined;
  for (const e of d.events) {
    if (e.why !== code) continue;
    const at = Date.parse(e.occurredAt);
    if (best === undefined || at > best.at) best = { id: e.id, at };
  }
  return best?.id;
}

/** Hook: input → câu chữ lý do. */
export function useReasonLabel() {
  const tr = useTranslations("reasons");
  return (i: StopReasonInput) => {
    const key = stopReasonKey(i);
    return tr.has(key) ? tr(key) : i.reasonCode;
  };
}
