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
      case "team_mcp_tool_errors":
      case "team_mcp_introspect_failing":
      case "team_mcp_daily_limit":
        // Báo team chỉ đi Telegram (DEC-184), không có bản in-app; có ở đây để switch đủ.
        return { title: t(`types.${n.type}`), body: null };
      case "leader_big_move": {
        const coin = str(n.data.coin);
        return { title: t("types.leader_big_move"), body: coin };
      }
      case "leader_position": {
        // Trong app ghi địa chỉ rút gọn của trader (như artboard NT-InApp "0xA3…91 opened a big position").
        const address = str(n.data.address);
        const trader =
          address === null ? t("panel.aTrader") : `${address.slice(0, 6)}…${address.slice(-4)}`;
        const kind = str(n.data.kind);
        const side = n.data.side === "short" ? t("panel.short") : t("panel.long");
        const coin = str(n.data.coin) ?? "";
        const key =
          kind === "close"
            ? "closed"
            : kind === "flip"
              ? "flipped"
              : kind === "liquidated"
                ? "liquidated"
                : "opened";
        return {
          title: t(`panel.leaderPosition.${key}`, { trader, side, coin }),
          body: t("panel.body.followOnly"),
        };
      }
      case "copy_bot_opened": {
        // Bot copy khớp lệnh mở / tăng / đảo chiều (DEC-212). Thiếu số thì bỏ câu có số.
        const market = str(n.data.market);
        const coin = market === null ? "" : (market.split("-")[0] ?? market);
        const move = str(n.data.move);
        const key = move === "added" ? "added" : move === "flipped" ? "flipped" : "opened";
        const side = n.data.side === "short" ? t("panel.short") : t("panel.long");
        const size = str(n.data.size);
        const price = str(n.data.avgEntry);
        return {
          title: t(`panel.copyBot.${key}`, { bot: bot ?? t("panel.copyBot.aBot"), side, coin }),
          body:
            size === null || price === null || market === null
              ? null
              : t("panel.copyBot.filled", { size, coin, price }),
        };
      }
      case "copy_bot_skipped": {
        const market = str(n.data.market);
        const name = bot ?? t("panel.copyBot.aBot");
        const reason = str(n.data.reason);
        return {
          title:
            market === null
              ? t("panel.copyBot.skippedAny", { bot: name })
              : t("panel.copyBot.skipped", { bot: name, coin: market.split("-")[0] ?? market }),
          body:
            reason !== null && t.has(`panel.copySkip.${reason}`)
              ? t(`panel.copySkip.${reason}`)
              : t("panel.copySkip.other"),
        };
      }
    }
  };
}
