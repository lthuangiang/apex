import { useTranslations } from "next-intl";

import { ApiError } from "@/lib/api";

// Lỗi API của các màn bot: lỗi theo field (zod schema của chiến lược) và mã lỗi → câu chữ (C6).

export function fieldErrorsOf(e: unknown): Record<string, string[]> {
  if (!(e instanceof ApiError)) return {};
  const fe = (e.details as { fieldErrors?: Record<string, string[]> }).fieldErrors;
  return fe ?? {};
}

/** Mã lỗi → câu chữ (C6: không hiện message thô của server). */
export function useBotErrorText() {
  const t = useTranslations("createBot.errors");
  const tc = useTranslations("common.errors");
  return (e: unknown) => {
    if (!(e instanceof ApiError)) return tc("generic");
    const messages: Partial<Record<ApiError["code"], string>> = {
      TWO_FACTOR_INVALID: t("twoFactor"),
      TWO_FACTOR_REQUIRED: t("twoFactor"),
      BUILDER_FEE_NOT_APPROVED: t("builderFee"),
      ORDER_BELOW_MIN_SIZE: t("minSize"),
      BOT_STATE_CONFLICT: t("state"),
      VALIDATION_FAILED: Object.hasOwn(e.details, "failed") ? t("checks") : t("invalid"),
      RATE_LIMITED: tc("rateLimited"),
      NETWORK: tc("network"),
    };
    return messages[e.code] ?? tc("generic");
  };
}
