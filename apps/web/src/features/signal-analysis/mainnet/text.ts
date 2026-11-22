import { ErrorCode, type ResearchDropReason } from "@drift/shared";
import { useTranslations } from "next-intl";

import { useBotErrorText } from "@/features/bots/components/bot-errors";
import { ApiError } from "@/lib/api";
import { uncertainOutcome } from "@/lib/financial-action";

// Câu chữ dùng chung của phần Mainnet (#421). Lỗi theo mã (C6): không hiện message thô của server.

/**
 * Mã lý do nội bộ của tín hiệu bị bỏ (`news_signal_deliveries.reason`) → nhãn lý do của phễu (`trace.reasonLabels.*`),
 * cùng bảng với API Signal research (`DROP` của packages/db). PM chốt (#421): không viết nhãn mới; mã chưa có nhãn ở phễu
 * hiện nguyên mã.
 */
const FUNNEL_REASON: ReadonlyMap<string, ResearchDropReason> = new Map<string, ResearchDropReason>([
  ["SOURCE_LATE", "sourceLate"],
  ["NO_SODEX_PRICE", "noPrice"],
  ["NO_BOOK_DATA", "noPrice"],
  ["NOT_ENOUGH_HISTORY", "noPrice"],
  ["TOO_THIN_TO_TRADE", "tooThin"],
  ["MOVE_TOO_SMALL_FOR_COST", "tpUnderCost"],
  ["NEWS_TRADE_ALREADY_OPEN", "alreadyOpen"],
  ["NEWS_TYPE_OFF", "newsTypeOff"],
  ["LEVEL_TOO_LOW", "levelTooLow"],
  ["LIMIT_OPEN", "limitOpen"],
  ["LIMIT_DAY", "limitDay"],
  ["OPPOSITE_NEWS", "oppositeNews"],
]);

export const funnelReasonOf = (code: string): ResearchDropReason | null =>
  FUNNEL_REASON.get(code) ?? null;

/** Lỗi API của phần Mainnet → câu chữ. `unconfirmed` cho kết quả không rõ (đang đọc lại trạng thái). */
export function useMainnetErrorText() {
  const t = useTranslations("signalAnalysis.research.mainnet.errors");
  const tr = useTranslations("signalAnalysis.research");
  const tc = useTranslations("common.errors");
  const bot = useBotErrorText();
  return (e: unknown): string => {
    if (uncertainOutcome(e) !== null) return tc("unconfirmed");
    if (!(e instanceof ApiError)) return tc("generic");
    const reason = (e.details as { reason?: unknown }).reason;
    if (e.code === ErrorCode.featureNotReady) return tr("mainnetNotReady");
    if (e.code === ErrorCode.botNotFound) return t("botNotFound");
    if (e.code === ErrorCode.notFound) return t("tradeNotFound");
    if (e.code === ErrorCode.stateConflict) {
      if (reason === "command_pending") return t("commandPending");
      if (reason === "trade_not_open") return t("tradeNotOpen");
      if (reason === "leverage_conflict") return t("leverageConflict");
    }
    return bot(e);
  };
}
