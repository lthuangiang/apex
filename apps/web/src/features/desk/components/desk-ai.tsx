"use client";

import {
  deskAiAskViewSchema,
  deskAiBriefViewSchema,
  type DeskAiAnswer,
  type DeskAiAskView,
} from "@drift/shared";
import { Button, Skeleton } from "@drift/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";

import { api } from "@/lib/api";
import { formatMoney } from "@/lib/format";

import { plainNumber, plainUsd } from "../bplus";

// Desk AI panel (artboard BP-Home, B-Answer, DEC-164/165): báo cáo sáng + hỏi đáp. Lời LLM đã qua kiểm tra số ở server;
// câu mẫu (LLM tắt / hết lượt / ngoài phạm vi / số không khớp) dịch ở đây từ `key` + fact. Desk AI chỉ đọc: không có
// nút nào ở đây đổi bot. "Start a bot for me" mở luồng Recommended (tạo bot qua chat ở PR sau).

type Fact = DeskAiAnswer["facts"][number];
type Turn = DeskAiAskView["turn"];

function useFactText() {
  const t = useTranslations("desk.ai.facts");
  const ts = useTranslations("states");
  return (f: Fact) => {
    const label = t(f.key, { bot: f.bot ?? "" });
    let value: string;
    if (f.unit === "usdc")
      value = `${f.key === "bot_net" ? (formatMoney(f.value, true) ?? f.value) : plainUsd(f.value)} USDC`;
    else if (f.unit === "pct") value = `${plainNumber(f.value)}%`;
    else if (f.unit === "x") value = `${plainNumber(f.value)}×`;
    else if (f.key === "bot_state") value = ts.has(f.value) ? ts(f.value as "running") : f.value;
    else value = f.value;
    return { label, value };
  };
}

export function Answer({ answer }: { answer: DeskAiAnswer }) {
  const t = useTranslations("desk.ai.templates");
  const factText = useFactText();
  if (answer.kind === "text")
    return <p className="m-0 text-sm whitespace-pre-line text-ink">{answer.text}</p>;
  const valueOf = (key: Fact["key"]) => answer.facts.find((f) => f.key === key)?.value ?? null;
  let lead: string;
  if (answer.key === "safety") {
    const [limit, used] = [valueOf("goal_limit"), valueOf("goal_used")];
    lead =
      limit === null
        ? t("safetyPlain")
        : used === null
          ? t("safetyLimit", { limit: plainUsd(limit) })
          : t("safety", { limit: plainUsd(limit), used: plainUsd(used) });
  } else if (answer.key === "brief")
    lead = t("brief", {
      count: Number(answer.params.count ?? 0),
      bot: String(answer.params.bot ?? ""),
    });
  else if (answer.key === "quota") lead = t("quota", { limit: Number(answer.params.limit ?? 0) });
  else lead = t(answer.key);
  const list = answer.key === "fallback" || answer.key === "quota" ? answer.facts : [];
  return (
    <div className="flex flex-col gap-2 text-sm text-ink">
      <p className="m-0">{lead}</p>
      {list.length === 0 ? null : (
        <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
          {list
            .filter((f) => f.key !== "questions_left")
            .map((f) => {
              const x = factText(f);
              return (
                <div key={f.id} className="contents">
                  <dt className="text-ink-2">{x.label}</dt>
                  <dd className="m-0 text-right font-semibold tabular-nums">{x.value}</dd>
                </div>
              );
            })}
        </dl>
      )}
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  return (
    <li className="flex flex-col gap-2">
      {turn.question === null ? null : (
        <p className="m-0 self-end rounded-[14px] bg-ink px-3 py-2 text-sm text-white">
          {turn.question}
        </p>
      )}
      <div className="flex gap-2">
        <span aria-hidden="true" className="text-accent-ink">
          ✦
        </span>
        <Answer answer={turn.answer} />
      </div>
    </li>
  );
}

export function DeskAiPanel() {
  const t = useTranslations("desk.ai");
  const inputId = useId();
  const brief = useQuery({
    queryKey: ["desk", "ai", "brief"],
    queryFn: () => api("GET", "/api/v1/desk/ai/brief", deskAiBriefViewSchema),
  });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [left, setLeft] = useState<number | null>(null);
  const [text, setText] = useState("");
  const key = useRef(crypto.randomUUID());
  const ask = useMutation({
    mutationFn: (question: string) =>
      api("POST", "/api/v1/desk/ai/ask", deskAiAskViewSchema, {
        idempotencyKey: key.current,
        body: conversationId === undefined ? { question } : { question, conversationId },
      }),
    onSuccess: (r) => {
      key.current = crypto.randomUUID();
      setTurns((xs) => [...xs, r.turn]);
      setConversationId(r.conversationId);
      setLeft(r.questionsLeft);
      setText("");
    },
  });
  const send = (q: string) => {
    const question = q.trim();
    if (question === "" || ask.isPending) return;
    ask.mutate(question);
  };
  const questionsLeft = left ?? brief.data?.questionsLeft ?? null;

  return (
    <section
      aria-label={t("title")}
      className="flex flex-col gap-4 rounded-card border border-border bg-surface p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 flex items-center gap-2 text-lg font-extrabold">
          <span aria-hidden="true" className="text-accent-ink">
            ✦
          </span>
          {t("title")}
        </h2>
        <Link href="/desk/history" className="text-sm font-bold text-accent-ink">
          {t("history")}
        </Link>
      </div>
      {brief.isPending ? (
        <Skeleton className="h-12 w-full rounded-[12px]" />
      ) : brief.data?.turn != null ? (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          <TurnView turn={brief.data.turn} />
        </ul>
      ) : brief.data?.available === false ? (
        <p className="m-0 text-sm text-ink-2">{t("briefLater")}</p>
      ) : null}
      {turns.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-live="polite">
          {turns.map((x) => (
            <TurnView key={x.id} turn={x} />
          ))}
        </ul>
      )}
      {ask.isPending ? (
        <p className="m-0 text-sm text-ink-2" aria-live="polite">
          {t("thinking")}
        </p>
      ) : null}
      {ask.isError ? (
        <p role="alert" className="m-0 text-sm text-neg-ink">
          {t("error")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {(["safe", "lose"] as const).map((k) => (
          <button
            key={k}
            type="button"
            disabled={ask.isPending}
            onClick={() => {
              send(t(`chips.${k}`));
            }}
            className="inline-flex min-h-9 items-center rounded-full border border-border bg-surface px-3 text-sm font-semibold text-ink hover:bg-surface-2 disabled:opacity-60"
          >
            {t(`chips.${k}`)}
          </button>
        ))}
        <Link
          href="/desk/new"
          className="inline-flex min-h-9 items-center rounded-full border border-border bg-surface px-3 text-sm font-semibold text-ink hover:bg-surface-2"
        >
          {t("chips.start")}
        </Link>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
        className="flex gap-2"
      >
        <label htmlFor={inputId} className="sr-only">
          {t("placeholder")}
        </label>
        <input
          id={inputId}
          value={text}
          maxLength={500}
          onChange={(e) => {
            setText(e.target.value);
          }}
          placeholder={t("placeholder")}
          className="min-h-tap min-w-0 flex-1 rounded-[12px] border border-border-input bg-surface px-3 text-sm"
        />
        <Button type="submit" pending={ask.isPending} disabled={text.trim() === ""}>
          {t("send")}
        </Button>
      </form>
      <p className="m-0 flex flex-wrap justify-between gap-2 text-xs text-muted">
        <span>{t("notAdvice")}</span>
        {questionsLeft === null ? null : <span>{t("questionsLeft", { n: questionsLeft })}</span>}
      </p>
    </section>
  );
}
