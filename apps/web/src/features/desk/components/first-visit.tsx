"use client";

import { deskAiAskViewSchema, type DeskAiAskView } from "@drift/shared";
import { Button } from "@drift/ui";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";

import { api } from "@/lib/api";

import { Answer } from "./desk-ai";
import { NewBotChat } from "./new-bot-chat";

// Desk AI › lần đầu, chưa có bot (artboard B-Empty, DEC-164): cửa vào là Desk AI. "Start my first bot" mở luồng tạo
// bot qua chat (tiền ảo trước); hai câu hỏi mẫu và ô tự gõ hỏi Desk AI như panel (tính vào 20 câu / ngày).

type Turn = DeskAiAskView["turn"];

export function FirstVisit() {
  const t = useTranslations("desk.firstVisit");
  const ta = useTranslations("desk.ai");
  const inputId = useId();
  const [chat, setChat] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [text, setText] = useState("");
  const key = useRef(crypto.randomUUID());
  const ask = useMutation({
    mutationFn: (question: string) =>
      api("POST", "/api/v1/desk/ai/ask", deskAiAskViewSchema, {
        idempotencyKey: key.current,
        body: conversationId === undefined ? { question } : { question, conversationId },
      }),
    onSettled: () => {
      key.current = crypto.randomUUID();
    },
    onSuccess: (r) => {
      setTurns((xs) => [...xs, r.turn]);
      setConversationId(r.conversationId);
      setText("");
    },
  });
  const send = (q: string) => {
    const question = q.trim();
    if (question === "" || ask.isPending) return;
    ask.mutate(question);
  };
  const option = (title: string, sub: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-tap flex-col items-start gap-0.5 rounded-[16px] border border-border bg-surface px-4 py-3 text-left hover:bg-surface-2"
    >
      <span className="text-sm font-bold text-ink">{title}</span>
      <span className="text-xs text-ink-2">{sub}</span>
    </button>
  );

  return (
    <section
      aria-labelledby="first-visit"
      className="flex flex-col gap-4 rounded-hero bg-hero p-5 sm:p-7"
    >
      <div className="flex flex-col gap-1">
        <h2 id="first-visit" className="m-0 flex items-center gap-2 text-xl font-extrabold">
          <span aria-hidden="true" className="text-accent-ink">
            ✦
          </span>
          {t("title")}
        </h2>
        <p className="m-0 text-sm text-ink-2">{t("body")}</p>
      </div>
      {chat ? (
        <NewBotChat />
      ) : (
        <div className="grid gap-2 sm:grid-cols-3">
          {option(t("start"), t("startSub"), () => {
            setChat(true);
          })}
          {option(t("how"), t("howSub"), () => {
            send(t("how"));
          })}
          {option(t("safe"), t("safeSub"), () => {
            send(t("safe"));
          })}
        </div>
      )}
      {turns.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-live="polite">
          {turns.map((x) => (
            <li key={x.id} className="flex flex-col gap-1.5">
              <p className="m-0 self-end rounded-[14px] bg-ink px-3 py-2 text-sm text-white">
                {x.question}
              </p>
              <div className="flex gap-2">
                <span aria-hidden="true" className="text-accent-ink">
                  ✦
                </span>
                <Answer answer={x.answer} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {ask.isPending ? <p className="m-0 text-sm text-ink-2">{ta("thinking")}</p> : null}
      {ask.isError ? (
        <p role="alert" className="m-0 text-sm text-neg-ink">
          {ta("error")}
        </p>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
        className="flex gap-2"
      >
        <label htmlFor={inputId} className="sr-only">
          {t("own")}
        </label>
        <input
          id={inputId}
          value={text}
          maxLength={500}
          onChange={(e) => {
            setText(e.target.value);
          }}
          placeholder={t("own")}
          className="min-h-tap min-w-0 flex-1 rounded-[12px] border border-border-input bg-surface px-3 text-sm"
        />
        <Button type="submit" pending={ask.isPending} disabled={text.trim() === ""}>
          {ta("send")}
        </Button>
      </form>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-ink-2">
        {(["orders", "money", "data"] as const).map((k) => (
          <li key={k}>✓ {t(`promises.${k}`)}</li>
        ))}
      </ul>
    </section>
  );
}
