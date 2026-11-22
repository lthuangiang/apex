"use client";

import type { BotSummary } from "@drift/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Square } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { useSodexConnection } from "@/lib/queries";

import { signalResearchBotHref } from "../research/mode-memory";

import { useNewsBotAction, useNewsTrades } from "./api";
import { BotSettingsBody } from "./bot-settings";
import { StopNewsBotDialog } from "./dialogs";
import { useMainnetErrorText } from "./text";

// Phần riêng của bot `news_signal` trên trang Trading Agent (#470). Trang này chưa có nhánh cho bot news: khối
// Configuration dùng lại nội dung Settings chỉ xem của Signal Research (#469 phần 1) và link "Open in Signal Research"
// thay cho "Edit bot" (Strategy Lab không có form cho bot news); Stop dùng đúng hộp Keep open trades / Close all now của
// Signal Research (#445), không dùng hộp chung.

/** Nội dung khối Configuration của bot news: cấu hình đang chạy (chỉ xem) và link sang Signal Research. */
export function NewsConfigBody({ botId }: { botId: string }) {
  const t = useTranslations("signalAnalysis.research.mainnet.agent");
  const tm = useTranslations("signalAnalysis.research.mainnet");
  const conn = useSodexConnection();
  const c = conn.data?.connection;
  const last4 = c?.status === "connected" && c.apiKey !== null ? c.apiKey.last4 : null;
  return (
    <>
      <BotSettingsBody
        botId={botId}
        account={last4 === null ? null : tm("strip.account", { last4 })}
      />
      <Link
        href={signalResearchBotHref(botId)}
        className="flex min-h-tap items-center justify-center rounded-control bg-accent-tint text-sm font-bold text-accent-ink no-underline"
      >
        {t("open")}
      </Link>
    </>
  );
}

/**
 * Khối "Stop this bot" của bot news: câu lấy từ hộp Stop của Signal Research, bấm mở `StopNewsBotDialog`. Stop gửi
 * `closePosition` theo lựa chọn; trạng thái lấy lại từ backend (trang agent và danh sách bot news).
 */
export function NewsStopBlock({ bot, title }: { bot: BotSummary; title: string }) {
  const t = useTranslations("signalAnalysis.research.mainnet");
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const trades = useNewsTrades(bot.id);
  const errorText = useMainnetErrorText();
  const act = useNewsBotAction(() => {
    setOpen(false);
    void qc.invalidateQueries({ queryKey: ["bot", bot.id] });
  });
  const openCount =
    trades.data === undefined
      ? null
      : trades.data.items.filter((x) => x.status !== "closed").length;
  return (
    <section
      aria-labelledby="stop-title"
      className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-neg-border bg-neg-soft p-5"
    >
      <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
        <h2 id="stop-title" className="m-0 text-lg font-extrabold text-neg-text">
          {title}
        </h2>
        <p className="m-0 text-sm text-neg-text">{t("dialogs.stop.body")}</p>
      </div>
      <div className="flex w-full flex-col gap-2 lg:w-auto">
        <button
          type="button"
          className="flex min-h-[52px] items-center justify-center gap-2 rounded-[16px] border-[1.5px] border-neg bg-surface px-5 text-[15px] font-extrabold text-neg-ink"
          onClick={() => {
            act.reset();
            setOpen(true);
          }}
        >
          <Square aria-hidden="true" size={16} />
          {t("strip.stop")}
        </button>
      </div>
      {open ? (
        <StopNewsBotDialog
          bot={bot}
          openTrades={openCount}
          pending={act.isPending}
          error={act.error === null ? null : errorText(act.error)}
          onClose={() => {
            setOpen(false);
          }}
          onConfirm={(closeAll) => {
            act.mutate({ id: bot.id, action: "stop", body: { closePosition: closeAll } });
          }}
        />
      ) : null}
    </section>
  );
}
