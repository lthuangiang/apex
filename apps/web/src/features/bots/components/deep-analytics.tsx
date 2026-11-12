"use client";

import {
  ANALYTICS_PERIODS,
  botDetailSchema,
  EXIT_REASONS,
  HOLD_BUCKETS,
  type AnalyticsPeriod,
  type AnalyticsTrade,
  type BotAnalytics,
} from "@drift/shared";
import { Skeleton } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState, type ReactNode } from "react";

import { Workspace } from "@/components/workspace";
import { api } from "@/lib/api";

import {
  AreaLine,
  GroupBars,
  holdText,
  PeriodTabs,
  pctText,
  Stat,
  timeText,
  tone,
  TradeDetailSheet,
  usd,
} from "./analytics-parts";
import { InsightList, useBotAnalytics } from "./strategy-analytics";

// Deep Analytics (DEC-141, giai đoạn 1): cùng một bộ lọc kỳ (trên URL) cho mọi tab. Overview · Holding Time ·
// Trade Analysis · Execution; Market Insights và AI Analyst làm ở giai đoạn 2.

const TABS = ["overview", "holding", "trades", "execution", "market", "ai"] as const;
type Tab = (typeof TABS)[number];
const SOON: readonly Tab[] = ["market", "ai"];

function Card({ title, children, sub }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-base font-extrabold">{title}</h2>
        {sub === undefined ? null : <span className="text-xs text-muted">{sub}</span>}
      </div>
      {children}
    </section>
  );
}

interface Filters {
  result: "all" | "win" | "loss";
  side: "all" | "long" | "short";
  bucket: string;
  reason: string;
}
const NO_FILTER: Filters = { result: "all", side: "all", bucket: "all", reason: "all" };

export function DeepAnalytics({ botId }: { botId: string }) {
  const t = useTranslations("agent.sa");
  const router = useRouter();
  const params = useSearchParams();
  const rawP = params.get("period");
  const period: AnalyticsPeriod = (ANALYTICS_PERIODS as readonly string[]).includes(rawP ?? "")
    ? (rawP as AnalyticsPeriod)
    : "d7";
  const rawT = params.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(rawT ?? "") ? (rawT as Tab) : "overview";
  const [filters, setFilters] = useState<Filters>(NO_FILTER);
  const [open, setOpen] = useState<string | null>(null);
  const go = (p: AnalyticsPeriod, tb: Tab) => {
    router.replace(`/agent/${botId}/analytics?period=${p}&tab=${tb}`);
  };
  const bot = useQuery({
    queryKey: ["bot", botId],
    queryFn: () => api("GET", `/api/v1/bots/${botId}`, botDetailSchema),
  });
  const q = useBotAnalytics(botId, period);
  const a = q.data;
  const delta =
    a?.summary.prevNet === null || a?.summary.prevNet === undefined
      ? null
      : a.summary.net - a.summary.prevNet;

  return (
    <Workspace current="agent">
      <div className="flex flex-col gap-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link
              href={`/agent/${botId}`}
              aria-label={t("back")}
              className="flex size-10 items-center justify-center rounded-[12px] border border-border bg-surface text-ink"
            >
              <ArrowLeft aria-hidden="true" size={18} />
            </Link>
            <div className="flex flex-col">
              <h1 className="m-0 text-2xl font-extrabold">{bot.data?.bot.name ?? t("title")}</h1>
              <span className="text-xs text-muted">
                {t("deepSub", { market: bot.data?.bot.market ?? "" })}
              </span>
            </div>
          </div>
          <PeriodTabs
            value={period}
            onChange={(p) => {
              go(p, tab);
            }}
          />
        </header>

        {a === undefined ? (
          <Skeleton className="h-96 w-full" />
        ) : !a.supported ? (
          <Card title={t("title")}>
            <p className="m-0 text-sm text-muted">{t("unsupported")}</p>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi
                label={t("netPnl")}
                value={`${usd(a.summary.net)} USDC`}
                cls={tone(a.summary.net)}
                sub={
                  delta === null
                    ? t("netSub", { n: a.summary.trades })
                    : t("vsPrev", { v: usd(delta) })
                }
              />
              <Kpi
                label={t("winRate")}
                value={pctText(a.summary.winRateNet)}
                sub={t("winGross", { v: pctText(a.summary.winRateGross) })}
              />
              <Kpi
                label={t("profitFactor")}
                value={a.summary.profitFactor?.toFixed(2) ?? "—"}
                sub={t("pfSub")}
              />
              <Kpi
                label={t("maxDd")}
                value={`${usd(a.summary.maxDrawdown)} USDC`}
                cls="text-neg-ink"
                sub={t("ddSub")}
              />
            </div>

            <div
              role="tablist"
              aria-label={t("tabsLabel")}
              className="flex flex-wrap gap-1 border-b border-border"
            >
              {TABS.map((k) => {
                const soon = SOON.includes(k);
                return (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={tab === k}
                    disabled={soon}
                    onClick={() => {
                      go(period, k);
                    }}
                    className={`-mb-px min-h-11 border-b-2 px-3 text-sm font-bold ${
                      tab === k
                        ? "border-accent text-accent-ink"
                        : "border-transparent text-ink-2 hover:text-ink"
                    } disabled:cursor-not-allowed disabled:text-muted`}
                  >
                    {t(`tab.${k}`)}
                    {soon ? (
                      <span className="ml-1 text-[10px] font-extrabold text-muted">
                        {t("soon")}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {a.summary.trades === 0 ? (
              <Card title={t("title")}>
                <p className="m-0 text-sm text-muted">{t("noTrades")}</p>
              </Card>
            ) : tab === "overview" ? (
              <Overview a={a} />
            ) : tab === "holding" ? (
              <Holding
                a={a}
                onPick={(bucket) => {
                  setFilters({ ...NO_FILTER, bucket });
                  go(period, "trades");
                }}
              />
            ) : tab === "trades" ? (
              <Trades a={a} filters={filters} setFilters={setFilters} onOpen={setOpen} />
            ) : (
              <Execution a={a} />
            )}
          </>
        )}
      </div>
      <TradeDetailSheet
        botId={botId}
        tradeKey={open}
        onClose={() => {
          setOpen(null);
        }}
      />
    </Workspace>
  );
}

function Kpi({
  label,
  value,
  sub,
  cls,
}: {
  label: string;
  value: string;
  sub: string;
  cls?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-card border border-border bg-surface p-4">
      <span className="text-xs font-bold text-muted">{label}</span>
      <strong className={`text-2xl font-extrabold tabular-nums ${cls ?? ""}`}>{value}</strong>
      <span className="text-xs text-muted">{sub}</span>
    </div>
  );
}

function Overview({ a }: { a: BotAnalytics }) {
  const t = useTranslations("agent.sa");
  const wins = a.trades.filter((x) => x.net > 0);
  const losses = a.trades.filter((x) => x.net < 0);
  const avg = (xs: AnalyticsTrade[]) =>
    xs.length === 0 ? null : xs.reduce((n, x) => n + x.net, 0) / xs.length;
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Card title={t("equity")} sub={t("equitySub")}>
        <AreaLine
          points={a.equity.map((e) => ({ t: e.t, v: e.net }))}
          height={240}
          label={t("equity")}
        />
      </Card>
      <div className="flex flex-col gap-3">
        <Card title={t("winLoss")}>
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label={t("wins")}
              value={String(wins.length)}
              valueClass="text-pos"
              sub={t("avg", { v: avg(wins) === null ? "—" : usd(avg(wins) ?? 0) })}
            />
            <Stat
              label={t("losses")}
              value={String(losses.length)}
              valueClass="text-neg-ink"
              sub={t("avg", { v: avg(losses) === null ? "—" : usd(avg(losses) ?? 0) })}
            />
            <Stat
              label={t("grossPnl")}
              value={usd(a.summary.gross)}
              valueClass={tone(a.summary.gross)}
              sub={t("beforeFees")}
            />
            <Stat
              label={t("fees")}
              value={usd(-a.summary.fees)}
              valueClass="text-neg-ink"
              sub={t("feesSub")}
            />
          </div>
        </Card>
        <Card title={t("insights")}>
          <InsightList a={a} />
        </Card>
      </div>
    </div>
  );
}

function Holding({ a, onPick }: { a: BotAnalytics; onPick: (bucket: string) => void }) {
  const t = useTranslations("agent.sa");
  const [metric, setMetric] = useState<"win" | "pnl">("win");
  const total = Math.max(1, a.summary.trades);
  const winners = a.trades.filter((x) => x.net > 0);
  const losers = a.trades.filter((x) => x.net <= 0);
  const avgHold = (xs: AnalyticsTrade[]) =>
    xs.length === 0 ? null : Math.round(xs.reduce((n, x) => n + x.holdSecs, 0) / xs.length);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title={metric === "win" ? t("winByHold") : t("pnlByHold")} sub={t("clickBucket")}>
          <div className="flex gap-1 self-start rounded-[12px] bg-surface-2 p-1">
            {(["win", "pnl"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={metric === m}
                onClick={() => {
                  setMetric(m);
                }}
                className={`min-h-8 rounded-[9px] px-3 text-xs font-bold ${metric === m ? "bg-accent text-white" : "text-ink-2"}`}
              >
                {m === "win" ? t("winRate") : t("avgNet")}
              </button>
            ))}
          </div>
          <GroupBars
            items={a.holding.map((h) => ({
              key: h.bucket,
              label: t(`bucket.${h.bucket}`),
              value: metric === "win" ? h.winRateNet : h.avgNet,
              sub: t("tradesN", { n: h.trades }),
            }))}
            format={(v) => (metric === "win" ? `${v.toFixed(0)}%` : usd(v))}
            onPick={onPick}
            height={240}
            label={t("winByHold")}
          />
        </Card>
        <Card title={t("holdStats")}>
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label={t("avgHold")}
              value={a.summary.avgHoldSecs === null ? "—" : holdText(a.summary.avgHoldSecs)}
            />
            <Stat
              label={t("medianHold")}
              value={a.summary.medianHoldSecs === null ? "—" : holdText(a.summary.medianHoldSecs)}
            />
            <Stat
              label={t("winnersHold")}
              value={avgHold(winners) === null ? "—" : holdText(avgHold(winners) ?? 0)}
            />
            <Stat
              label={t("losersHold")}
              value={avgHold(losers) === null ? "—" : holdText(avgHold(losers) ?? 0)}
            />
          </div>
        </Card>
      </div>
      <Card title={t("byHoldTable")}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm tabular-nums">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th scope="col" className="py-2 pr-3 font-bold">
                  {t("colHold")}
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-bold">
                  {t("colTrades")}
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-bold">
                  {t("colShare")}
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-bold">
                  {t("colWinGross")}
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-bold">
                  {t("colWinNet")}
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-bold">
                  {t("colAvgNet")}
                </th>
                <th scope="col" className="py-2 text-right font-bold">
                  {t("colTotalNet")}
                </th>
              </tr>
            </thead>
            <tbody>
              {a.holding.map((h) => (
                <tr key={h.bucket} className="border-t border-border">
                  <td className="py-2 pr-3">
                    <button
                      type="button"
                      disabled={h.trades === 0}
                      onClick={() => {
                        onPick(h.bucket);
                      }}
                      className="font-bold text-accent-ink underline-offset-2 hover:underline disabled:text-muted disabled:no-underline"
                    >
                      {t(`bucket.${h.bucket}`)}
                    </button>
                  </td>
                  <td className="py-2 pr-3 text-right">{h.trades}</td>
                  <td className="py-2 pr-3 text-right">{((h.trades / total) * 100).toFixed(0)}%</td>
                  <td className="py-2 pr-3 text-right">{pctText(h.winRateGross)}</td>
                  <td className="py-2 pr-3 text-right">{pctText(h.winRateNet)}</td>
                  <td className={`py-2 pr-3 text-right ${tone(h.avgNet ?? 0)}`}>
                    {h.avgNet === null ? "—" : usd(h.avgNet)}
                  </td>
                  <td className={`py-2 text-right ${tone(h.totalNet)}`}>{usd(h.totalNet)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-bold text-muted">
      {label}
      <select
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className="min-h-10 rounded-[10px] border border-border-input bg-surface px-2 text-sm font-semibold text-ink"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Trades({
  a,
  filters,
  setFilters,
  onOpen,
}: {
  a: BotAnalytics;
  filters: Filters;
  setFilters: (f: Filters) => void;
  onOpen: (key: string) => void;
}) {
  const t = useTranslations("agent.sa");
  const te = useTranslations("agent.sa.exit");
  const [sort, setSort] = useState<"time" | "net" | "hold">("time");
  const rows = useMemo(() => {
    const xs = a.trades.filter(
      (x) =>
        (filters.result === "all" || (filters.result === "win" ? x.net > 0 : x.net <= 0)) &&
        (filters.side === "all" || x.side === filters.side) &&
        (filters.bucket === "all" || x.bucket === filters.bucket) &&
        (filters.reason === "all" || x.exitReason === filters.reason),
    );
    return [...xs].sort((p, q) =>
      sort === "net"
        ? q.net - p.net
        : sort === "hold"
          ? q.holdSecs - p.holdSecs
          : q.closedAt - p.closedAt,
    );
  }, [a.trades, filters, sort]);
  const sum = rows.reduce((n, x) => n + x.net, 0);
  return (
    <Card title={t("tradeList")} sub={t("tradeListSub", { n: rows.length, net: usd(sum) })}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Select
          label={t("fResult")}
          value={filters.result}
          onChange={(v) => {
            setFilters({ ...filters, result: v as Filters["result"] });
          }}
          options={[
            { value: "all", label: t("all") },
            { value: "win", label: t("winning") },
            { value: "loss", label: t("losing") },
          ]}
        />
        <Select
          label={t("fSide")}
          value={filters.side}
          onChange={(v) => {
            setFilters({ ...filters, side: v as Filters["side"] });
          }}
          options={[
            { value: "all", label: t("all") },
            { value: "long", label: "Long" },
            { value: "short", label: "Short" },
          ]}
        />
        <Select
          label={t("fHold")}
          value={filters.bucket}
          onChange={(v) => {
            setFilters({ ...filters, bucket: v });
          }}
          options={[
            { value: "all", label: t("all") },
            ...HOLD_BUCKETS.map((h) => ({ value: h.key, label: t(`bucket.${h.key}`) })),
          ]}
        />
        <Select
          label={t("fExit")}
          value={filters.reason}
          onChange={(v) => {
            setFilters({ ...filters, reason: v });
          }}
          options={[
            { value: "all", label: t("all") },
            ...EXIT_REASONS.map((r) => ({ value: r, label: te(r) })),
          ]}
        />
        <Select
          label={t("fSort")}
          value={sort}
          onChange={(v) => {
            setSort(v as typeof sort);
          }}
          options={[
            { value: "time", label: t("sortTime") },
            { value: "net", label: t("sortNet") },
            { value: "hold", label: t("sortHold") },
          ]}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-sm tabular-nums">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th scope="col" className="py-2 pr-3 font-bold">
                {t("colClosed")}
              </th>
              <th scope="col" className="py-2 pr-3 font-bold">
                {t("colSide")}
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-bold">
                {t("colEntryExit")}
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-bold">
                {t("colHold")}
              </th>
              <th scope="col" className="py-2 pr-3 font-bold">
                {t("colExit")}
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-bold">
                {t("colMfeMae")}
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-bold">
                {t("colGross")}
              </th>
              <th scope="col" className="py-2 text-right font-bold">
                {t("colNet")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 500).map((x) => (
              <tr key={x.key} className="border-t border-border hover:bg-surface-2">
                <td className="py-2 pr-3">
                  <button
                    type="button"
                    onClick={() => {
                      onOpen(x.key);
                    }}
                    className="font-bold text-accent-ink hover:underline"
                  >
                    {timeText(x.closedAt)}
                  </button>
                </td>
                <td className="py-2 pr-3 capitalize">{x.side}</td>
                <td className="py-2 pr-3 text-right">
                  {x.entry.toLocaleString("en-US")} → {x.exit.toLocaleString("en-US")}
                </td>
                <td className="py-2 pr-3 text-right">{holdText(x.holdSecs)}</td>
                <td className="py-2 pr-3">{te(x.exitReason)}</td>
                <td className="py-2 pr-3 text-right text-ink-2">
                  {x.mfePct === null
                    ? "—"
                    : `${x.mfePct.toFixed(3)}% / ${(x.maePct ?? 0).toFixed(3)}%`}
                </td>
                <td className={`py-2 pr-3 text-right ${tone(x.gross)}`}>{usd(x.gross)}</td>
                <td className={`py-2 text-right font-bold ${tone(x.net)}`}>{usd(x.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 500 ? <p className="m-0 text-xs text-muted">{t("first500")}</p> : null}
    </Card>
  );
}

function Execution({ a }: { a: BotAnalytics }) {
  const t = useTranslations("agent.sa");
  const te = useTranslations("agent.sa.exit");
  const e = a.execution;
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <Card title={t("execution")}>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label={t("makerRatio")} value={pctText(e.makerRatioPct)} sub={t("makerSub")} />
          <Stat
            label={t("fillRate")}
            value={pctText(e.fillRatePct)}
            sub={t("fillSub", { f: e.ordersFilled, p: e.ordersPlaced })}
          />
          <Stat label={t("rejected")} value={String(e.rejected)} sub={t("rejectedSub")} />
          <Stat
            label={t("feePerTrade")}
            value={e.feePerTrade === null ? "—" : `$${e.feePerTrade.toFixed(4)}`}
          />
          <Stat
            label={t("feePerM")}
            value={e.feePerMillion === null ? "—" : `$${e.feePerMillion.toFixed(0)}`}
          />
          <Stat label={t("volume")} value={`${a.summary.volume.toLocaleString("en-US")} USDC`} />
        </div>
      </Card>
      <Card title={t("exitsTitle")}>
        <table className="w-full border-collapse text-sm tabular-nums">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th scope="col" className="py-2 pr-3 font-bold">
                {t("colExit")}
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-bold">
                {t("colTrades")}
              </th>
              <th scope="col" className="py-2 text-right font-bold">
                {t("colAvgNet")}
              </th>
            </tr>
          </thead>
          <tbody>
            {a.exits.map((x) => (
              <tr key={x.reason} className="border-t border-border">
                <td className="py-2 pr-3">{te(x.reason)}</td>
                <td className="py-2 pr-3 text-right">{x.trades}</td>
                <td className={`py-2 text-right ${tone(x.avgNet)}`}>{usd(x.avgNet)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
