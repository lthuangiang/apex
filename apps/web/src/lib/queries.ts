import { meSchema, notificationListSchema, sodexConnectionSchema } from "@drift/shared";
import { useQuery } from "@tanstack/react-query";

import { api } from "./api";

// Query dùng chung cho khung app (UI_REVIEW E1.4): một key cho mỗi tài nguyên, `staleTime` để các component
// con không refetch khi mount. Thao tác đổi dữ liệu vẫn `invalidateQueries` theo key.

export const ME_KEY = ["me"] as const;
export const CONNECTION_KEY = ["sodex", "connection"] as const;
export const NOTIFICATIONS_KEY = ["notifications"] as const;

export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: () => api("GET", "/api/v1/me", meSchema),
    staleTime: 60_000,
  });
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
    staleTime: 30_000,
    refetchInterval: 60_000,
    enabled,
  });
}
