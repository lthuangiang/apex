"use client";

import { BotState, botSummarySchema, Strategy, type BotSummary } from "@drift/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { useNewsTrades } from "@/features/signal-analysis/mainnet/api";
import { api } from "@/lib/api";
import { useSodexConnection } from "@/lib/queries";

import { botActions } from "../bot-actions";

import { useBotErrorText } from "./bot-errors";

const BOTS_QUERY = ["bots"] as const;

export function BotActions({
  bot,
  stretch = false,
}: {
  bot: Pick<BotSummary, "id" | "name" | "state" | "reasonCode"> &
    Partial<Pick<BotSummary, "strategy">>;
  stretch?: boolean;
}) {
  const t = useTranslations("bots");
  const connection = useSodexConnection();
  const keyStatus = connection.data?.connection?.apiKey?.status ?? null;
  const { primary, more } = botActions(bot, t, keyStatus);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const menuId = useId();
  const qc = useQueryClient();
  const router = useRouter();
  // Archive ngay ở danh sách để dọn nhanh; bot archived thì khôi phục rồi mở Trading Agent để Start again (DEC-88).
  const archive = useMutation({
    mutationFn: (action: "archive" | "unarchive") =>
      api("POST", `/api/v1/bots/${bot.id}/actions/${action}`, botSummarySchema, {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: async (_r, action) => {
      await qc.invalidateQueries({ queryKey: BOTS_QUERY });
      if (action === "unarchive") router.push(`/agent/${bot.id}`);
    },
  });
  const errorText = useBotErrorText();
  const tc = useTranslations("createBot.errors");
  // #471: bot news còn lệnh mở thì không archive được (API 409 `open_trades`): khoá nút và nói rõ lý do. Chỉ hỏi lệnh của
  // bot news đã dừng.
  const newsStopped = bot.strategy === Strategy.newsSignal && bot.state === BotState.stopped;
  const trades = useNewsTrades(newsStopped ? bot.id : null);
  const openTrades =
    trades.data === undefined ? 0 : trades.data.items.filter((x) => x.status !== "closed").length;
  const locked = newsStopped && openTrades > 0;
  const lockId = useId();
  const inlineClass = `flex min-h-tap items-center justify-center rounded-[10px] px-3 text-[13px] font-bold ${stretch ? "flex-1" : ""}`;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={ref} className={`relative flex flex-wrap gap-1.5 ${stretch ? "" : "justify-end"}`}>
      {bot.state === BotState.archived ? (
        <>
          {/* Bot archived xem được ở chế độ chỉ đọc (BD-01, DEC-263). */}
          <Link
            href={primary.href}
            className={`${inlineClass} border border-border-input text-ink no-underline`}
          >
            {primary.label}
          </Link>
          <button
            type="button"
            disabled={archive.isPending}
            aria-label={t("restoreLabel", { name: bot.name })}
            className={`${inlineClass} bg-accent-tint text-accent-ink`}
            onClick={() => {
              archive.mutate("unarchive");
            }}
          >
            {t("restore")}
          </button>
        </>
      ) : (
        <Link
          href={primary.href}
          className={`${inlineClass} bg-accent-tint text-accent-ink no-underline`}
        >
          {primary.label}
        </Link>
      )}
      {bot.state === BotState.stopped ? (
        <button
          type="button"
          disabled={archive.isPending || locked}
          aria-label={t("archiveLabel", { name: bot.name })}
          {...(locked ? { "aria-describedby": lockId } : {})}
          className={`${inlineClass} border border-border-input text-ink disabled:cursor-not-allowed disabled:opacity-60`}
          onClick={() => {
            archive.mutate("archive");
          }}
        >
          {t("archive")}
        </button>
      ) : null}
      {locked ? (
        <span id={lockId} className="basis-full text-right text-xs text-muted">
          {tc("archiveOpenTrades")}
        </span>
      ) : archive.error === null ? null : (
        <span role="alert" className="basis-full text-right text-xs text-neg-ink">
          {errorText(archive.error)}
        </span>
      )}
      {more.length > 0 ? (
        <>
          <button
            type="button"
            aria-label={t("moreActions", { name: bot.name })}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => {
              setOpen((v) => !v);
            }}
            className="flex min-h-tap min-w-tap items-center justify-center rounded-[10px] border border-border-input text-ink"
          >
            <MoreHorizontal aria-hidden="true" size={18} />
          </button>
          {open ? (
            <div
              id={menuId}
              role="menu"
              className="absolute top-full right-0 z-20 mt-1 flex min-w-40 flex-col rounded-[12px] border border-border bg-surface p-1 shadow-lg"
            >
              {more.map((a) => (
                <Link
                  key={a.href}
                  role="menuitem"
                  href={a.href}
                  className="flex min-h-tap items-center rounded-[8px] px-3 text-sm font-semibold text-ink no-underline hover:bg-surface-2"
                  onClick={() => {
                    setOpen(false);
                  }}
                >
                  {a.label}
                </Link>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </span>
  );
}
