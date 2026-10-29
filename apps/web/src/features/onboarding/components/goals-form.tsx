"use client";

import {
  analysisViewSchema,
  assetOptionsSchema,
  dec,
  goalsViewSchema,
  goalsBodySchema,
  MAX_DROP_OPTIONS,
  RECO_GOALS,
  type MaxDropOption,
  type RecoGoal,
} from "@drift/shared";
import { Button } from "@drift/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import { api } from "@/lib/api";
import { formatMoney } from "@/lib/format";

import { OnboardingShell, StepHeading } from "./onboarding-shell";

// Onboarding 5 · Your goals (artboard "Onboarding 5", SCREENS.md mục 8.1). Câu trả lời lưu ở `goals`;
// số trong rail lấy từ bản phân tích thật, thiếu thì không hiện dòng đó.

export const GOALS_KEY = ["goals"] as const;
const goalsResponse = z.object({ goals: goalsViewSchema.nullable() });

const card = (on: boolean) =>
  `flex min-h-16 flex-col items-start gap-1.5 rounded-card border-2 p-4 text-left ${on ? "border-accent bg-accent-tint" : "border-border bg-surface"}`;

export function GoalsForm() {
  const t = useTranslations("onboarding.goals");
  const ts = useTranslations("onboarding.signup");
  const router = useRouter();
  const saved = useQuery({
    queryKey: GOALS_KEY,
    queryFn: () => api("GET", "/api/v1/goals", goalsResponse),
  });
  const options = useQuery({
    queryKey: ["goals", "options"],
    queryFn: () => api("GET", "/api/v1/goals/options", assetOptionsSchema),
  });
  const analysis = useQuery({
    queryKey: ["analysis", "latest"],
    queryFn: () => api("GET", "/api/v1/analysis/latest", analysisViewSchema),
  });
  const [goal, setGoal] = useState<RecoGoal>("automate");
  const [capital, setCapital] = useState("");
  const [drop, setDrop] = useState<MaxDropOption>("10");
  const [assets, setAssets] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const key = useRef(crypto.randomUUID());

  useEffect(() => {
    const g = saved.data?.goals;
    if (g === undefined || g === null || touched) return;
    setGoal(g.goal);
    setCapital(g.capital);
    setDrop(g.maxDrop);
    setAssets(g.assets);
  }, [saved.data, touched]);

  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: () =>
      api("PUT", "/api/v1/goals", goalsViewSchema, {
        idempotencyKey: key.current,
        body: goalsBodySchema.parse({
          goal,
          capital: capital.replace(/,/g, ""),
          maxDrop: drop,
          assets,
        }),
      }),
    onSuccess: (goals) => {
      // Bước 6 đọc cùng cache: ghi ngay mục tiêu vừa lưu, không để nó thấy `goals: null` cũ.
      queryClient.setQueryData(GOALS_KEY, { goals });
      router.push("/onboarding/plan");
    },
    onError: () => {
      key.current = crypto.randomUUID();
    },
  });

  const cleanCapital = capital.replace(/,/g, "").trim();
  const capitalOk = /^\d+(\.\d+)?$/.test(cleanCapital) && dec(cleanCapital).gt(0);
  const items = options.data?.items ?? [];
  const strongest = items
    .filter((i) => i.netPnl !== null && dec(i.netPnl).gt(0))
    .sort((a, b) => dec(b.netPnl ?? "0").comparedTo(dec(a.netPnl ?? "0")))[0]?.asset;
  const note = (i: (typeof items)[number]) =>
    i.asset === strongest
      ? t("notes.strongest")
      : i.netPnl !== null && dec(i.netPnl).lt(0)
        ? t("notes.loss")
        : i.hasHistory
          ? ""
          : t("notes.none");
  const m = analysis.data?.analysis?.metrics;
  const feePct =
    m !== undefined && dec(m.grossRealizedPnl).gt(0)
      ? dec(m.fees).div(m.grossRealizedPnl).mul(100).toDecimalPlaces(0).toString()
      : null;
  const worst = options.data?.worstDrawdownPct ?? null;

  const railPanel =
    m === undefined ? undefined : (
      <>
        <strong className="text-sm">{t("fromAnalysis")}</strong>
        <span>{t("netAfterCosts", { net: formatMoney(m.netPnl, true) ?? "" })}</span>
        {feePct === null ? null : <span>{t("feeShare", { pct: feePct })}</span>}
        {worst === null ? null : <span>{t("worstDd", { pct: worst })}</span>}
      </>
    );

  return (
    <OnboardingShell
      current={5}
      safety={ts("safety")}
      {...(railPanel === undefined ? {} : { railPanel })}
    >
      <StepHeading step={5} title={t("title")} lead={t("lead")} />

      <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
        <legend className="mb-2.5 text-base font-extrabold">{t("q1")}</legend>
        <div role="radiogroup" aria-label={t("q1")} className="grid gap-2.5 sm:grid-cols-2">
          {RECO_GOALS.map((g) => (
            <button
              key={g}
              type="button"
              role="radio"
              aria-checked={goal === g}
              className={card(goal === g)}
              onClick={() => {
                setTouched(true);
                setGoal(g);
              }}
            >
              <strong className="text-[15px]">{t(`options.${g}.label`)}</strong>
              <span className="text-[13px] leading-snug text-ink-2">{t(`options.${g}.sub`)}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <label htmlFor="cap" className="text-base font-extrabold">
          {t("q2")}
        </label>
        <div className="flex min-h-13 max-w-[360px] items-center rounded-control border border-border-input px-4">
          <input
            id="cap"
            inputMode="decimal"
            aria-invalid={touched && !capitalOk ? true : undefined}
            aria-describedby="cap-hint"
            className="min-w-0 flex-1 border-0 bg-transparent text-lg font-bold tabular-nums outline-none"
            value={capital}
            onChange={(e) => {
              setTouched(true);
              setCapital(e.target.value);
            }}
          />
          <span className="font-bold text-ink-2">{t("unit")}</span>
        </div>
        <span id="cap-hint" className="text-[13px] text-muted">
          {options.data?.available == null
            ? null
            : t("available", { amount: formatMoney(options.data.available) ?? "" })}
        </span>
        {touched && !capitalOk ? (
          <span className="text-sm text-neg-ink">⚠ {t("errors.capital")}</span>
        ) : null}
      </div>

      <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
        <legend className="mb-2.5 text-base font-extrabold">{t("q3")}</legend>
        <div
          role="radiogroup"
          aria-label={t("q3")}
          className="grid grid-cols-2 gap-2.5 sm:grid-cols-4"
        >
          {MAX_DROP_OPTIONS.map((o) => (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={drop === o}
              className={card(drop === o)}
              onClick={() => {
                setTouched(true);
                setDrop(o);
              }}
            >
              <strong className="text-[17px] tabular-nums">{t(`drop.${o}`)}</strong>
              <span className="text-xs text-ink-2 tabular-nums">
                {o === "unsure"
                  ? t("drop.unsureSub")
                  : capitalOk
                    ? `${formatMoney(dec(cleanCapital).mul(o).div(100).toString()) ?? ""} ${t("unit")}`
                    : ""}
              </span>
            </button>
          ))}
        </div>
        <span className="text-[13px] text-muted">
          {t("dropHint")} {worst === null ? null : t("dropWorst", { pct: worst })}
        </span>
      </fieldset>

      <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
        <legend className="mb-2.5 text-base font-extrabold">{t("q4")}</legend>
        <div className="flex flex-wrap gap-2.5">
          {items.map((i) => {
            const on = assets.includes(i.asset);
            return (
              <button
                key={i.asset}
                type="button"
                aria-pressed={on}
                className={`inline-flex min-h-11 items-center gap-2 rounded-full border-2 px-4 text-sm font-bold ${on ? "border-accent bg-accent-tint" : "border-border bg-surface"}`}
                onClick={() => {
                  setTouched(true);
                  setAssets(on ? assets.filter((a) => a !== i.asset) : [...assets, i.asset]);
                }}
              >
                {on ? "✓" : "+"} {i.asset}{" "}
                <span className="text-xs font-semibold text-ink-2">{note(i)}</span>
              </button>
            );
          })}
        </div>
        {touched && assets.length === 0 ? (
          <span className="text-sm text-neg-ink">⚠ {t("errors.assets")}</span>
        ) : null}
      </fieldset>

      <div className="flex flex-wrap justify-between gap-2.5 border-t border-border pt-4">
        <Link
          href="/onboarding/analysis"
          className="inline-flex min-h-12 items-center rounded-tile border border-border-input px-4 font-bold text-ink no-underline"
        >
          {t("back")}
        </Link>
        <Button
          pending={save.isPending}
          disabled={!capitalOk || assets.length === 0}
          onClick={() => {
            save.mutate();
          }}
        >
          {t("next")}
        </Button>
      </div>
    </OnboardingShell>
  );
}
