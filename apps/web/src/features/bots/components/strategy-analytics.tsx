"use client";

import { botAnalyticsSchema, type AnalyticsPeriod, type BotAnalytics } from "@drift/shared";
import { Skeleton } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BarChart3 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { api } from "@/lib/api";

import {
  AreaLine,
  GroupBars,
  holdText,
  PeriodTabs,
  pctText,
  Stat,
  tone,
  TradeDetailSheet,
  usd,
} from "./analytics-parts";

// Thẻ Strategy Analytics ngay dưới bảng Volume (DEC-141): hiệu quả, thời gian giữ lệnh, lượt tốt / tệ nhất, nhận xét,
// chất lượng khớp. "View details" mở Deep Analytics với cùng kỳ.

export function useBotAnalytics(botId: string, period: AnalyticsPeriod) {
  return useQuery({
    queryKey: ["bot-analytics", botId, period],
    queryFn: () =>
      api("GET", `/api/v1/bots/${botId}/analytics?period=${period}`, botAnalyticsSchema),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });
}

function Box({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-[16px] border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-sm font-extrabold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function InsightList({ a }: { a: BotAnalytics }) {
  const t = useTranslations("agent.sa");
  const te = useTranslations("agent.sa.exit");
  if (a.insights.length === 0) return <p className="m-0 text-sm text-muted">{t("noInsights")}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
      {a.insights.map((i) => {
        const p: Record<string, string | number> = { ...i.params };
        if (typeof p.reason === "string") p.reason = te(p.reason);
        if (typeof p.avgNet === "number") p.avgNet = usd(p.avgNet);
        return (
          <li key={i.key} className="flex gap-2">
            <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
            <span className="text-ink-2">{t(`insight.${i.key}`, p)}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function StrategyAnalytics({ botId }: { botId: string }) {
  const t = useTranslations("agent.sa");
  const [period, setPeriod] = useState<AnalyticsPeriod>("d7");
  const [open, setOpen] = useState<string | null>(null);
  const q = useBotAnalytics(botId, period);
  const a = q.data;
  const best = a?.trades.find((x) => x.key === a.best);
  const worst = a?.trades.find((x) => x.key === a.worst);
  const top = a?.holding
    .filter(
      (h) => h.trades >= Math.max(3, Math.ceil((a.summary.trades || 1) * 0.1)) && h.avgNet !== null,
    )
    .sort((x, y) => (y.avgNet ?? 0) - (x.avgNet ?? 0))[0];
  const delta =
    a?.summary.prevNet === null || a?.summary.prevNet === undefined
      ? null
      : a.summary.net - a.summary.prevNet;

  return (
    <section
      aria-labelledby="sa-title"
      className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-10 items-center justify-center rounded-[12px] bg-accent-tint text-accent"
          >
            <BarChart3 size={20} strokeWidth={2.4} />
          </span>
          <div className="flex flex-col">
            <h2 id="sa-title" className="m-0 text-lg font-extrabold">
              {t("title")}
            </h2>
            <span className="text-xs text-muted">{t("subtitle")}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodTabs value={period} onChange={setPeriod} />
          <Link
            href={`/agent/${botId}/analytics?period=${period}`}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-[10px] border border-border px-3 text-[13px] font-bold text-ink no-underline hover:bg-surface-2"
          >
            {t("viewDetails")} <ArrowRight aria-hidden="true" size={14} />
          </Link>
        </div>
      </header>

      {a === undefined ? (
        <Skeleton className="h-64 w-full" />
      ) : !a.supported ? (
        <p className="m-0 text-sm text-muted">{t("unsupported")}</p>
      ) : a.summary.trades === 0 ? (
        <p className="m-0 text-sm text-muted">{t("noTrades")}</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <Box title={t("performance")}>
              <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
                <div className="flex flex-col">
                  <strong className={`text-3xl font-extrabold tabular-nums ${tone(a.summary.net)}`}>
                    {usd(a.summary.net)}{" "}
                    <span className="text-sm font-semibold text-muted">USDC</span>
                  </strong>
                  <span className="text-xs text-muted">
                    {delta === null
                      ? t("netSub", { n: a.summary.trades })
                      : t("vsPrev", { v: usd(delta) })}
                  </span>
                </div>
                <Stat
                  label={t("winRate")}
                  value={pctText(a.summary.winRateNet)}
                  sub={t("winGross", { v: pctText(a.summary.winRateGross) })}
                />
                <Stat
                  label={t("profitFactor")}
                  value={a.summary.profitFactor?.toFixed(2) ?? "—"}
                  sub={t("pfSub")}
                />
                <Stat
                  label={t("maxDd")}
                  value={usd(a.summary.maxDrawdown)}
                  valueClass="text-neg-ink"
                  sub="USDC"
                />
              </div>
              <AreaLine
                points={a.equity.map((e) => ({ t: e.t, v: e.net }))}
                height={150}
                label={t("equity")}
              />
            </Box>
            <Box title={t("holding")}>
              <div className="flex items-baseline justify-between gap-2">
                <strong className="text-xl font-extrabold">
                  {top === undefined ? "—" : t(`bucket.${top.bucket}`)}
                </strong>
                <span className="text-xs text-muted">
                  {top === undefined
                    ? t("holdingNone")
                    : t("holdingBest", { win: pctText(top.winRateNet), avg: usd(top.avgNet ?? 0) })}
                </span>
              </div>
              <GroupBars
                items={a.holding.map((h) => ({
                  key: h.bucket,
                  label: t(`bucket.${h.bucket}`),
                  value: h.winRateNet,
                  sub: t("tradesN", { n: h.trades }),
                }))}
                format={(v) => `${v.toFixed(0)}%`}
                selected={top?.bucket ?? null}
                height={170}
                label={t("holdingChart")}
              />
            </Box>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <Box title={t("bestWorst")}>
              {[best, worst].map((x, i) =>
                x === undefined ? null : (
                  <button
                    key={i === 0 ? "best" : "worst"}
                    type="button"
                    onClick={() => {
                      setOpen(x.key);
                    }}
                    className="flex flex-col items-start gap-0.5 rounded-[12px] border border-border px-3 py-2 text-left hover:bg-surface-2"
                  >
                    <span className={`text-xs font-bold ${i === 0 ? "text-pos" : "text-neg-ink"}`}>
                      {i === 0 ? t("best") : t("worst")}
                    </span>
                    <strong className={`text-lg tabular-nums ${tone(x.net)}`}>
                      {usd(x.net)} USDC
                    </strong>
                    <span className="text-xs text-muted tabular-nums">
                      {holdText(x.holdSecs)} · {x.side} · {x.entry.toLocaleString("en-US")} →{" "}
                      {x.exit.toLocaleString("en-US")}
                    </span>
                  </button>
                ),
              )}
            </Box>
            <Box title={t("insights")}>
              <InsightList a={a} />
            </Box>
            <Box title={t("execution")}>
              <div className="grid grid-cols-2 gap-3">
                <Stat label={t("makerRatio")} value={pctText(a.execution.makerRatioPct)} />
                <Stat
                  label={t("feePerTrade")}
                  value={
                    a.execution.feePerTrade === null
                      ? "—"
                      : `$${a.execution.feePerTrade.toFixed(4)}`
                  }
                />
                <Stat
                  label={t("fillRate")}
                  value={pctText(a.execution.fillRatePct)}
                  sub={t("fillSub", { f: a.execution.ordersFilled, p: a.execution.ordersPlaced })}
                />
                <Stat
                  label={t("feePerM")}
                  value={
                    a.execution.feePerMillion === null
                      ? "—"
                      : `$${a.execution.feePerMillion.toFixed(0)}`
                  }
                />
              </div>
            </Box>
          </div>
        </>
      )}
      <TradeDetailSheet
        botId={botId}
        tradeKey={open}
        onClose={() => {
          setOpen(null);
        }}
      />
    </section>
  );
}
