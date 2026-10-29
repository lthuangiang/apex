"use client";

import {
  BACKTEST_INTERVALS,
  BACKTEST_PERIODS,
  backtestViewSchema,
  dec,
  type BacktestPeriod,
  type BacktestResult,
} from "@drift/shared";
import { BacktestPanel, SegmentedControl } from "@drift/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { api, ApiError } from "@/lib/api";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { useMarketNames, type MarketNames } from "@/lib/markets";

import { FIELDS, toConfig, type FormValues } from "../fields";
import { fmtPrice, previewModel, unitsOf } from "../preview";

import { fieldErrorsOf } from "./bot-errors";
import { PreviewVisual } from "./preview-visual";

// Cột trái của màn tạo bot (artboard Create, SCREENS.md mục 8.2): tiêu đề + giá gần nhất, tab Preview
// (hình riêng của từng chiến lược + ô chỉ số) và Backtest (BACKTEST.md mục 11.1).
// Backtest chỉ chạy khi bấm; đổi field hoặc kỳ thì kết quả cũ hiện "Out of date · run again".

type Strategy = keyof typeof FIELDS;

function EquityChart({ result, label }: { result: BacktestResult; label: string }) {
  const pts = result.equity.map((p) => ({ x: p.at, y: Number(p.value) }));
  if (pts.length < 2) return null;
  const xs = pts.map((p) => p.x);
  const ys = [...pts.map((p) => p.y), Number(result.capital)];
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const W = 600;
  const H = 160;
  const sx = (x: number) => ((x - x0) / (x1 - x0 || 1)) * W;
  const sy = (y: number) => H - ((y - y0) / (y1 - y0 || 1)) * (H - 8) - 4;
  const line = pts.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const base = sy(Number(result.capital));
  return (
    <figure className="m-0 flex flex-col gap-1">
      <svg
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        className="h-40 w-full text-accent"
        role="img"
        aria-label={label}
      >
        <line
          x1="0"
          x2={W}
          y1={base}
          y2={base}
          className="stroke-muted"
          strokeDasharray="4 4"
          strokeWidth="1"
        />
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      <figcaption className="text-xs text-muted">{label}</figcaption>
    </figure>
  );
}

export function VisualPanel({
  strategy,
  values,
  last,
  inline = false,
}: {
  strategy: Strategy;
  /** Mobile: nằm trong form (UI_REVIEW G5); desktop: cột trái, dính đỉnh khi cuộn (G1). */
  inline?: boolean;
  values: FormValues;
  /** Giá gần nhất của market (null khi chưa chọn market hoặc SoDEX chưa có giá). */
  last: { price: string | null; at: number | null } | null;
}) {
  const t = useTranslations("createBot");
  const tb = useTranslations("createBot.backtest");
  const tr = useTranslations("reasons");
  const tp = useTranslations("createBot.preview");
  const ts = useTranslations(`createBot.strategies.${strategy}`);
  const names = useMarketNames();
  const [tab, setTab] = useState<"preview" | "backtest">("preview");
  const [period, setPeriod] = useState<BacktestPeriod>(90);
  const [runId, setRunId] = useState<string | null>(null);
  const [ranWith, setRanWith] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const config = toConfig(strategy, values);
  const signature = JSON.stringify([config, period]);

  const start = useMutation({
    mutationFn: () =>
      api("POST", "/api/v1/backtests", backtestViewSchema, {
        idempotencyKey: key.current,
        body: { strategy, config, periodDays: period },
      }),
    onSuccess: (v) => {
      setRunId(v.id);
      setRanWith(signature);
    },
    onSettled: () => {
      key.current = crypto.randomUUID();
    },
  });
  const run = useQuery({
    queryKey: ["backtest", runId],
    queryFn: () => api("GET", `/api/v1/backtests/${runId ?? ""}`, backtestViewSchema),
    enabled: runId !== null,
    refetchInterval: (q) =>
      q.state.data === undefined ||
      q.state.data.status === "queued" ||
      q.state.data.status === "running"
        ? 1_000
        : false,
  });

  const v = run.data;
  const result = v?.result ?? null;
  const busy = start.isPending || v?.status === "queued" || v?.status === "running";
  const invalid =
    start.error instanceof ApiError && Object.keys(fieldErrorsOf(start.error)).length > 0;
  const status = busy
    ? "loading"
    : v?.status === "done" && result !== null
      ? "ready"
      : v?.status === "failed" || (start.isError && !invalid)
        ? "error"
        : "empty";
  const stale = status === "ready" && ranWith !== signature;
  const intervalLabel = result === null ? "" : tb(`interval.${result.interval}`);
  const signed = (x: string) => formatMoney(x, true) ?? "";
  const metric = (m: BacktestResult["metrics"][number]) => {
    if (m.value === null) return null;
    if (m.unit === "pct") return `${dec(m.value).toDecimalPlaces(2).toString()}%`;
    if (m.unit === "quote") return signed(m.value);
    if (m.unit === "price") return formatMoney(m.value) ?? "";
    return m.value;
  };
  const metrics =
    result === null
      ? []
      : [
          {
            label: tb("stats.net"),
            value: `${signed(result.net)} · ${dec(result.netPct).toDecimalPlaces(2).toString()}%`,
          },
          {
            label: result.perps ? tb("stats.feesFunding") : tb("stats.fees"),
            value:
              formatMoney(
                result.perps ? dec(result.fees).add(result.funding).toString() : result.fees,
              ) ?? null,
          },
          {
            label: tb("stats.maxDd"),
            value: `−${dec(result.maxDrawdownPct).toDecimalPlaces(2).toString()}%`,
          },
          ...result.metrics.map((m) => ({ label: tb(`stats.${m.key}`), value: metric(m) })),
          ...(result.halted === null
            ? []
            : [{ label: tb("stats.halted"), value: tr(result.halted) }]),
        ];
  const unavailable =
    v?.status === "unavailable" ? tb(`unavailable.${v.error ?? "history_short"}`) : undefined;

  const model = previewModel(strategy, values, last?.price ?? null, Date.now());
  const title = visTitle(strategy, values, tp, ts, names);
  const marketLine =
    strategy === "rebalancing"
      ? tp("valuedIn", { quote: typeof values.quoteAsset === "string" ? values.quoteAsset : "" })
      : last === null
        ? null
        : last.price === null || last.at === null
          ? tp("lastMissing")
          : tp("lastLine", {
              price: fmtPrice(last.price),
              time: formatDateTime(last.at).split(", ").at(-1) ?? "",
            });

  return (
    <section
      aria-labelledby="vis-title"
      className={`flex min-w-0 flex-col gap-3.5 rounded-card border border-border bg-surface ${inline ? "p-3.5" : "sticky top-4 flex-[3_1_480px] self-start p-[18px]"}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="vis-title" className="m-0 text-[17px] font-extrabold">
          {title}
        </h2>
        {marketLine === null ? null : (
          <span className="text-[13px] text-ink-2 tabular-nums">{marketLine}</span>
        )}
      </div>
      <div
        role="tablist"
        aria-label={t("visual.label")}
        className="flex gap-1 self-start rounded-control bg-surface-2 p-1"
      >
        {(["preview", "backtest"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={`min-h-9 rounded-[9px] px-3.5 text-[13px] font-bold ${tab === k ? "bg-surface text-ink shadow-sm" : "text-ink-2"}`}
            onClick={() => {
              setTab(k);
            }}
          >
            {t(`visual.${k}`)}
          </button>
        ))}
      </div>
      {tab === "preview" ? (
        <PreviewVisual strategy={strategy} values={values} model={model} />
      ) : (
        <div className="flex flex-col gap-3">
          <SegmentedControl
            label={tb("periodsLabel")}
            options={BACKTEST_PERIODS.map((p) => ({
              value: String(p),
              label: tb("period", { days: p }),
            }))}
            value={String(period)}
            onValueChange={(p) => {
              setPeriod(Number(p) as BacktestPeriod);
            }}
          />
          {busy ? (
            <p role="status" className="m-0 text-sm text-ink-2">
              {v === undefined
                ? tb("queued")
                : tb("simulating", {
                    count: new Intl.NumberFormat("en-US").format(
                      (v.periodDays * 86_400_000) / BACKTEST_INTERVALS[v.interval],
                    ),
                    interval: tb(`interval.${v.interval}`),
                  })}
            </p>
          ) : null}
          <BacktestPanel
            title={tb("title")}
            disclaimer={tb("disclaimer")}
            status={status}
            runLabel={busy ? tb("running") : status === "ready" ? tb("again") : tb("run")}
            onRun={() => {
              start.mutate();
            }}
            {...(unavailable === undefined
              ? {}
              : { unavailableReason: `${tb("unavailableTitle")}. ${unavailable}` })}
            emptyTitle={tb("run")}
            emptyDescription={tb("intro")}
            errorTitle={invalid ? t("errors.invalid") : tb("failed")}
            metrics={metrics}
            missingLabel={tb("missing")}
            {...(stale ? { stale: { label: tb("outOfDate") } } : {})}
          />
          {result === null || status !== "ready" ? null : (
            <>
              <EquityChart result={result} label={tb("chart")} />
              <section className="flex flex-col gap-1 text-xs text-ink-2">
                <strong className="text-ink">{tb("assumptions")}</strong>
                <span>{tb("a1")}</span>
                <span>{tb("a2")}</span>
                <span>{tb("a3")}</span>
                <span>
                  {tb("a4", {
                    interval: intervalLabel,
                    from: formatDate(result.from, "UTC"),
                    to: formatDate(result.to, "UTC"),
                  })}
                </span>
              </section>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** Tiêu đề cột trái theo chiến lược (artboard Create `visTitle`); chưa chọn market thì dùng tên chiến lược. */
function visTitle(
  strategy: Strategy,
  v: FormValues,
  tp: (key: string, values?: Record<string, string>) => string,
  ts: (key: string) => string,
  names: MarketNames,
): string {
  const str = (k: string) => (typeof v[k] === "string" ? v[k] : "");
  const market = strategy === "funding_arb" ? str("asset") : names.market(str("market"));
  const base = names.asset(unitsOf(str("market"))?.base ?? "");
  if (strategy === "rebalancing") return tp("title.rebalancing");
  if (market === "") return ts("name");
  return tp(`title.${strategy}`, {
    market,
    direction: tp(`direction.${str("direction") || "long"}`),
    side: tp(`direction.${str("side") || "buy"}`),
    size: str("totalSize"),
    base,
  });
}
