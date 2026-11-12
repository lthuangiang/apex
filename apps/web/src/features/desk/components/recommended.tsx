"use client";

import {
  assetOf,
  botSummarySchema,
  goalCheck,
  goalsViewSchema,
  lossLimitOf,
  planViewSchema,
  RECO_GOALS,
  type PlanView,
  type RecoGoal,
} from "@drift/shared";
import { Button, inputClassName, Skeleton } from "@drift/ui";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";

import { Card } from "@/components/workspace";
import { api, ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { useSodexConnection } from "@/lib/queries";

// AI Desk › Recommended (AI_DESK_RECOMMENDED.md mục 3–5, DEC-105, DEC-95): 3 câu hỏi → recommend() một bot → thẻ
// "Suggested for you". Đề xuất tự tính lại mỗi khi đổi câu trả lời và không ghi đè Goals đã lưu. Goal check chỉ là
// phép chia, không gửi lên server và không đổi đề xuất. Không có nút tiền thật ở đây.

const LOSSES = ["5", "10", "20"] as const;
const CAPITALS = ["1000", "5000", "10000"] as const;
const DAILIES = ["0.5", "2", "5"] as const;
const DEFAULT_ASSETS = ["BTC", "ETH"];

/** "5,000" thay vì "5,000.00" cho số tròn; số lẻ giữ 2 chữ số. */
export const money = (v: string | null): string | null =>
  formatMoney(v)?.replace(/\.00$/, "") ?? null;
/** Câu chữ của engine đề xuất dùng tên quote nội bộ của SoDEX ("vUSDC"); người dùng chỉ thấy "USDC". */
export const plainQuote = (text: string): string => text.replace(/\bv(USDC|USDT)\b/g, "$1");

function Choice({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend id={id} className="mb-2 p-0 text-sm font-bold">
        {label}
      </legend>
      <div role="group" aria-labelledby={id} className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => {
              onChange(o.value);
            }}
            className={`min-h-tap rounded-[14px] border px-3.5 text-sm font-bold ${
              value === o.value
                ? "border-accent bg-accent text-white"
                : "border-border-input bg-surface text-ink hover:bg-surface-2"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function useStartPaperError() {
  const t = useTranslations("desk.errors");
  return (e: unknown): string => {
    if (!(e instanceof ApiError)) return t("generic");
    if (e.code === "NOT_FOUND") return t("connect");
    if (e.code === "BOT_STATE_CONFLICT")
      return t("limit", { limit: typeof e.details.limit === "number" ? e.details.limit : 3 });
    if (e.code === "ORDER_BELOW_MIN_SIZE") return t("minSize");
    if (e.code === "VALIDATION_FAILED") return t("noPrice");
    if (e.code === "FORBIDDEN") return t("off");
    return t("generic");
  };
}

/** Tạo bot paper từ một đề xuất rồi mở trang Fake-money test. */
export function useStartPaper() {
  const router = useRouter();
  const tc = useTranslations("createBot.strategies");
  const key = useRef(crypto.randomUUID());
  return useMutation({
    mutationFn: (s: { id: string; strategy: string; market: string }) =>
      api("POST", "/api/v1/desk/paper", botSummarySchema, {
        idempotencyKey: key.current,
        body: {
          suggestionId: s.id,
          name: `${tc(`${s.strategy}.name` as "spot_grid.name")} · ${assetOf(s.market)}`,
        },
      }),
    onSuccess: (bot) => {
      key.current = crypto.randomUUID();
      router.push(`/desk/paper/${bot.id}`);
    },
    onError: () => {
      key.current = crypto.randomUUID();
    },
  });
}

export function SuggestionCard({ s }: { s: NonNullable<PlanView["best"]> }) {
  const t = useTranslations("desk");
  const tc = useTranslations("createBot.strategies");
  const start = useStartPaper();
  const errorText = useStartPaperError();
  const connection = useSodexConnection();
  // Bot paper cần account SoDEX đã kết nối (đọc giá và lệnh tối thiểu): nói trước, không đợi bấm mới báo lỗi.
  const notConnected =
    connection.data !== undefined && connection.data.connection?.status !== "connected";
  const limit = lossLimitOf(s.values);
  const name = `${tc(`${s.strategy}.name` as "spot_grid.name")} · ${assetOf(s.market)}`;
  const k = s.strategy as "spot_grid";
  return (
    <section
      aria-labelledby={`sug-${s.id}`}
      className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-surface p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`sug-${s.id}`} className="m-0 text-xl font-extrabold">
          {name}
        </h2>
        <span className="inline-flex h-6 items-center rounded-full bg-accent-tint px-2.5 text-xs font-bold text-accent-ink">
          {t("card.suggested")}
        </span>
      </div>
      <p className="m-0 text-sm leading-relaxed text-ink-body">{t(`strategy.${k}.what`)}</p>
      <dl className="m-0 grid grid-cols-1 gap-2.5 text-sm sm:grid-cols-3">
        <div className="flex flex-col gap-0.5 rounded-tile bg-surface-2 p-3.5">
          <dt className="text-xs text-muted">{t("card.loseUpTo")}</dt>
          <dd className="m-0 text-xl font-extrabold tabular-nums">
            {limit.kind === "limit" ? `${money(limit.amount) ?? ""} USDC` : t("card.noLimit")}
          </dd>
          <dd className="m-0 text-xs text-ink-2">
            {limit.kind === "limit" ? t("card.limitNote") : t("card.noLimitNote")}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5 rounded-tile bg-surface-2 p-3.5">
          <dt className="text-xs text-muted">{t("card.pace")}</dt>
          <dd className="m-0 text-lg font-extrabold">{t(`strategy.${k}.pace`)}</dd>
        </div>
        <div className="flex flex-col gap-0.5 rounded-tile bg-surface-2 p-3.5">
          <dt className="text-xs text-muted">{t("card.best")}</dt>
          <dd className="m-0 text-lg font-extrabold">{t(`strategy.${k}.best`)}</dd>
        </div>
      </dl>
      <p className="m-0 text-sm text-ink-2">
        {t("card.whenLoses", { text: t(`strategy.${k}.lose`) })}
      </p>
      {notConnected ? (
        <p className="m-0 rounded-tile bg-warn-bg px-3.5 py-3 text-sm text-ink">
          {t("card.connectFirst")}{" "}
          <Link href="/onboarding/connect" className="font-bold text-accent-ink">
            {t("card.connect")}
          </Link>
        </p>
      ) : null}
      {start.error === null ? null : (
        <p role="alert" className="m-0 text-sm text-neg-ink">
          {errorText(start.error)}{" "}
          {start.error instanceof ApiError && start.error.code === "NOT_FOUND" ? (
            <Link href="/onboarding/connect" className="font-bold text-accent-ink">
              {t("card.connect")}
            </Link>
          ) : null}
        </p>
      )}
      <div className="flex flex-wrap gap-2.5">
        <Button
          pending={start.isPending}
          disabled={notConnected}
          onClick={() => {
            start.mutate(s);
          }}
        >
          {start.isPending ? t("card.trying") : t("card.try")}
        </Button>
        <Link
          href={`/desk/why/${s.id}`}
          className="flex min-h-tap items-center rounded-control border border-border-input bg-surface px-4 text-sm font-bold text-ink no-underline hover:bg-surface-2"
        >
          {t("card.why")}
        </Link>
      </div>
      <p className="m-0 text-xs text-muted">{t("card.footer")}</p>
    </section>
  );
}

function GoalCheck({ capital }: { capital: string }) {
  const t = useTranslations("desk.goalCheck");
  const [daily, setDaily] = useState("2");
  const [other, setOther] = useState("");
  const value = daily === "other" ? other.trim() : daily;
  const g = goalCheck(value === "" ? "0" : value, capital === "" ? "0" : capital);
  return (
    <Card title={t("title")}>
      <p className="m-0 text-xs text-muted">{t("optional")}</p>
      <Choice
        label={t("daily")}
        value={daily}
        onChange={setDaily}
        options={[
          ...DAILIES.map((d) => ({ value: d, label: `${d} USDC` })),
          { value: "other", label: t("dailyOther") },
        ]}
      />
      {daily === "other" ? (
        <label className="flex max-w-[220px] flex-col gap-1 text-sm">
          <span className="text-xs text-muted">{t("dailyOther")}</span>
          <input
            inputMode="decimal"
            className={inputClassName}
            value={other}
            onChange={(e) => {
              setOther(e.target.value);
            }}
          />
        </label>
      ) : null}
      {g === null ? null : (
        <div className="flex flex-col gap-1.5" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold tabular-nums">
              {t("sum", {
                daily: value,
                capital: money(capital) ?? capital,
                pct: g.annualPct,
              })}
            </span>
            <span
              className={`inline-flex h-6 items-center rounded-full px-2.5 text-xs font-bold ${
                g.band === "reasonable"
                  ? "bg-pos-bg text-pos"
                  : g.band === "ambitious"
                    ? "bg-warn-bg text-warn"
                    : "bg-neg-bg text-neg-ink"
              }`}
            >
              {t(`bands.${g.band}.tag`)}
            </span>
          </div>
          <p className="m-0 text-sm text-ink-2">{t(`bands.${g.band}.text`)}</p>
          <p className="m-0 text-xs text-muted tabular-nums">
            {t("need", {
              daily: value,
              low: money(g.examples[0]?.capital ?? null) ?? "",
              lowPct: g.examples[0]?.annualPct ?? "",
              high: money(g.examples[1]?.capital ?? null) ?? "",
              highPct: g.examples[1]?.annualPct ?? "",
            })}
          </p>
        </div>
      )}
    </Card>
  );
}

export function Recommended() {
  const t = useTranslations("desk");
  const goals = useQuery({
    queryKey: ["goals"],
    queryFn: () => api("GET", "/api/v1/goals", z.object({ goals: goalsViewSchema.nullable() })),
  });
  const [goal, setGoal] = useState<RecoGoal>("range");
  const [loss, setLoss] = useState<string>("10");
  const [capital, setCapital] = useState("5000");
  const [capitalChoice, setCapitalChoice] = useState<string>("5000");
  const filled = useRef(false);
  useEffect(() => {
    if (filled.current || goals.data === undefined) return;
    filled.current = true;
    const g = goals.data.goals;
    if (g === null) return;
    setGoal(g.goal);
    if ((LOSSES as readonly string[]).includes(g.maxDrop)) setLoss(g.maxDrop);
    setCapital(g.capital);
    setCapitalChoice((CAPITALS as readonly string[]).includes(g.capital) ? g.capital : "other");
  }, [goals.data]);
  const capitalOk = /^\d+(\.\d+)?$/.test(capital.trim()) && Number(capital) > 0;
  const answers = {
    goal,
    maxDrop: loss,
    capital: capital.trim(),
    assets: goals.data?.goals?.assets ?? DEFAULT_ASSETS,
  };
  // Đổi câu trả lời là tính lại; ô "Other amount" chờ gõ xong 500 ms mới gửi.
  const [asked, setAsked] = useState(answers);
  const key = JSON.stringify(answers);
  useEffect(() => {
    const timer = setTimeout(() => {
      setAsked(JSON.parse(key) as typeof answers);
    }, 500);
    return () => {
      clearTimeout(timer);
    };
  }, [key]);
  const plan = useQuery({
    queryKey: ["desk-plan", asked],
    queryFn: () =>
      api("POST", "/api/v1/reco/plan", planViewSchema, {
        idempotencyKey: crypto.randomUUID(),
        body: { context: "desk", goals: asked },
      }),
    enabled: goals.data !== undefined && filled.current && capitalOk,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
  const p: PlanView | undefined = plan.data;
  const updating = plan.isFetching && p !== undefined;

  return (
    <div className="flex min-w-0 max-w-[1100px] flex-col gap-5">
      <section
        aria-labelledby="desk-questions"
        className="flex flex-col gap-4 rounded-hero bg-hero p-5 sm:p-7"
      >
        <h2 id="desk-questions" className="m-0 text-xl font-extrabold">
          {t("questions.title")}
        </h2>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <Choice
            label={t("questions.goal")}
            value={goal}
            onChange={(v) => {
              setGoal(v as RecoGoal);
            }}
            options={RECO_GOALS.map((g) => ({ value: g, label: t(`questions.goals.${g}`) }))}
          />
          <Choice
            label={t("questions.loss")}
            value={loss}
            onChange={setLoss}
            options={LOSSES.map((l) => ({ value: l, label: t(`questions.losses.${l}`) }))}
          />
          <div className="flex flex-col gap-2">
            <Choice
              label={t("questions.capital")}
              value={capitalChoice}
              onChange={(v) => {
                setCapitalChoice(v);
                if (v !== "other") setCapital(v);
              }}
              options={[
                ...CAPITALS.map((c) => ({ value: c, label: `${money(c) ?? c} USDC` })),
                { value: "other", label: t("questions.capitalOther") },
              ]}
            />
            {capitalChoice === "other" ? (
              <label className="flex max-w-[260px] flex-col gap-1 text-sm">
                <span className="text-xs text-ink-2">{t("questions.capitalOther")}</span>
                <input
                  inputMode="decimal"
                  className={inputClassName}
                  value={capital}
                  onChange={(e) => {
                    setCapital(e.target.value);
                  }}
                />
              </label>
            ) : null}
          </div>
        </div>
        <p className="m-0 text-xs text-ink-2">{t("questions.capitalHint")}</p>
      </section>

      <div aria-live="polite" className={updating ? "opacity-60 transition-opacity" : ""}>
        {!capitalOk ? (
          <Card>
            <p className="m-0 text-sm text-ink-2">{t("questions.capitalInvalid")}</p>
          </Card>
        ) : plan.isError ? (
          <p role="alert" className="m-0 text-sm text-neg-ink">
            {t("error")}
          </p>
        ) : p === undefined ? (
          <div role="status" aria-label={t("questions.submitting")}>
            <Skeleton className="h-72 w-full rounded-card" />
          </div>
        ) : p.best === null ? (
          <Card title={t("empty.title")}>
            {p.notSuggested.length === 0 ? null : (
              <>
                <h3 className="m-0 text-sm font-bold">{t("empty.why")}</h3>
                <ul className="m-0 flex flex-col gap-1 pl-4 text-sm text-ink-2">
                  {p.notSuggested.map((n) => (
                    <li key={`${n.title}${n.reason}`}>
                      <strong className="text-ink">{n.title}</strong>: {plainQuote(n.reason)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            <SuggestionCard s={p.best} />
            {p.notes.length === 0 ? null : (
              <p className="m-0 text-xs text-muted">{t("questions.noHistory")}</p>
            )}
          </div>
        )}
      </div>

      <GoalCheck capital={capitalOk ? capital.trim() : ""} />
      <Card title={t("verified.title")}>
        <p className="m-0 text-sm text-ink-2">{t("verified.empty")}</p>
      </Card>
      <p className="m-0 text-sm text-ink-2">
        {t("selfSetup")}{" "}
        <Link href="/bots?tab=catalog" className="font-bold text-accent-ink">
          {t("openLab")}
        </Link>
      </p>
    </div>
  );
}
