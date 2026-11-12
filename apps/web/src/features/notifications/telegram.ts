"use client";

import {
  telegramLinkCreatedSchema,
  telegramLinkStatusSchema,
  type NotificationGroup,
  type TelegramLinkCreated,
  type TelegramLinkStatus,
} from "@drift/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { ApiError, api } from "@/lib/api";

// Kết nối Telegram ở Settings › Notifications (docs/NOTIFICATIONS.md mục 3, artboard NT-Settings / NT-Connect).
// Token chỉ nằm trong bộ nhớ của trang (trong deep link), không ghi vào URL, storage hay log.

export const TELEGRAM_LINK_KEY = ["telegram", "link"] as const;
/** Poll trạng thái mỗi 2 s khi hộp thoại kết nối đang mở (mục 3 bước 6). */
export const TELEGRAM_POLL_MS = 2_000;
/** Hộp thoại đã đóng mà link còn chờ: poll thưa hơn (review PR #33). */
export const TELEGRAM_POLL_CLOSED_MS = 10_000;

/**
 * Trạng thái kết nối. `disabled`: server tắt Telegram (`TELEGRAM_ENABLED=false` → 404), UI hiện "Coming soon".
 * Poll 2 s khi hộp thoại mở; 10 s khi hộp thoại đã đóng mà server còn link đang chờ (người dùng vẫn có thể bấm
 * Start), để thẻ tự chuyển sang Connected.
 */
export function useTelegramLink(dialogOpen: boolean) {
  return useQuery({
    queryKey: TELEGRAM_LINK_KEY,
    queryFn: async (): Promise<TelegramLinkStatus | { status: "disabled" }> => {
      try {
        return await api("GET", "/api/v1/telegram/link", telegramLinkStatusSchema);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return { status: "disabled" };
        throw error;
      }
    },
    refetchInterval: (q) =>
      dialogOpen
        ? TELEGRAM_POLL_MS
        : q.state.data?.status === "pending"
          ? TELEGRAM_POLL_CLOSED_MS
          : false,
    staleTime: 5_000,
  });
}

/**
 * Deep link tạo trong phiên này: chỉ giữ trong cache bộ nhớ của React Query (không localStorage, không URL), để
 * "Show link again" mở lại đúng link sau khi đóng hộp thoại hoặc chuyển tab. Tải lại trang thì mất.
 */
export const TELEGRAM_CREATED_KEY = ["telegram", "created"] as const;

export function useCreatedTelegramLink(): TelegramLinkCreated | null {
  return (
    useQuery({
      queryKey: TELEGRAM_CREATED_KEY,
      queryFn: () => null as TelegramLinkCreated | null,
      enabled: false,
      staleTime: Infinity,
      // Link sống 10 phút; giữ quá hạn đó một chút rồi bỏ.
      gcTime: 15 * 60_000,
    }).data ?? null
  );
}

export function useCreateTelegramLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api("POST", "/api/v1/telegram/link", telegramLinkCreatedSchema, {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: async (created) => {
      qc.setQueryData(TELEGRAM_CREATED_KEY, created);
      await qc.invalidateQueries({ queryKey: TELEGRAM_LINK_KEY });
    },
  });
}

/** Ngắt kết nối, hoặc huỷ link đang chờ (server xoá cả token chưa dùng). */
export function useDeleteTelegramLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api("DELETE", "/api/v1/telegram/link", z.unknown(), {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: TELEGRAM_LINK_KEY });
    },
  });
}

/** "9:41" từ số ms còn lại; âm thì "0:00". */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, "0")}`;
}

/** "mai•••@gmail.com" (artboard NT-Settings): giữ tối đa 3 ký tự đầu của phần trước @. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${email.slice(0, Math.min(3, at))}•••${email.slice(at)}`;
}

/** Thứ tự nhóm trong bảng "What we tell you" và danh sách "You'll get on Telegram" (artboard NT-Settings). */
export const SETTINGS_GROUP_ORDER: readonly NotificationGroup[] = [
  "botErrors",
  "risk",
  "keyFee",
  "daily",
  "fills",
  "copyTrading",
  // Chỉ role team thấy (API chỉ trả nhóm này cho team, DEC-184).
  "teamOps",
];

/** Nhóm đang bật Telegram, theo thứ tự hiển thị; Copy Trading chỉ khi có AI Desk (DEC-163). */
export function telegramGroupsOn(
  groups: readonly { group: NotificationGroup; telegram: boolean }[],
  aiDesk: boolean,
): NotificationGroup[] {
  return SETTINGS_GROUP_ORDER.filter(
    (g) => (aiDesk || g !== "copyTrading") && groups.find((x) => x.group === g)?.telegram === true,
  );
}

/**
 * Tin thử (NOTIFICATIONS.md mục 9): POST /api/v1/telegram/test, mỗi lần bấm một Idempotency-Key mới. Server giới
 * hạn 3 lần mỗi giờ (RATE_LIMITED); chưa kết nối hoặc bị chặn → TELEGRAM_NOT_CONNECTED (làm mới trạng thái thẻ).
 */
export function useSendTelegramTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api("POST", "/api/v1/telegram/test", z.unknown(), {
        idempotencyKey: crypto.randomUUID(),
      }),
    onError: async (error) => {
      if (error instanceof ApiError && error.code === "TELEGRAM_NOT_CONNECTED")
        await qc.invalidateQueries({ queryKey: TELEGRAM_LINK_KEY });
    },
  });
}

/** Khoá câu chữ cho kết quả của tin thử. */
export function testErrorKey(error: unknown): "rateLimited" | "notConnected" | "generic" {
  if (error instanceof ApiError) {
    if (error.code === "RATE_LIMITED") return "rateLimited";
    if (error.code === "TELEGRAM_NOT_CONNECTED") return "notConnected";
  }
  return "generic";
}
