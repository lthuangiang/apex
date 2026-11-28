import { useTranslations } from "next-intl";

import { ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/format";

import { friendlyFieldErrors } from "../field-errors";

// Lỗi API của các màn bot: lỗi theo field (zod schema của chiến lược) và mã lỗi → câu chữ (C6).

/**
 * Lỗi theo field từ server. Câu do spec chiến lược định nghĩa (STRATEGIES.md) giữ nguyên; câu mặc định của
 * zod (thường do ô trống hoặc sai kiểu) đổi thành `fallback` (C6: không hiện message thô).
 */
export function fieldErrorsOf(e: unknown, fallback?: string): Record<string, string[]> {
  if (!(e instanceof ApiError)) return {};
  const fe = (e.details as { fieldErrors?: Record<string, string[]> }).fieldErrors ?? {};
  return fallback === undefined ? fe : friendlyFieldErrors(fe, fallback);
}

/** Mã lỗi → câu chữ (C6: không hiện message thô của server). */
export function useBotErrorText() {
  const t = useTranslations("createBot.errors");
  const tc = useTranslations("common.errors");
  return (e: unknown) => {
    if (!(e instanceof ApiError)) return tc("generic");
    // #471: archive bot news còn lệnh mở (API 409 `open_trades`): câu riêng, không phải lỗi chung.
    if (e.code === "STATE_CONFLICT" && (e.details as { reason?: unknown }).reason === "open_trades")
      return t("archiveOpenTrades");
    // DEC-402 mục 5 (#590): server kiểm độ sâu sổ lệnh khi tạo / sửa. Câu chữ theo câu của server, dựng từ `details`
    // (C6: không hiện message thô).
    const d = e.details as { reason?: unknown; market?: unknown; maxPosition?: unknown };
    if (e.code === "VALIDATION_FAILED" && d.reason === "order_book_depth") {
      const market = typeof d.market === "string" ? d.market : "";
      return typeof d.maxPosition === "string"
        ? t("depthTooLarge", { market, limit: formatMoney(d.maxPosition) ?? d.maxPosition })
        : t("depthEmpty", { market });
    }
    const messages: Partial<Record<ApiError["code"], string>> = {
      TWO_FACTOR_INVALID: t("twoFactor"),
      TWO_FACTOR_REQUIRED: t("twoFactor"),
      BUILDER_FEE_NOT_APPROVED: t("builderFee"),
      ORDER_BELOW_MIN_SIZE: t("minSize"),
      // Team đã tắt chiến lược cho tài khoản (DEC-218, DEC-80): Start / Resume bị từ chối.
      BOT_STATE_CONFLICT:
        (e.details as { reason?: unknown }).reason === "strategy_off"
          ? t("strategyOff")
          : t("state"),
      VALIDATION_FAILED: Object.hasOwn(e.details, "failed") ? t("checks") : t("invalid"),
      RATE_LIMITED: tc("rateLimited"),
      NETWORK: tc("network"),
    };
    return messages[e.code] ?? tc("generic");
  };
}
