"use client";

import { deskBotsViewSchema } from "@drift/shared";
import { Skeleton } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Card } from "@/components/workspace";
import { api } from "@/lib/api";
import { formatDateTime, formatMoney } from "@/lib/format";

import { PaperChip } from "./paper-chip";

// AI Desk › Your bots (DEC-105): nhận xét theo đúng quy tắc của AI Analyst, kèm hành động. "Review draft" chỉ mở
// form sửa bot; không có gì tự sửa bot. "Dismiss" chỉ ẩn trên máy này (localStorage), không đổi gì ở server.

const DISMISSED = "drift.desk.dismissed";

function readDismissed(): string[] {
  try {
    const raw = window.localStorage.getItem(DISMISSED);
    return raw === null ? [] : (JSON.parse(raw) as string[]);
  } catch {
    return [];
  }
}

export function YourBots() {
  const t = useTranslations("desk.bots");
  const td = useTranslations("desk");
  const te = useTranslations("common.errors");
  const q = useQuery({
    queryKey: ["desk", "bots"],
    queryFn: () => api("GET", "/api/v1/desk/bots", deskBotsViewSchema),
    refetchInterval: 60_000,
  });
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    setDismissed(readDismissed());
  }, []);
  const dismiss = (key: string) => {
    const next = [...dismissed, key];
    setDismissed(next);
    try {
      window.localStorage.setItem(DISMISSED, JSON.stringify(next));
    } catch {
      // Không lưu được (chế độ riêng tư): vẫn ẩn trong phiên này.
    }
  };
  if (q.isPending)
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-24 w-full rounded-card" />
        <Skeleton className="h-24 w-full rounded-card" />
      </div>
    );
  if (q.isError)
    return (
      <p role="alert" className="m-0">
        {te("generic")}
      </p>
    );
  const v = q.data;
  const running = v.notes.filter((n) => n.bot.state === "running").length;
  const ideas = v.notes.filter(
    (n) => n.note.kind !== "fine" && !dismissed.includes(`${n.note.kind}:${n.bot.id}`),
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="m-0 text-base font-bold">{t("summary", { running, ideas: ideas.length })}</p>
        <p className="m-0 text-sm text-ink-2">{t("note")}</p>
      </div>
      {v.notes.length === 0 && v.paper.length === 0 ? (
        <Card>
          <p className="m-0 text-sm text-ink-2">{t("empty")}</p>
        </Card>
      ) : null}
      {v.notes.map(({ bot, note }) => {
        const key = `${note.kind}:${bot.id}`;
        if (note.kind !== "fine" && dismissed.includes(key)) return null;
        if (note.kind === "fine")
          return (
            <Card key={bot.id} title={t("fine.title", { name: bot.name })}>
              <p className="m-0 text-sm text-ink-2">{t("fine.text")}</p>
            </Card>
          );
        const fees = note.kind === "fees";
        return (
          <section
            key={bot.id}
            aria-labelledby={`note-${bot.id}`}
            className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id={`note-${bot.id}`} className="m-0 text-lg font-extrabold">
                {t(fees ? "fees.title" : "attention.title", { name: bot.name })}
              </h2>
              <span className="inline-flex h-6 items-center rounded-full bg-warn-bg px-2.5 text-xs font-bold text-warn">
                {t(fees ? "fees.chip" : "attention.chip")}
              </span>
            </div>
            <p className="m-0 text-sm">
              <strong>{t("saw")}</strong>{" "}
              {fees
                ? t("fees.saw", {
                    fills: note.fills,
                    fees: formatMoney(note.fees) ?? "",
                    net: formatMoney(note.net, true) ?? "",
                    quote: note.quote,
                  })
                : note.since === null
                  ? t("attention.sawNoTime")
                  : t("attention.saw", { since: formatDateTime(note.since) })}
            </p>
            <p className="m-0 text-sm">
              <strong>{t("suggest")}</strong> {t(fees ? "fees.suggest" : "attention.suggest")}
            </p>
            <div className="flex flex-wrap gap-2.5">
              <Link
                href={`/bots/${bot.id}/edit`}
                className="flex min-h-tap items-center rounded-control bg-accent px-4 text-sm font-bold text-white no-underline hover:bg-accent-ink"
              >
                {t("review")}
              </Link>
              <button
                type="button"
                onClick={() => {
                  dismiss(key);
                }}
                className="min-h-tap rounded-control border border-border-input bg-surface px-4 text-sm font-bold text-ink hover:bg-surface-2"
              >
                {t("dismiss")}
              </button>
            </div>
          </section>
        );
      })}
      {v.paper.map((p) => (
        <Link
          key={p.bot.id}
          href={`/desk/paper/${p.bot.id}`}
          className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-5 text-ink no-underline hover:bg-surface-2"
        >
          <span className="min-w-0 text-base font-bold tabular-nums">
            {p.net === null
              ? t("paperNoNet", { name: p.bot.name, day: p.day })
              : t("paper", {
                  name: p.bot.name,
                  day: p.day,
                  net: formatMoney(p.net, true) ?? "",
                })}
          </span>
          <PaperChip />
        </Link>
      ))}
      <span className="sr-only">{td("paperChip")}</span>
    </div>
  );
}
