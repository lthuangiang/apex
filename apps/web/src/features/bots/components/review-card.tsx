"use client";

import { botReviewViewSchema, type BotReviewResult, type ReviewParamsView } from "@drift/shared";
import { Skeleton } from "@drift/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef } from "react";
import { z } from "zod";

import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

// Review sau khi chạy của Volume Builder (DEC-131): chạy lại lối thoát trên lệnh vào thật của bot với nhiều bộ tham
// số; chỉ đề xuất khi tốt hơn rõ ràng (khoảng tin cậy 95% của mức chênh nằm dưới 0).

/** Dưới mức này kết quả còn rộng (REVIEW_SOLID_TRADES ở packages/strategies, DEC-131). */
const SOLID_TRADES = 200;
const latestSchema = z.object({ review: botReviewViewSchema.nullable() });
const appliedSchema = z.object({ version: z.number().int(), status: z.string() });

const usd = (v: number) => Math.round(v).toLocaleString("en-US");
/** Chi phí mỗi $1M; âm là có lãi: "−$181". */
const cost = (v: number) => (v < 0 ? `−$${usd(-v)}` : `$${usd(v)}`);
const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${usd(Math.abs(v))}`;

type Done = Extract<BotReviewResult, { status: "done" }>;
const PARAM_KEYS = [
  "earlyProfitFees",
  "earlyExitSecs",
  "hold",
  "slMarginPct",
] as const satisfies readonly string[];

function paramText(
  p: ReviewParamsView,
  key: (typeof PARAM_KEYS)[number],
  t: ReturnType<typeof useTranslations>,
) {
  switch (key) {
    case "earlyProfitFees":
      return t("value.fees", { n: String(p.earlyProfitFees) });
    case "earlyExitSecs":
      return t("value.secs", { n: String(p.earlyExitSecs) });
    case "hold":
      return t("value.hold", { min: String(p.minHoldSecs), max: String(p.maxHoldSecs) });
    case "slMarginPct":
      return t("value.margin", { n: String(p.slMarginPct) });
  }
}

export function ReviewCard({ botId, stopped }: { botId: string; stopped: boolean }) {
  const t = useTranslations("agent.review");
  const qc = useQueryClient();
  const startKey = useRef(crypto.randomUUID());
  const applyKey = useRef(crypto.randomUUID());
  const q = useQuery({
    queryKey: ["bot-review", botId],
    queryFn: () => api("GET", `/api/v1/bots/${botId}/review`, latestSchema),
    refetchInterval: (query) => {
      const s = query.state.data?.review?.status;
      return s === "queued" || s === "running" ? 2000 : false;
    },
  });
  const start = useMutation({
    mutationFn: () =>
      api("POST", `/api/v1/bots/${botId}/review`, botReviewViewSchema, {
        idempotencyKey: startKey.current,
        body: {},
      }),
    onSuccess: async () => {
      startKey.current = crypto.randomUUID();
      await qc.invalidateQueries({ queryKey: ["bot-review", botId] });
    },
  });
  const review = q.data?.review ?? null;
  const apply = useMutation({
    mutationFn: () =>
      api("POST", `/api/v1/bots/${botId}/review/${review?.id ?? ""}/apply`, appliedSchema, {
        idempotencyKey: applyKey.current,
        body: {},
      }),
    onSuccess: async () => {
      applyKey.current = crypto.randomUUID();
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["bot-review", botId] }),
        qc.invalidateQueries({ queryKey: ["bot", botId] }),
      ]);
    },
  });

  const busy = review?.status === "queued" || review?.status === "running" || start.isPending;
  const result = review?.result ?? null;

  return (
    <section
      aria-labelledby="review-title"
      className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-10 items-center justify-center rounded-[12px] bg-accent-tint text-accent"
          >
            <Sparkles size={20} strokeWidth={2.4} />
          </span>
          <div className="flex flex-col">
            <h2 id="review-title" className="m-0 text-lg font-extrabold">
              {t("title")}
            </h2>
            <span className="text-xs text-muted">{t("subtitle")}</span>
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            start.mutate();
          }}
          className="min-h-9 rounded-[10px] border border-border bg-surface px-3 text-[13px] font-bold text-ink hover:bg-surface-2 disabled:opacity-60"
        >
          {busy ? t("running") : review === null ? t("run") : t("runAgain")}
        </button>
      </header>

      {q.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : busy ? (
        <div className="flex flex-col gap-2" aria-live="polite">
          <Skeleton className="h-16 w-full" />
          <span className="text-xs text-muted">{t("runningNote")}</span>
        </div>
      ) : review === null ? (
        <p className="m-0 text-sm text-ink-2">{t("intro")}</p>
      ) : review.status === "failed" || review.status === "unavailable" || result === null ? (
        <p className="m-0 text-sm text-neg-ink">{t("failed")}</p>
      ) : result.status === "insufficient" ? (
        <p className="m-0 text-sm text-ink-2">
          {t("insufficient", { trades: result.trades, min: result.minTrades })}
        </p>
      ) : (
        <Result
          r={result}
          appliedVersion={review.appliedVersion}
          stopped={stopped}
          applying={apply.isPending}
          applyError={
            apply.error instanceof ApiError ? apply.error.message : apply.error ? t("failed") : null
          }
          onApply={() => {
            apply.mutate();
          }}
        />
      )}
      {start.error ? <p className="m-0 text-sm text-neg-ink">{t("failed")}</p> : null}
      {review?.finishedAt != null && result?.status === "done" ? (
        <p className="m-0 text-xs text-muted">
          {t("footnote", { tested: result.tested, at: formatDateTime(review.finishedAt) })}
        </p>
      ) : null}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[12px] bg-surface-2 p-3">
      <span className="text-xs text-muted">{label}</span>
      <strong className="text-xl font-extrabold tabular-nums">{value}</strong>
      <span className="text-xs text-muted">{sub}</span>
    </div>
  );
}

function Result({
  r,
  appliedVersion,
  stopped,
  applying,
  applyError,
  onApply,
}: {
  r: Done;
  appliedVersion: number | null;
  stopped: boolean;
  applying: boolean;
  applyError: string | null;
  onApply: () => void;
}) {
  const t = useTranslations("agent.review");
  const feeShare =
    r.actual.costPerMillion > 0
      ? Math.min(100, (r.actual.feesPerMillion / r.actual.costPerMillion) * 100)
      : null;
  const changed = PARAM_KEYS.filter(
    (k) => paramText(r.current.params, k, t) !== paramText(r.best.params, k, t),
  );
  const taker = r.takerShare;
  // Kết quả lưu trước DEC-134 không có `suggestion`: suy từ `recommended`.
  const level = r.suggestion ?? (r.recommended ? "strong" : "none");
  const strong = level === "strong";
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          label={t("actual")}
          value={cost(r.actual.costPerMillion)}
          sub={t("actualSub", { trades: r.trades })}
        />
        <Stat label={t("current")} value={cost(r.current.costPerMillion)} sub={t("currentSub")} />
        <Stat
          label={t("best")}
          value={cost(r.best.costPerMillion)}
          sub={t("bestSub", {
            delta: signed(r.best.deltaPerMillion),
            low: signed(r.best.ciLow),
            high: signed(r.best.ciHigh),
          })}
        />
      </div>

      {r.trades < SOLID_TRADES && level === "none" ? (
        <p className="m-0 rounded-[12px] bg-warn-bg px-3 py-2 text-sm text-warn">
          {t("smallSample", { trades: r.trades, solid: SOLID_TRADES })}
        </p>
      ) : null}
      {level !== "none" ? (
        <div
          className={`flex flex-col gap-3 rounded-[12px] border p-4 ${
            strong ? "border-border bg-pos-bg" : "border-warn-bar bg-warn-bg"
          }`}
        >
          <strong className={`text-sm ${strong ? "text-pos" : "text-warn"}`}>
            {strong
              ? t("recommended", {
                  delta: usd(-r.best.deltaPerMillion),
                  high: usd(-r.best.ciHigh),
                })
              : t("weakTitle", { delta: usd(-r.best.deltaPerMillion) })}
          </strong>
          {strong ? null : (
            <p className="m-0 text-sm text-ink">
              {t("weakWarning", {
                trades: r.trades,
                low: signed(r.best.ciLow),
                high: signed(r.best.ciHigh),
              })}
            </p>
          )}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th scope="col" className="py-1 font-semibold">
                  {t("setting")}
                </th>
                <th scope="col" className="py-1 font-semibold">
                  {t("now")}
                </th>
                <th scope="col" className="py-1 font-semibold">
                  {t("suggested")}
                </th>
              </tr>
            </thead>
            <tbody>
              {changed.map((k) => (
                <tr key={k} className="border-t border-border">
                  <td className="py-1.5">{t(`param.${k}`)}</td>
                  <td className="py-1.5 text-ink-2 tabular-nums">
                    {paramText(r.current.params, k, t)}
                  </td>
                  <td className="py-1.5 font-bold tabular-nums">
                    {paramText(r.best.params, k, t)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {appliedVersion === null ? (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={applying}
                onClick={onApply}
                className="min-h-9 rounded-[10px] bg-ink px-4 text-[13px] font-bold text-surface disabled:opacity-60"
              >
                {applying ? t("applying") : strong ? t("apply") : t("applyAnyway")}
              </button>
              <span className="text-xs text-muted">
                {stopped ? t("applyStopped") : t("applyRunning")}
              </span>
            </div>
          ) : (
            <span className="text-sm text-ink-2">{t("applied", { version: appliedVersion })}</span>
          )}
          {applyError === null ? null : <span className="text-sm text-neg-ink">{applyError}</span>}
        </div>
      ) : (
        <div className="flex flex-col gap-1 rounded-[12px] bg-surface-2 p-4">
          <strong className="text-sm">{t("noBetter")}</strong>
          <span className="text-sm text-ink-2">
            {feeShare === null
              ? t("noBetterProfit")
              : t("noBetterFees", {
                  share: feeShare.toFixed(0),
                  fees: usd(r.actual.feesPerMillion),
                })}
          </span>
        </div>
      )}

      {taker.trades > 0 &&
      taker.takerCostPerMillion !== null &&
      taker.makerCostPerMillion !== null &&
      taker.takerCostPerMillion > taker.makerCostPerMillion ? (
        <p className="m-0 text-sm text-ink-2">
          {t("taker", {
            trades: taker.trades,
            taker: usd(taker.takerCostPerMillion),
            maker: usd(taker.makerCostPerMillion),
          })}
        </p>
      ) : null}
    </div>
  );
}
