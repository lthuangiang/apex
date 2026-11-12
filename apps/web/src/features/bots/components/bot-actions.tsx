"use client";

import { BotState, botSummarySchema, type BotSummary } from "@drift/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { api } from "@/lib/api";
import { useSodexConnection } from "@/lib/queries";

import { botActions } from "../bot-actions";

const BOTS_QUERY = ["bots"] as const;

export function BotActions({
  bot,
  stretch = false,
}: {
  bot: Pick<BotSummary, "id" | "name" | "state" | "reasonCode">;
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
    <span ref={ref} className={`relative flex gap-1.5 ${stretch ? "" : "justify-end"}`}>
      {bot.state === BotState.archived ? (
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
          disabled={archive.isPending}
          aria-label={t("archiveLabel", { name: bot.name })}
          className={`${inlineClass} border border-border-input text-ink`}
          onClick={() => {
            archive.mutate("archive");
          }}
        >
          {t("archive")}
        </button>
      ) : null}
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
