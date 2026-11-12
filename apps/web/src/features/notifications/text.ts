"use client";

import { botListSchema } from "@drift/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { api } from "@/lib/api";

import type { NotificationItem } from "./model";

// Câu chữ một dòng thông báo: tiêu đề + 1 câu (artboard NT-InApp). Tên bot lấy từ danh sách bot của
// người dùng (cùng query với thẻ Emergency); không tìm thấy thì dùng nhãn chung, không đoán tên.

export interface NotificationText {
  title: string;
  body: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function useBotNames(): (id: unknown) => string | null {
  // Gồm cả bot đã archive: tin cũ thường thuộc bot đã dừng rồi archive, danh sách mặc định không có
  // (review PR #24). Key riêng để không đổi dữ liệu của query ["bots"] dùng ở chỗ khác.
  const bots = useQuery({
    queryKey: ["bots", "withArchived"],
    queryFn: () => api("GET", "/api/v1/bots?archived=true", botListSchema),
    staleTime: 60_000,
  });
  return (id) => {
    const botId = str(id);
    if (botId === null) return null;
    return bots.data?.items.find((b) => b.id === botId)?.name ?? null;
  };
}

export function useNotificationText(): (n: NotificationItem) => NotificationText {
  const t = useTranslations("notifications");
  const botName = useBotNames();
  return (n) => {
    const bot = botName(n.data.botId);
    const code = str(n.data.reasonCode);
    const reason = code !== null && t.has(`reasonText.${code}`) ? t(`reasonText.${code}`) : null;
    const paper = n.data.paper === true;
    switch (n.type) {
      case "bot_paused":
      case "bot_stopped": {
        const verb = n.type === "bot_paused" ? "paused" : "stopped";
        // Bài thử tiền giả (DEC-105) luôn ghi "fake-money test".
        const title =
          bot === null
            ? t(paper ? `paperTypes.${n.type}` : `types.${n.type}`)
            : t(paper ? `panel.titles.paper_${verb}` : `panel.titles.${verb}`, { bot });
        const body = paper
          ? t("panel.body.paper")
          : n.type === "bot_paused"
            ? reason === null
              ? t("panel.body.keptOrders")
              : t("panel.body.pausedReason", { reason })
            : reason === null
              ? null
              : t("panel.body.stoppedReason", { reason });
        return { title, body };
      }
      case "unknown_order":
        return {
          title: bot === null ? t("types.unknown_order") : t("panel.titles.unknown", { bot }),
          body: t("panel.body.unknown"),
        };
      case "risk_alert":
        return { title: t("types.risk_alert"), body: t("panel.body.risk") };
      case "key_fee":
        return { title: t("types.key_fee"), body: t("panel.body.keyFee") };
      case "fill":
        return {
          title: bot === null ? t("types.fill") : t("panel.titles.fill", { bot }),
          body: null,
        };
      case "daily_summary":
        return { title: t("types.daily_summary"), body: null };
      case "telegram_connected": {
        const username = str(n.data.username);
        return {
          title: t("types.telegram_connected"),
          body: username === null ? null : t("panel.body.telegramConnected", { username }),
        };
      }
      case "telegram_moved":
        return { title: t("types.telegram_moved"), body: t("panel.body.telegramMoved") };
      case "telegram_blocked":
        return { title: t("types.telegram_blocked"), body: t("panel.body.telegramBlocked") };
      case "team_signup":
      case "team_sodex_connected":
      case "team_bot_started":
        // Báo team chỉ đi Telegram (DEC-184), không có bản in-app; có ở đây để switch đủ.
        return { title: t(`types.${n.type}`), body: null };
      case "leader_big_move": {
        const coin = str(n.data.coin);
        return { title: t("types.leader_big_move"), body: coin };
      }
    }
  };
}
