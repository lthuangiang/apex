"use client";

import { useTranslations } from "next-intl";

import { ApiError } from "@/lib/api";

import { useFollowing } from "./api";

// Lỗi API của luồng Copy và Follow (C6: không hiện message thô, nhưng cũng không bao giờ nuốt lỗi).

/** Mã lỗi → câu chữ cho Copy / Follow. */
export function useCopyErrorText() {
  const t = useTranslations("copy.errors");
  const tc = useTranslations("common.errors");
  const following = useFollowing();
  return (e: unknown): string => {
    if (!(e instanceof ApiError)) return tc("generic");
    const reason = typeof e.details.reason === "string" ? e.details.reason : null;
    if (e.code === "STATE_CONFLICT" && reason === "follow_limit")
      return t("followLimit", { limit: following.data?.limit ?? 5 });
    if (e.code === "RATE_LIMITED") return tc("rateLimited");
    if (e.code === "NETWORK") return tc("network");
    return tc("generic");
  };
}

/** Đã theo dõi đủ số trader tối đa (khoá nút Follow cho trader chưa theo dõi). */
export function useFollowLimit(): { atLimit: boolean; limit: number | null } {
  const q = useFollowing();
  if (q.data === undefined) return { atLimit: false, limit: null };
  return { atLimit: q.data.traders.length >= q.data.limit, limit: q.data.limit };
}
