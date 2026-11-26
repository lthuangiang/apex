"use client";

import {
  botListSchema,
  feeTierChangeText,
  rewardsBoxReceivedDataSchema,
  rewardsClaimableDataSchema,
  rewardsDrawWonDataSchema,
} from "@drift/shared";
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
      case "fee_tier_changed": {
        // Bậc builder fee MM đổi (DEC-261): cùng câu với Telegram, không emoji. Volume làm tròn xuống; thiếu
        // số thì chỉ câu mức mới / cũ. Payload sai dạng → tiêu đề chung của nhóm, không đoán số.
        const x = feeTierChangeText(n.data);
        if (x === null) return { title: t("types.key_fee"), body: null };
        const usdc = (amount: string | null) =>
          amount === null ? "" : t("panel.usdc", { amount });
        const vars = {
          rate: x.vars.rate,
          previous: x.vars.previous,
          volume: usdc(x.vars.volume),
          min: usdc(x.vars.min),
        };
        return {
          title: t(
            x.title === "lowered" ? "panel.titles.feeLowered" : "panel.titles.feeBack",
            vars,
          ),
          body: t(
            x.body === "lowered"
              ? "panel.body.feeLowered"
              : x.body === "raised"
                ? "panel.body.feeRaised"
                : "panel.body.feeRates",
            vars,
          ),
        };
      }
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
      case "team_invariant":
      case "team_incident":
      case "team_incident_digest":
      case "team_sr_new_market":
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
      // SoDEX rewards (#558, câu đã duyệt plan-558 NEW COPY 19–22). Dữ liệu sai dạng thì câu không có số.
      case "rewards_claimable": {
        const d = rewardsClaimableDataSchema.safeParse(n.data);
        return {
          title: d.success
            ? t("panel.rewards.claimable", { n: d.data.count })
            : t("types.rewards_claimable"),
          body: t("panel.rewards.claimableBody"),
        };
      }
      case "rewards_box_received": {
        const d = rewardsBoxReceivedDataSchema.safeParse(n.data);
        if (!d.success) return { title: t("types.rewards_box_received"), body: null };
        const only = d.data.count === 1 ? (d.data.levels[0]?.level ?? null) : null;
        const levels = d.data.levels
          .filter((l) => l.level !== null)
          .map((l) => t("panel.rewards.levelCount", { count: l.count, level: l.level ?? "" }));
        return {
          title:
            only === null
              ? t("panel.rewards.received", { n: d.data.count })
              : t("panel.rewards.receivedLevel", { level: only }),
          body: [
            ...(levels.length === 0 ? [] : [levels.join(", ")]),
            t("panel.rewards.source"),
          ].join(" · "),
        };
      }
      case "rewards_draw_won": {
        const d = rewardsDrawWonDataSchema.safeParse(n.data);
        if (!d.success) return { title: t("types.rewards_draw_won"), body: null };
        const { wins, tickets, round } = d.data;
        return {
          title:
            wins === null || tickets === null
              ? t("types.rewards_draw_won")
              : t("panel.rewards.drawWon", { wins, tickets }),
          body: [
            ...(round === null ? [] : [t("panel.rewards.drawRound", { round })]),
            t("panel.rewards.source"),
          ].join(" · "),
        };
      }
      case "rewards_watch_paused":
        return { title: t("types.rewards_watch_paused"), body: t("panel.rewards.pausedBody") };
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
