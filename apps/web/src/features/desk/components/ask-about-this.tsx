"use client";

import { deskAiAskViewSchema, type DeskAiAskView, type DeskAiContext } from "@drift/shared";
import { BottomSheet, Button } from "@drift/ui";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";

import { api } from "@/lib/api";
import { useFeatures } from "@/lib/queries";

import { Answer, ThinkingTurn } from "./desk-ai";

// ✦ "Ask about this" (AI Desk B+ M6, artboard BP-AskHere, DEC-166): nút ✦ cạnh bot, quyết định hay Portfolio. Bấm thì mở
// sheet với câu mặc định dạng chip; chỉ khi user bấm chip hoặc gửi mới hỏi Desk AI kèm ngữ cảnh (server tự đọc bot /
// quyết định, kiểm tra thuộc user) và mới tính lượt (DEC-190). Chỉ hiện khi team bật AI Desk
// cho tài khoản. Desk AI chỉ đọc: không có nút nào ở đây đổi bot.

type Turn = DeskAiAskView["turn"];

export function AskAboutThis({
  context,
  subtitle,
  className = "",
}: {
  context: DeskAiContext;
  /** Dòng phụ dưới tiêu đề, ví dụ "Skipped entry · 14:02 · BTC Volume Farm". */
  subtitle?: string;
  className?: string;
}) {
  const t = useTranslations("desk.askHere");
  const ta = useTranslations("desk.ai");
  const features = useFeatures();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [text, setText] = useState("");
  const key = useRef(crypto.randomUUID());
  const ask = useMutation({
    mutationFn: (question: string) =>
      api("POST", "/api/v1/desk/ai/ask", deskAiAskViewSchema, {
        idempotencyKey: key.current,
        body: {
          question,
          context,
          ...(conversationId === undefined ? {} : { conversationId }),
        },
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
  if (features.data?.aiDesk !== true) return null;
  const kind = context.kind;
  const send = (q: string) => {
    const question = q.trim();
    if (question === "" || ask.isPending) return;
    ask.mutate(question);
  };

  return (
    <>
      <button
        type="button"
        aria-label={t("button")}
        title={t("button")}
        onClick={() => {
          // Mở / đóng sheet không bao giờ tốn lượt: chỉ gọi API khi user bấm chip hoặc gửi câu hỏi.
          setOpen(true);
        }}
        className={`inline-flex size-7 flex-none items-center justify-center rounded-full text-accent-ink hover:bg-accent-tint ${className}`}
      >
        <span aria-hidden="true">✦</span>
      </button>
      <BottomSheet
        open={open}
        onOpenChange={setOpen}
        title={t(`title.${kind}`)}
        {...(subtitle === undefined ? {} : { description: subtitle })}
        closeLabel={t("close")}
      >
        <div className="flex flex-col gap-3">
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
            {ask.isPending ? <ThinkingTurn question={ask.variables} bubble="ink" /> : null}
          </ul>
          {turns.length === 0 && !ask.isPending ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  send(t(`question.${kind}`));
                }}
                className="inline-flex min-h-9 items-center rounded-full border border-border bg-surface px-3 text-sm font-semibold text-ink hover:bg-surface-2"
              >
                {t(`question.${kind}`)}
              </button>
            </div>
          ) : null}
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
              {t(`placeholder.${kind}`)}
            </label>
            <input
              id={inputId}
              value={text}
              maxLength={500}
              onChange={(e) => {
                setText(e.target.value);
              }}
              placeholder={t(`placeholder.${kind}`)}
              className="min-h-tap min-w-0 flex-1 rounded-[12px] border border-border-input bg-surface px-3 text-sm"
            />
            <Button type="submit" pending={ask.isPending} disabled={text.trim() === ""}>
              {ta("send")}
            </Button>
          </form>
          <p className="m-0 text-xs text-muted">{ta("notAdvice")}</p>
        </div>
      </BottomSheet>
    </>
  );
}
