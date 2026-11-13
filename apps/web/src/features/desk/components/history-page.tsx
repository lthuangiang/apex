"use client";

import {
  deskAiHistoryViewSchema,
  deskRecordViewSchema,
  type DeskAiHistoryView,
} from "@drift/shared";
import { Button, ConfirmDialog, EmptyState, ErrorState, Skeleton } from "@drift/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { z } from "zod";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

import { leverageChange } from "../bplus";

import { Answer } from "./desk-ai";

// Desk AI › History (artboard B-History, DEC-165c): lượt hỏi hôm nay / 20, các cuộc trò chuyện 90 ngày, "What changed"
// (chỉ những gì user bấm: Apply từ đề xuất, có Switch back ở trang Thành tích), và "Delete history".

type Conversation = DeskAiHistoryView["conversations"][number];

function ConversationItem({ c }: { c: Conversation }) {
  const t = useTranslations("desk.ai.historyPage");
  const [open, setOpen] = useState(false);
  const id = useId();
  const title = c.kind === "brief" ? t("brief") : c.title;
  return (
    <li className="border-t border-border first:border-t-0">
      {/* Cả dòng là nút 44 px có mũi tên, để thấy là bấm được (PM chốt, DEC-TBD-history-open). */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen((x) => !x);
        }}
        className="-mx-2 flex min-h-tap w-[calc(100%+1rem)] items-center gap-2 rounded-control px-2 text-left text-sm hover:bg-surface-2"
      >
        <ChevronRight
          aria-hidden="true"
          size={16}
          className={`flex-none text-ink-2 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0 flex-1 truncate font-bold">{title}</span>
        <span className="flex-none text-xs text-ink-2">{formatDateTime(c.createdAt)}</span>
      </button>
      {open ? (
        // Giống panel Desk AI: câu hỏi bong bóng phải nền accent, câu trả lời dùng lại Answer, có giờ từng lượt.
        <ul id={id} className="m-0 flex list-none flex-col gap-4 p-0 pt-2 pb-4">
          {c.turns.map((x) => (
            <li key={x.id} className="flex flex-col gap-2">
              <time dateTime={x.createdAt} className="self-center text-xs text-muted">
                {formatDateTime(x.createdAt)}
              </time>
              {x.question === null ? null : (
                <p className="m-0 max-w-[85%] self-end rounded-[16px_16px_4px_16px] bg-accent px-3.5 py-2 text-sm text-white">
                  {x.question}
                </p>
              )}
              <Answer answer={x.answer} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Changes() {
  const t = useTranslations("desk.ai.historyPage");
  const tr = useTranslations("desk.record");
  const q = useQuery({
    queryKey: ["desk", "record"],
    queryFn: () => api("GET", "/api/v1/desk/record", deskRecordViewSchema),
  });
  const rows = q.data?.rows ?? [];
  if (rows.length === 0) return null;
  return (
    <Card title={t("changed")}>
      <ul className="m-0 flex list-none flex-col p-0">
        {rows.map((r) => {
          const c = leverageChange(r);
          const change =
            r.option === "lower_leverage"
              ? c === null
                ? null
                : tr("change.lower_leverage", c)
              : tr(`change.${r.option}`);
          return (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-2 first:border-t-0"
            >
              <span className="flex min-w-0 flex-col">
                <span className="text-xs font-bold text-ink-2">{t("youApplied")}</span>
                <span className="text-sm font-bold">
                  {change === null ? r.botName : tr("what", { bot: r.botName, change })}
                </span>
                <span className="text-xs text-ink-2">
                  {formatDateTime(r.appliedAt)} · {t("fromDesk")}
                </span>
              </span>
              {r.canSwitchBack ? (
                <Link href="/desk/record" className="text-sm font-bold text-accent-ink">
                  {t("switchBack")}
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function HistoryPage() {
  const t = useTranslations("desk.ai.historyPage");
  const te = useTranslations("common.errors");
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["desk", "ai", "history"],
    queryFn: () => api("GET", "/api/v1/desk/ai/history", deskAiHistoryViewSchema),
  });
  const [confirm, setConfirm] = useState(false);
  const key = useRef(crypto.randomUUID());
  const del = useMutation({
    mutationFn: () =>
      api("DELETE", "/api/v1/desk/ai/history", z.object({ deleted: z.number() }), {
        idempotencyKey: key.current,
      }),
    onSuccess: async () => {
      key.current = crypto.randomUUID();
      setConfirm(false);
      await qc.invalidateQueries({ queryKey: ["desk", "ai"] });
    },
  });
  const v = q.data;
  const today = v?.conversations[0]?.localDate;
  const groups =
    v === undefined
      ? []
      : ([
          ["today", v.conversations.filter((c) => c.localDate === today && c.turns.length > 0)],
          ["earlier", v.conversations.filter((c) => c.localDate !== today && c.turns.length > 0)],
        ] as const);

  return (
    <Workspace current="desk">
      <div className="flex flex-col gap-5">
        <Link
          href="/desk"
          className="hidden self-start text-sm font-bold text-accent-ink lg:inline"
        >
          ← {t("back")}
        </Link>
        <PageHead
          title={t("title")}
          subtitle={
            v === undefined ? "" : t("questionsToday", { used: v.questionsToday, limit: v.limit })
          }
          back={{ href: "/desk", label: t("back") }}
        />
        {q.isPending ? (
          <Skeleton className="h-48 w-full rounded-card" />
        ) : q.isError || v === undefined ? (
          <ErrorState
            title={t("error")}
            retryLabel={te("retry")}
            onRetry={() => void q.refetch()}
          />
        ) : (
          <>
            <p className="m-0 text-sm text-ink-2 lg:hidden">
              {t("questionsToday", { used: v.questionsToday, limit: v.limit })}
            </p>
            <Card title={t("conversations")}>
              {groups.every(([, cs]) => cs.length === 0) ? (
                <EmptyState title={t("empty")} />
              ) : (
                groups.map(([k, cs]) =>
                  cs.length === 0 ? null : (
                    <div key={k} className="flex flex-col gap-1">
                      <h3 className="m-0 text-xs font-extrabold text-ink-2 uppercase">{t(k)}</h3>
                      <ul className="m-0 flex list-none flex-col p-0">
                        {cs.map((c) => (
                          <ConversationItem key={c.id} c={c} />
                        ))}
                      </ul>
                    </div>
                  ),
                )
              )}
            </Card>
            <Changes />
            <p className="m-0 text-xs text-muted">{t("footer")}</p>
            <div>
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirm(true);
                }}
              >
                {t("delete")}
              </Button>
            </div>
            <ConfirmDialog
              open={confirm}
              onOpenChange={setConfirm}
              title={t("deleteTitle")}
              consequencesLabel={t("deleteWhat")}
              consequences={[t("deleteBody")]}
              confirmLabel={t("deleteConfirm")}
              cancelLabel={t("cancel")}
              tone="danger"
              pending={del.isPending}
              {...(del.isError ? { error: t("deleteError") } : {})}
              onConfirm={() => {
                del.mutate();
              }}
            />
          </>
        )}
      </div>
    </Workspace>
  );
}
