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
  const option = (title: string, sub: string, onClick: () => void, primary = false) => (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-tap flex-col items-start gap-1.5 rounded-[18px] p-[18px] text-left ${
        primary
          ? "border-2 border-accent bg-accent-tint hover:bg-surface-2"
          : "border border-border-input bg-surface hover:bg-surface-2"
      }`}
    >
      <strong className="text-[15.5px] text-ink">{title}</strong>
      <span className="text-[13.5px] leading-[1.45] text-ink-2">{sub}</span>
    </button>
  );

  // Artboard B-Empty: một thẻ trắng giữa trang (tối đa 820 px), không có PageHead; chỉ một h1.
  return (
    <section
      aria-labelledby="first-visit"
      className="mx-auto flex w-full max-w-[820px] flex-col gap-6 rounded-[28px] border border-border bg-surface px-5 pt-10 pb-8 sm:px-10 sm:pt-12"
    >
      <div className="flex flex-col items-center gap-3.5 text-center">
        <span
          aria-hidden="true"
          className="flex size-[72px] items-center justify-center rounded-[24px] bg-ai-mark text-[32px] text-white"
        >
          ✦
        </span>
        <h1 id="first-visit" className="m-0 text-[32px] font-extrabold tracking-[-0.02em]">
          {t("title")}
        </h1>
        <p className="m-0 max-w-[560px] text-[17px] leading-[1.6] text-ink-2">{t("body")}</p>
      </div>
      {chat ? (
        <NewBotChat />
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          {option(
            t("start"),
            t("startSub"),
            () => {
              setChat(true);
            },
            true,
          )}
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
              <p className="m-0 max-w-[85%] self-end rounded-[16px_16px_4px_16px] bg-accent px-3.5 py-2 text-sm text-white">
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
        className="flex items-end gap-2.5"
      >
        <label
          htmlFor={inputId}
          className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs font-bold text-muted"
        >
          {t("own")}
          <textarea
            id={inputId}
            rows={2}
            value={text}
            maxLength={500}
            onChange={(e) => {
              setText(e.target.value);
            }}
            onKeyDown={(e) => {
              // Enter gửi, Shift+Enter xuống dòng.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(text);
              }
            }}
            placeholder={t("placeholder")}
            className="w-full resize-none rounded-[14px] border border-border-input bg-surface px-3.5 py-3 text-[15px] font-normal text-ink"
          />
        </label>
        <Button type="submit" pending={ask.isPending} disabled={text.trim() === ""}>
          {ta("send")}
        </Button>
      </form>
      <ul className="m-0 flex list-none flex-wrap justify-center gap-x-[22px] gap-y-2 p-0 text-[13px] text-ink-2">
        {(["orders", "money", "data"] as const).map((k) => (
          <li key={k}>✓ {t(`promises.${k}`)}</li>
        ))}
      </ul>
    </section>
  );
}
