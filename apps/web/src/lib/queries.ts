import {
  builderFeeRateFor,
  featuresSchema,
  meSchema,
  notificationListSchema,
  sodexConnectionSchema,
} from "@drift/shared";
import { useQuery } from "@tanstack/react-query";

import { api } from "./api";

// Query dùng chung cho khung app (UI_REVIEW E1.4): một key cho mỗi tài nguyên, `staleTime` để các component
// con không refetch khi mount. Thao tác đổi dữ liệu vẫn `invalidateQueries` theo key.

export const ME_KEY = ["me"] as const;
export const CONNECTION_KEY = ["sodex", "connection"] as const;
export const NOTIFICATIONS_KEY = ["notifications"] as const;
export const FEATURES_KEY = ["features"] as const;

export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: () => api("GET", "/api/v1/me", meSchema),
    staleTime: 60_000,
  });
}

/**
 * Có phải hỏi mã 2FA trước thao tác cần 2FA không (DEC-115): chỉ khi người dùng đã bật 2FA và phiên này chưa nhập
 * đúng mã trong 2 giờ qua. Server vẫn là nơi quyết định; báo TWO_FACTOR_REQUIRED thì UI hiện ô mã.
 */
export function useTwoFactorNeeded(): boolean {
  const me = useMe();
  if (me.data?.twoFactorEnabled !== true) return false;
  const until = me.data.twoFactorTrustedUntil;
  return until === null || Date.parse(until) <= Date.now();
}

export function useSodexConnection() {
  return useQuery({
    queryKey: CONNECTION_KEY,
    queryFn: () => api("GET", "/api/v1/sodex/connection", sodexConnectionSchema),
    staleTime: 20_000,
    refetchInterval: 30_000,
  });
}

export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: () => api("GET", "/api/v1/notifications", notificationListSchema),
    // Poll 15 s khi tab đang hiện; tab ẩn thì ngừng (docs/NOTIFICATIONS.md mục 7, không SSE ở v1).
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    enabled,
  });
}

/** Tính năng do team bật theo tài khoản: bot khối lượng (DEC-80), AI Desk (DEC-105). */
export function useFeatures() {
  return useQuery({
    queryKey: FEATURES_KEY,
    queryFn: () => api("GET", "/api/v1/features", featuresSchema),
    staleTime: 60_000,
  });
}

/** Builder fee của user cho chiến lược (phần mười bp): mức riêng do team đặt (DEC-159), không thì mặc định. */
export function useBuilderFeeRate(strategy: string): number {
  return builderFeeRateFor(strategy, useFeatures().data?.builderFees);
}
