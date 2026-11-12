"use client";

import { goalsViewSchema, planViewSchema, type PlanView, type RecoGoal } from "@drift/shared";
import { Button, Skeleton } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useState, type ReactNode } from "react";
import { z } from "zod";

import { api } from "@/lib/api";

import { SuggestionCard } from "./recommended";

// Desk AI › tạo bot qua chat (artboard B-NewBot, DEC-164 vòng "tạo bot"): 3 câu hỏi của Recommended dạng nút chọn nhanh
// → thẻ kế hoạch từ `recommend()` (POST /api/v1/reco/plan, như /desk/new) → "Try with fake money" (DEC-105). Không tạo
// bot tiền thật từ chat: tiền thật chỉ qua "Use real money" sau bài thử. "Not sure, you pick" dùng mục tiêu `steady`
// (DEC-TBD-desk-chat).

const GOALS = [
  { key: "accumulate", goal: "accumulate" },
  { key: "range", goal: "range" },
  { key: "unsure", goal: "steady" },
] as const satisfies readonly { key: string; goal: RecoGoal }[];
const LOSSES = ["5", "10", "20"] as const;
const DEFAULT_ASSETS = ["BTC", "ETH"];

function Bot({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <span aria-hidden="true" className="text-accent-ink">
        ✦
      </span>
      <div className="flex min-w-0 flex-col gap-2 text-sm text-ink">{children}</div>
    </li>
  );
}

function Me({ children }: { children: ReactNode }) {
  return (
    <li className="self-end rounded-[14px] bg-ink px-3 py-2 text-sm text-white">{children}</li>
  );
}

function Chips<T extends string>({
  options,
  onPick,
}: {
  options: readonly { value: T; label: string }[];
  onPick: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => {
            onPick(o.value);
          }}
          className="inline-flex min-h-tap items-center rounded-full border border-border bg-surface px-3 text-sm font-semibold text-ink hover:bg-surface-2"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function NewBotChat() {
  const t = useTranslations("desk.chat");
  const td = useTranslations("desk");
  const ta = useTranslations("desk.ai");
  const inputId = useId();
  const saved = useQuery({
    queryKey: ["goals"],
    queryFn: () => api("GET", "/api/v1/goals", z.object({ goals: goalsViewSchema.nullable() })),
  });
  const [goal, setGoal] = useState<(typeof GOALS)[number] | null>(null);
  const [loss, setLoss] = useState<(typeof LOSSES)[number] | null>(null);
  const [capital, setCapital] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const draftOk = /^\d+(\.\d+)?$/.test(draft.trim()) && Number(draft) > 0;
  const step = goal === null ? 1 : loss === null ? 2 : 3;
  const plan = useQuery({
    queryKey: ["desk-chat-plan", goal?.goal, loss, capital],
    queryFn: () =>
      api("POST", "/api/v1/reco/plan", planViewSchema, {
        idempotencyKey: crypto.randomUUID(),
        body: {
          context: "desk",
          goals: {
            goal: goal?.goal ?? "steady",
            maxDrop: loss ?? "10",
            capital: capital ?? "0",
            assets: saved.data?.goals?.assets ?? DEFAULT_ASSETS,
          },
        },
      }),
    enabled: goal !== null && loss !== null && capital !== null && saved.data !== undefined,
    staleTime: 60_000,
    retry: false,
  });
  const p: PlanView | undefined = plan.data;
  const restart = () => {
    setGoal(null);
    setLoss(null);
    setCapital(null);
    setDraft("");
  };

  return (
    <section aria-label={t("title")} className="flex flex-col gap-3">
      <p className="m-0 text-xs font-bold text-ink-2">{t("step", { n: Math.min(step, 3) })}</p>
      <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-live="polite">
        <Bot>
          <p className="m-0">{t("goal")}</p>
          {goal === null ? (
            <Chips
              options={GOALS.map((g) => ({ value: g.key, label: t(`goals.${g.key}`) }))}
              onPick={(k) => {
                setGoal(GOALS.find((g) => g.key === k) ?? null);
              }}
            />
          ) : null}
        </Bot>
        {goal === null ? null : <Me>{t(`goals.${goal.key}`)}</Me>}
        {goal === null ? null : (
          <Bot>
            <p className="m-0">{t("loss")}</p>
            {loss === null ? (
              <Chips
                options={LOSSES.map((l) => ({ value: l, label: t(`losses.${l}`) }))}
                onPick={setLoss}
              />
            ) : null}
          </Bot>
        )}
        {loss === null ? null : <Me>{t(`losses.${loss}`)}</Me>}
        {loss === null ? null : (
          <Bot>
            <p className="m-0">{t("capital")}</p>
            {capital === null ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (draftOk) setCapital(draft.trim());
                }}
                className="flex gap-2"
              >
                <label htmlFor={inputId} className="sr-only">
                  {t("capitalLabel")}
                </label>
                <input
                  id={inputId}
                  inputMode="decimal"
                  value={draft}
                  placeholder={t("capitalLabel")}
                  onChange={(e) => {
                    setDraft(e.target.value);
                  }}
                  className="min-h-tap w-40 rounded-[12px] border border-border-input bg-surface px-3 text-sm"
                />
                <Button type="submit" disabled={!draftOk}>
                  {ta("send")}
                </Button>
              </form>
            ) : null}
          </Bot>
        )}
        {capital === null ? null : <Me>{`${capital} USDC`}</Me>}
        {capital === null ? null : (
          <Bot>
            {plan.isPending ? (
              <Skeleton className="h-48 w-full rounded-card" />
            ) : plan.isError ? (
              <p role="alert" className="m-0 text-neg-ink">
                {td("error")}
              </p>
            ) : p?.best == null ? (
              <p className="m-0">{td("empty.title")}</p>
            ) : (
              <>
                <p className="m-0">{t("plan")}</p>
                <SuggestionCard s={p.best} />
                <p className="m-0 text-xs text-muted">{t("foot")}</p>
              </>
            )}
            <div>
              <Button variant="secondary" onClick={restart}>
                {t("change")}
              </Button>
            </div>
          </Bot>
        )}
      </ul>
    </section>
  );
}
