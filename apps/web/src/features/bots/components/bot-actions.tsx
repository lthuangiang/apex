"use client";

import type { BotSummary } from "@drift/shared";
import { MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { botActions } from "../bot-actions";

export function BotActions({
  bot,
  stretch = false,
}: {
  bot: Pick<BotSummary, "id" | "name" | "state" | "reasonCode">;
  stretch?: boolean;
}) {
  const t = useTranslations("bots");
  const { primary, more } = botActions(bot, t);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const menuId = useId();

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
      <Link
        href={primary.href}
        className={`flex min-h-tap items-center justify-center rounded-[10px] bg-accent-tint px-3 text-[13px] font-bold text-accent-ink no-underline ${stretch ? "flex-1" : ""}`}
      >
        {primary.label}
      </Link>
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
