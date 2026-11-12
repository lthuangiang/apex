"use client";

import {
  deskAiAskViewSchema,
  deskAiBriefViewSchema,
  type DeskAiAnswer,
  type DeskAiAskView,
} from "@drift/shared";
import { Skeleton } from "@drift/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUp } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";

import { api } from "@/lib/api";
import { formatMoney } from "@/lib/format";

import { plainNumber, plainUsd } from "../bplus";

import { AiMark } from "./goal-card";
import { NewBotChat } from "./new-bot-chat";
import { PaperResults } from "./paper-result";

// Desk AI panel (artboard BP-Home, B-Answer, DEC-164/165): báo cáo sáng + hỏi đáp. Lời LLM đã qua kiểm tra số ở server;
// câu mẫu (LLM tắt / hết lượt / ngoài phạm vi / số không khớp) dịch ở đây từ `key` + fact. Desk AI chỉ đọc: không có
// nút nào ở đây đổi bot. "Start a bot for me" mở luồng tạo bot qua chat (B-NewBot, tiền ảo trước); bài thử tiền ảo
// đủ ngày thì báo kết quả (B-Result).

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

/** Lời chào theo giờ trên máy người xem (báo cáo sáng xem lúc tối thì "Good evening"): < 12 giờ sáng, < 18 giờ chiều. */
export function greetingAt(now: Date): "morning" | "afternoon" | "evening" {
  const h = now.getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
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
      greeting: greetingAt(new Date()),
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
        <p className="m-0 max-w-[85%] self-end rounded-[16px_16px_4px_16px] bg-accent px-3.5 py-2 text-sm text-white">
          {turn.question}
        </p>
      )}
      <Answer answer={turn.answer} />
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
  const [newBot, setNewBot] = useState(false);
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
      className="flex min-w-0 flex-col overflow-hidden rounded-[24px] border border-border-input bg-surface shadow-card xl:h-[calc(100dvh-8rem)] xl:min-h-[520px]"
    >
      <div className="flex items-center gap-2.5 border-b border-border px-[18px] py-4">
        <AiMark />
        <h2 className="m-0 text-base font-extrabold">{t("title")}</h2>
        <Link href="/desk/history" className="ml-auto text-sm font-bold text-accent-ink">
          {t("history")}
        </Link>
      </div>
      <div className="flex max-h-[60vh] min-h-[200px] flex-col gap-3 overflow-y-auto px-[18px] py-4 text-[14.5px] leading-relaxed xl:max-h-none xl:flex-1">
        {brief.isPending ? (
          <Skeleton className="h-12 w-full rounded-[12px]" />
        ) : brief.data?.turn != null ? (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            <TurnView turn={brief.data.turn} />
          </ul>
        ) : brief.data?.available === false ? (
          <p className="m-0 text-sm text-ink-2">{t("briefLater")}</p>
        ) : null}
        <PaperResults />
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
        {newBot ? <NewBotChat /> : null}
      </div>
      <div className="flex flex-col gap-2 border-t border-border bg-surface-2 px-[18px] pt-3 pb-4">
        <div className="flex flex-wrap gap-1.5">
          {(["safe", "lose"] as const).map((k) => (
            <button
              key={k}
              type="button"
              disabled={ask.isPending}
              onClick={() => {
                send(t(`chips.${k}`));
              }}
              className="inline-flex min-h-[34px] items-center rounded-full border border-border-input bg-surface px-3 text-[12.5px] font-bold text-accent-ink hover:bg-surface-2 disabled:opacity-60"
            >
              {t(`chips.${k}`)}
            </button>
          ))}
          <button
            type="button"
            aria-expanded={newBot}
            onClick={() => {
              setNewBot((x) => !x);
            }}
            className="inline-flex min-h-[34px] items-center rounded-full border border-border-input bg-surface px-3 text-[12.5px] font-bold text-accent-ink hover:bg-surface-2"
          >
            {t("chips.start")}
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
          className="flex items-center gap-2"
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
            className="min-h-tap min-w-0 flex-1 rounded-full border border-border-input bg-surface px-3.5 text-[14.5px] text-ink"
          />
          <button
            type="submit"
            aria-label={t("send")}
            disabled={text.trim() === "" || ask.isPending}
            className="flex size-11 flex-none items-center justify-center rounded-full bg-accent text-white hover:bg-accent-ink disabled:opacity-50"
          >
            <ArrowUp aria-hidden="true" size={18} strokeWidth={2.5} />
          </button>
        </form>
        <p className="m-0 flex flex-wrap justify-between gap-2 text-xs text-muted">
          <span>{t("notAdvice")}</span>
          {questionsLeft === null ? null : <span>{t("questionsLeft", { n: questionsLeft })}</span>}
        </p>
      </div>
    </section>
  );
}
