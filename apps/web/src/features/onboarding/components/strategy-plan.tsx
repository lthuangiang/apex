"use client";

import { dec, goalsViewSchema, planViewSchema, type SuggestionView } from "@drift/shared";
import { Button } from "@drift/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import { FIELDS, isLaunched } from "@/features/bots/fields";
import { api } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";
import { useMe, useSodexConnection } from "@/lib/queries";

import { GOALS_KEY } from "./goals-form";
import { OnboardingShell } from "./onboarding-shell";

// Onboarding 6 · Strategy plan (artboard "Onboarding 6", RECO_ENGINE.md mục 10). Mọi số lấy từ engine
// đề xuất; mỗi bot mở màn tạo với giá trị là AI parameters, chưa giao dịch gì cho tới khi xác nhận.

const goalsResponse = z.object({ goals: goalsViewSchema.nullable() });
const PLAN_ROWS = 5;

export function StrategyPlan() {
  const names = useMarketNames();
  const t = useTranslations("onboarding.plan");
  const tg = useTranslations("onboarding.goals");
  const ts = useTranslations("onboarding.signup");
  const tf = useTranslations("createBot");
  const goals = useQuery({
    queryKey: GOALS_KEY,
    queryFn: () => api("GET", "/api/v1/goals", goalsResponse),
  });
  const conn = useSodexConnection();
  const me = useMe();
  const key = useRef(crypto.randomUUID());
  const plan = useMutation({
    mutationFn: () =>
      api("POST", "/api/v1/reco/plan", planViewSchema, { idempotencyKey: key.current }),
    onSettled: () => {
      key.current = crypto.randomUUID();
    },
  });
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const hasGoals = goals.data?.goals !== undefined && goals.data.goals !== null;
  const { mutate } = plan;
  useEffect(() => {
    if (hasGoals) mutate();
  }, [hasGoals, mutate]);

  const g = goals.data?.goals ?? null;
  const p = plan.data;
  const cards =
    p === undefined
      ? []
      : [
          ...(p.best === null ? [] : [{ s: p.best, best: true }]),
          ...p.addOns.map((s) => ({ s, best: false })),
        ];
  const included = cards.filter((c) => !excluded.has(c.s.id));
  const allocated = included.reduce((a, c) => a.add(c.s.capital), dec("0"));
  const signed =
    conn.data?.connection?.apiKey?.status === "active" &&
    conn.data.connection.builderFee?.approved === true;
  const twofa = me.data?.twoFactorEnabled === true;

  const railPanel =
    g === null ? undefined : (
      <>
        <strong className="text-sm">{t("answers")}</strong>
        <span>{t("answerGoal", { goal: tg(`options.${g.goal}.label`).toLowerCase() })}</span>
        <span>{t("answerCapital", { capital: formatMoney(g.capital) ?? "" })}</span>
        <span>
          {g.maxDrop === "unsure"
            ? t("answerDropUnsure")
            : t("answerDrop", {
                pct: g.maxDrop,
                amount: formatMoney(dec(g.capital).mul(g.maxDrop).div(100).toString()) ?? "",
              })}
        </span>
        <span>{t("answerMarkets", { markets: g.assets.join(", ") })}</span>
        <Link href="/onboarding/goals" className="font-bold no-underline">
          {t("change")}
        </Link>
      </>
    );

  const title = (s: SuggestionView) => {
    const lev = s.values.leverage;
    return `${tf(`strategies.${s.strategy}.name`)} · ${names.market(s.market)}${typeof lev === "number" ? ` · ${t("leverage", { n: lev })}` : ""}`;
  };
  const rows = (s: SuggestionView) =>
    isLaunched(s.strategy)
      ? FIELDS[s.strategy]
          .filter(
            (f) =>
              f.key !== "market" &&
              f.type.kind !== "assets" &&
              s.values[f.key] !== undefined &&
              f.key !== "leverage",
          )
          .slice(0, PLAN_ROWS)
          .map((f) => ({
            key: f.key,
            label: tf(`fields.${f.label ?? f.key}.label`),
            value: String(s.values[f.key] as string | number | boolean),
          }))
      : [];
  const first = included[0]?.s;

  return (
    <OnboardingShell
      current={6}
      safety={ts("safety")}
      wide
      {...(railPanel === undefined ? {} : { railPanel })}
    >
      <header className="flex flex-col gap-1.5">
        <span className="text-xs font-extrabold tracking-[0.08em] text-accent">{t("step")}</span>
        <h1 className="m-0 text-[26px] font-extrabold tracking-tight md:text-[30px]">
          {t("title")}
        </h1>
        <p className="m-0 text-sm leading-relaxed text-ink-2 md:text-[15px]">{t("lead")}</p>
      </header>

      {goals.isSuccess && !hasGoals ? (
        <p className="m-0">
          {t("noGoals")} <Link href="/onboarding/goals">{t("change")}</Link>
        </p>
      ) : null}
      {plan.isPending ? <p role="status">{t("loading")}</p> : null}
      {plan.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-tile bg-warn-bg p-4">
          <span>{t("unavailable")}</span>
          <Button
            variant="secondary"
            onClick={() => {
              plan.mutate();
            }}
          >
            {t("retry")}
          </Button>
        </div>
      ) : null}
      {p?.empty == null ? null : <p className="m-0 rounded-card bg-surface p-5">{p.empty}</p>}

      {cards.map(({ s, best }) => {
        const on = !excluded.has(s.id);
        return (
          <article
            key={s.id}
            aria-label={title(s)}
            className={`flex flex-col gap-4 rounded-hero bg-surface p-5 ${best ? "border-2 border-accent" : "border border-border"}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span
                  className={`self-start rounded-full px-2.5 py-0.5 text-[11px] font-extrabold tracking-wide ${best ? "bg-accent text-white" : "bg-border text-ink-2"}`}
                >
                  {best ? t("bestFit") : t("addOn")}
                </span>
                <h2 className="m-0 text-xl font-extrabold">{title(s)}</h2>
              </div>
              <button
                type="button"
                aria-pressed={on}
                className={`min-h-11 rounded-control px-4 text-sm font-bold ${on ? "bg-ink text-white" : "border border-border-input bg-surface text-ink"}`}
                onClick={() => {
                  const next = new Set(excluded);
                  if (on) next.add(s.id);
                  else next.delete(s.id);
                  setExcluded(next);
                }}
              >
                {on ? t("inPlan") : t("addToPlan")}
              </button>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <h3 className="m-0 text-[13px] font-extrabold tracking-wide text-ink-2">
                  {t("why")}
                </h3>
                <ul className="m-0 flex flex-col gap-1.5 pl-4 text-sm leading-normal tabular-nums">
                  {s.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
              <dl className="m-0 grid grid-cols-[1fr_auto] content-start gap-x-4 gap-y-2 rounded-card bg-bg p-4 text-sm tabular-nums">
                <dt className="text-ink-2">{t("capital")}</dt>
                <dd className="m-0 text-right font-bold">{formatMoney(s.capital)} USDC</dd>
                {rows(s).map((r) => (
                  <div key={r.key} className="contents">
                    <dt className="text-ink-2">{r.label}</dt>
                    <dd className="m-0 text-right font-bold">{r.value}</dd>
                  </div>
                ))}
                <dt className="text-ink-2">{t("builderFee")}</dt>
                <dd className="m-0 text-right font-bold">{t("builderFeeValue")}</dd>
              </dl>
            </div>
            <p className="m-0 rounded-tile bg-accent-tint p-3 text-[13px] leading-normal">
              <strong>{t("marketCheck")}</strong> {s.basis}
            </p>
            <Link
              href={`/bots/new/${s.strategy}?suggestion=${s.id}`}
              className="text-sm font-bold no-underline"
            >
              {t("editSettings")}
            </Link>
          </article>
        );
      })}

      {p === undefined || (p.notSuggested.length === 0 && p.notes.length === 0) ? null : (
        <section
          aria-labelledby="no-h"
          className="flex flex-col gap-2.5 rounded-card border border-dashed border-border-input bg-bg p-5"
        >
          <h2 id="no-h" className="m-0 text-base font-bold">
            {t("notSuggested")}
          </h2>
          <ul className="m-0 flex flex-col gap-1.5 pl-4 text-sm leading-normal text-ink-2 tabular-nums">
            {p.notSuggested.map((n) => (
              <li key={n.title}>
                <strong className="text-ink">{n.title}:</strong> {n.reason}
              </li>
            ))}
            {p.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap gap-5">
        {p === undefined || cards.length === 0 ? null : (
          <section
            aria-labelledby="alloc-h"
            className="flex min-w-0 flex-[1_1_300px] flex-col gap-3 rounded-card border border-border bg-surface p-5 tabular-nums"
          >
            <h2 id="alloc-h" className="m-0 text-base font-bold">
              {t("capitalPlan")}
            </h2>
            <div className="flex h-3.5 overflow-hidden rounded-full bg-bg">
              {cards.map(({ s, best }) =>
                excluded.has(s.id) ? null : (
                  <div
                    key={s.id}
                    className={best ? "bg-warn-bar" : "bg-pos-dot"}
                    style={{ width: `${dec(s.capital).div(p.capital).mul(100).toFixed(2)}%` }}
                  />
                ),
              )}
            </div>
            {cards.map(({ s }) => (
              <div key={s.id} className="flex justify-between text-sm">
                <span>{tf(`strategies.${s.strategy}.name`)}</span>
                <strong>
                  {excluded.has(s.id) ? t("notIncluded") : `${formatMoney(s.capital) ?? ""} USDC`}
                </strong>
              </div>
            ))}
            <div className="flex justify-between border-t border-border pt-2 text-sm">
              <span className="text-ink-2">
                {t("allocated", { capital: formatMoney(p.capital) ?? "" })}
              </span>
              <strong>{formatMoney(allocated.toString())} USDC</strong>
            </div>
          </section>
        )}
        <section
          aria-labelledby="perm-h"
          className="flex min-w-0 flex-[1_1_300px] flex-col gap-2.5 rounded-card border-[1.5px] border-warn-bar bg-surface p-5"
        >
          <h2 id="perm-h" className="m-0 text-base font-bold">
            {t("beforeTrade")}
          </h2>
          <div className="flex justify-between gap-2 text-sm">
            <span>{t("keyFee")}</span>
            <strong className={signed ? "text-pos" : "text-warn"}>
              {signed ? t("signed") : t("notSigned")}
            </strong>
          </div>
          <div className="flex justify-between gap-2 text-sm">
            <span>{t("twoFactor")}</span>
            <strong className={twofa ? "text-pos" : "text-warn"}>
              {twofa ? t("on") : t("notSet")}
            </strong>
          </div>
          <span className="text-xs text-ink-2">{t("required")}</span>
          {twofa ? null : (
            <Link href="/settings" className="text-[13px] font-bold no-underline">
              {t("setup2fa")}
            </Link>
          )}
        </section>
      </div>

      <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
        <legend className="mb-2.5 text-lg font-extrabold">{t("startHow")}</legend>
        <div className="grid gap-3 md:grid-cols-2">
          <div
            role="radio"
            aria-checked="true"
            className="flex flex-col gap-2 rounded-card border-2 border-accent bg-accent-tint p-4"
          >
            <span className="flex items-center gap-2">
              <strong>{t("live")}</strong>
              <span className="rounded-full bg-neg-bg px-2 py-0.5 text-[11px] font-extrabold text-neg-ink">
                {t("liveTag")}
              </span>
            </span>
            <span className="text-[13px] leading-normal text-ink-2">{t("liveSub")}</span>
          </div>
          <div
            role="radio"
            aria-checked="false"
            aria-disabled="true"
            className="flex flex-col gap-2 rounded-card border-2 border-dashed border-border-input bg-bg p-4 opacity-70"
          >
            <span className="flex items-center gap-2">
              <strong>{t("paper")}</strong>
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-extrabold text-ink-2">
                {t("paperTag")}
              </span>
            </span>
            <span className="text-[13px] leading-normal text-ink-2">{t("paperSub")}</span>
          </div>
        </div>
      </fieldset>

      <div className="flex flex-wrap justify-between gap-2.5">
        <Link
          href="/"
          className="inline-flex min-h-12 items-center rounded-tile border border-border-input bg-surface px-4 font-bold text-ink no-underline"
        >
          {t("skip")}
        </Link>
        {first === undefined ? (
          <Button disabled>{t("ctaNone")}</Button>
        ) : (
          <Link
            href={`/bots/new/${first.strategy}?suggestion=${first.id}`}
            className="inline-flex min-h-12 items-center rounded-tile bg-accent px-5 font-bold text-white no-underline"
          >
            {t("cta", { n: included.length })}
          </Link>
        )}
      </div>
      <p className="m-0 text-xs leading-normal text-muted">{t("footnote")}</p>
    </OnboardingShell>
  );
}
