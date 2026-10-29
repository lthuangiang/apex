"use client";

import {
  analysisViewSchema,
  dec,
  findings,
  HOLDING_BUCKETS,
  type AnalysisView,
  type Finding,
} from "@drift/shared";
import { EmptyState, ErrorState, Skeleton } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { api } from "@/lib/api";
import {
  formatDate,
  formatDuration,
  formatInteger,
  formatMoney,
  formatRatio,
  shortAddress,
} from "@/lib/format";
import { useMarketNames } from "@/lib/markets";
import { useSodexConnection } from "@/lib/queries";

// Onboarding 4 (artboard "Onboarding 4 · Account analysis"). Chỉ số liệu đã chốt; không tính PnL
// chưa chốt và ghi rõ điều đó (SCREENS.md mục 8.1). Thiếu số thì "Not available", không bao giờ 0.

type Metrics = NonNullable<AnalysisView["analysis"]>["metrics"];
const DAY = 86_400_000;

export function AnalysisReport() {
  const names = useMarketNames();
  const t = useTranslations("onboarding.analysis");
  const tc = useTranslations("common.errors");
  const tm = useTranslations("common.missing");
  const query = useQuery({
    queryKey: ["analysis", "latest"],
    queryFn: () => api("GET", "/api/v1/analysis/latest", analysisViewSchema),
  });
  const connection = useSodexConnection();

  if (query.isPending) return <Skeleton className="h-[48rem] rounded-card" />;
  if (query.isError)
    return (
      <ErrorState
        title={tc("generic")}
        retryLabel={tc("retry")}
        onRetry={() => void query.refetch()}
      />
    );
  const analysis = query.data.analysis;
  const nav = (
    <div className="flex items-center justify-between gap-3">
      <Link href="/onboarding/import" className="text-sm font-bold text-accent no-underline">
        {t("back")}
      </Link>
      <Link
        href="/onboarding/goals"
        className="inline-flex min-h-tap items-center rounded-control bg-accent px-5 text-sm font-bold text-surface no-underline"
      >
        {t("next")}
      </Link>
    </div>
  );
  if (analysis === null)
    return (
      <>
        <EmptyState title={t("waiting")} />
        {nav}
      </>
    );
  const m = analysis.metrics;
  const na = tm("notAvailable");
  const address = connection.data?.connection?.address;
  const days =
    m.periodStart === null || m.periodEnd === null
      ? null
      : Math.max(1, Math.round((m.periodEnd - m.periodStart) / DAY));
  const ofGross = (part: string) =>
    dec(m.grossRealizedPnl).gt(0)
      ? t("ofGross", { pct: formatRatio(dec(part).div(m.grossRealizedPnl).toString()) ?? na })
      : null;
  const wins = m.winRate === null ? null : Math.round(Number(m.winRate) * m.closedPositions);

  return (
    <>
      <header className="flex flex-col gap-2">
        <span className="text-xs font-extrabold tracking-[0.08em] text-accent">{t("step")}</span>
        <h1 className="m-0 text-[26px] font-extrabold md:text-[30px]">{t("title")}</h1>
        {address === undefined ||
        m.periodStart === null ||
        m.periodEnd === null ||
        days === null ? null : (
          <p className="m-0 text-sm text-ink-2 tabular-nums">
            {t("subtitle", {
              address: shortAddress(address),
              from: formatDate(m.periodStart),
              to: formatDate(m.periodEnd),
              days,
            })}
          </p>
        )}
      </header>

      {m.closedPositions === 0 ? <EmptyState title={t("empty")} /> : null}
      {m.isNewTrader && m.closedPositions > 0 ? (
        <p className="m-0 rounded-control bg-surface-2 px-4 py-3 text-sm text-ink-2">
          {t("newTrader")}
        </p>
      ) : null}

      <section
        aria-labelledby="pnl-h"
        className="flex flex-col gap-4 rounded-card bg-hero p-5 tabular-nums"
      >
        <h2 id="pnl-h" className="m-0 text-base font-extrabold">
          {t("pnlTitle")}
        </h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            label={t("gross")}
            value={formatMoney(m.grossRealizedPnl, true) ?? na}
            sub={t("grossSub")}
            tone={dec(m.grossRealizedPnl).gte(0) ? "pos" : "neg"}
          />
          <Tile
            label={t("fees")}
            value={formatMoney(dec(m.fees).neg().toString(), true) ?? na}
            sub={ofGross(m.fees)}
            tone="neg"
          />
          <Tile
            label={t("funding")}
            value={formatMoney(dec(m.netFunding).neg().toString(), true) ?? na}
            sub={ofGross(m.netFunding)}
            tone={dec(m.netFunding).gt(0) ? "neg" : "pos"}
          />
          <Tile
            label={t("net")}
            value={formatMoney(m.netPnl, true) ?? na}
            sub={t("netSub")}
            tone="dark"
          />
        </div>
        <dl className="m-0 grid gap-3 rounded-tile bg-surface/85 p-4 text-sm sm:grid-cols-2 lg:grid-cols-5">
          <Stat
            label={t("winRate")}
            value={
              m.winRate === null
                ? na
                : `${formatRatio(m.winRate) ?? na} · ${t("winRateOf", { wins: formatInteger(wins ?? 0), total: formatInteger(m.closedPositions) })}`
            }
          />
          <Stat
            label={t("avgWinLoss")}
            value={`${formatMoney(m.avgWin, true) ?? na} / ${formatMoney(m.avgLoss, true) ?? na}`}
          />
          <Stat
            label={t("maxDrawdown")}
            value={
              m.maxDrawdownPct === null
                ? na
                : `−${formatRatio(m.maxDrawdownPct, 1) ?? na}${m.drawdownFrom === null || m.drawdownTo === null ? "" : ` · ${formatDate(m.drawdownFrom)} – ${formatDate(m.drawdownTo)}`}`
            }
          />
          <Stat
            label={t("medianLeverage")}
            value={
              m.medianLeverage === null
                ? na
                : `${String(m.medianLeverage)}× · ${t("maxLeverage", { value: String(m.maxLeverage ?? m.medianLeverage) })}`
            }
          />
          <Stat
            label={t("makerTaker")}
            value={
              m.takerRatio === null
                ? na
                : `${formatRatio(dec("1").sub(m.takerRatio).toString()) ?? na} / ${formatRatio(m.takerRatio) ?? na}`
            }
          />
        </dl>
      </section>

      {m.curve.length > 1 ? <Curve metrics={m} /> : null}

      <section aria-labelledby="find-h" className="flex flex-col gap-3">
        <h2 id="find-h" className="m-0 text-lg font-extrabold">
          {t("findingsTitle")}
        </h2>
        <FindingsList list={findings(m)} />
      </section>

      <section
        aria-labelledby="mkt-h"
        className="flex flex-col gap-3 rounded-card border border-border p-5"
      >
        <h2 id="mkt-h" className="m-0 text-base font-extrabold">
          {t("marketTitle")}
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm tabular-nums">
            <thead className="text-xs text-muted">
              <tr>
                <th scope="col" className="py-2">
                  {t("market")}
                </th>
                <th scope="col">{t("volumeShare")}</th>
                <th scope="col">{t("winRate")}</th>
                <th scope="col">{t("fees2")}</th>
                <th scope="col" className="text-right">
                  {t("netPnl")}
                </th>
              </tr>
            </thead>
            <tbody>
              {[...m.byMarket]
                .sort((a, b) => Number(b.volumeShare) - Number(a.volumeShare))
                .map((row) => (
                  <tr key={row.market} className="border-t border-border">
                    <td className="py-2 font-bold">{names.market(row.market)}</td>
                    <td>{formatRatio(row.volumeShare) ?? na}</td>
                    <td>{formatRatio(row.winRate) ?? na}</td>
                    <td>{formatMoney(row.fees) ?? na}</td>
                    <td
                      className={`text-right font-bold ${dec(row.netPnl).gte(0) ? "text-pos" : "text-neg-ink"}`}
                    >
                      {formatMoney(row.netPnl, true) ?? na}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      <HoldingBars metrics={m} />
      <p className="m-0 text-xs leading-normal text-muted">
        {t("unrealized")} {t("disclaimer")}
      </p>
      {nav}
    </>
  );
}

function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string | null;
  tone: "pos" | "neg" | "dark";
}) {
  const cls = tone === "dark" ? "bg-ink text-surface" : "bg-surface/85";
  const valueCls = tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg-ink" : "";
  return (
    <div className={`flex flex-col gap-1 rounded-tile p-3.5 ${cls}`}>
      <span className="text-xs font-semibold opacity-80">{label}</span>
      <span className={`text-xl font-extrabold break-words ${valueCls}`}>{value}</span>
      {sub === null ? null : <span className="text-xs opacity-80">{sub}</span>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="m-0 font-bold break-words">{value}</dd>
    </div>
  );
}

function Curve({ metrics }: { metrics: Metrics }) {
  const t = useTranslations("onboarding.analysis");
  const pts = metrics.curve.map((p) => ({ at: p.at, v: Number(p.cumulative) }));
  const minV = Math.min(0, ...pts.map((p) => p.v));
  const maxV = Math.max(0, ...pts.map((p) => p.v));
  const t0 = pts[0]?.at ?? 0;
  const t1 = pts.at(-1)?.at ?? 1;
  const x = (at: number) => ((at - t0) / Math.max(1, t1 - t0)) * 700;
  const y = (v: number) => 190 - ((v - minV) / Math.max(1e-9, maxV - minV)) * 180;
  const last = metrics.curve.at(-1)?.cumulative ?? "0";
  return (
    <section
      aria-labelledby="curve-h"
      className="flex flex-col gap-3 rounded-card border border-border p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="curve-h" className="m-0 text-base font-extrabold">
          {t("curveTitle")}
        </h2>
        <span className="text-xs text-muted">{t("curveSub")}</span>
      </div>
      <svg
        viewBox="0 0 700 200"
        preserveAspectRatio="none"
        role="img"
        aria-label={t("curveLabel", { start: "0", end: formatMoney(last, true) ?? "" })}
        className="h-40 w-full rounded-control bg-surface-2"
      >
        <line
          x1="0"
          x2="700"
          y1={y(0)}
          y2={y(0)}
          className="stroke-border"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={pts.map((p) => `${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}
          fill="none"
          className="stroke-accent"
          strokeWidth="2.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex justify-between text-[11px] text-muted tabular-nums">
        <span>{formatDate(t0)}</span>
        <span>{formatDate(t1)}</span>
      </div>
    </section>
  );
}

function FindingsList({ list }: { list: Finding[] }) {
  const t = useTranslations("onboarding.analysis");
  const tb = useTranslations("onboarding.analysis.buckets");
  const tm = useTranslations("common.missing");
  const na = tm("notAvailable");
  if (list.length === 0) return <p className="m-0 text-sm text-ink-2">{t("noFindings")}</p>;
  const card = (key: Finding["kind"], tone: string, title: string, body: string) => (
    <article
      key={key}
      className="flex flex-col gap-2 rounded-tile border border-border bg-surface p-4"
    >
      <span
        className={`self-start rounded-full px-2.5 py-0.5 text-[11px] font-extrabold tracking-[0.06em] ${tone}`}
      >
        {t(`${key}.tag`)}
      </span>
      <h3 className="m-0 text-[15px] font-extrabold">{title}</h3>
      <p className="m-0 text-[13px] leading-normal text-ink-2">{body}</p>
      <p className="m-0 border-t border-dashed border-border pt-2 text-xs leading-normal text-accent-ink">
        <strong>{t("botChange")}</strong> {t(`${key}.bot`)}
      </p>
    </article>
  );
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {list.map((f) => {
        switch (f.kind) {
          case "costs":
            return card(
              "costs",
              "bg-warn-bg text-warn",
              t("costs.title", { pct: formatRatio(f.feeShare) ?? na }),
              t("costs.body", {
                fees: formatMoney(f.fees) ?? na,
                gross: formatMoney(f.gross) ?? na,
                taker: formatRatio(f.takerRatio) ?? na,
              }),
            );
          case "holding":
            return card(
              "holding",
              "bg-accent-tint text-accent-ink",
              t("holding.title"),
              t("holding.body", {
                shortCount: formatInteger(f.shortClosed),
                shortNet: formatMoney(dec(f.shortNet).abs().toString()) ?? na,
                bestCount: formatInteger(f.bestClosed),
                bucket: tb(f.bestBucket),
                bestNet: formatMoney(f.bestNet) ?? na,
              }),
            );
          case "exits":
            return card(
              "exits",
              "bg-unknown-bg text-unknown",
              t("exits.title", { ratio: f.ratio }),
              t("exits.body", {
                losers: formatDuration(f.losersMs),
                winners: formatDuration(f.winnersMs),
              }),
            );
          case "leverage":
            return card(
              "leverage",
              "bg-neg-bg text-neg-ink",
              t("leverage.title"),
              t("leverage.body", {
                positions: formatRatio(f.positionShare) ?? na,
                losses: formatRatio(f.lossShare) ?? na,
              }),
            );
        }
      })}
    </div>
  );
}

function HoldingBars({ metrics }: { metrics: Metrics }) {
  const t = useTranslations("onboarding.analysis");
  const tb = useTranslations("onboarding.analysis.buckets");
  const rows = HOLDING_BUCKETS.map((b) => ({ b, ...metrics.pnlByHolding[b] })).filter(
    (r) => r.closed > 0,
  );
  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(Number(r.netPnl))));
  return (
    <section
      aria-labelledby="hold-h"
      className="flex flex-col gap-3 rounded-card border border-border p-5"
    >
      <h2 id="hold-h" className="m-0 text-base font-extrabold">
        {t("holdingTitle")}
      </h2>
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm tabular-nums">
        {rows.map((r) => {
          const v = Number(r.netPnl);
          const w = `${String((Math.abs(v) / max) * 50)}%`;
          return (
            <li key={r.b} className="grid grid-cols-[6rem_1fr_6.5rem] items-center gap-2">
              <span>{tb(r.b)}</span>
              <span className="relative h-3 rounded-full bg-surface-2">
                <span className="absolute top-0 left-1/2 h-3 w-px bg-ink-2" />
                <span
                  className={`absolute top-0 h-3 rounded-full ${v < 0 ? "bg-neg" : "bg-accent"}`}
                  style={v < 0 ? { right: "50%", width: w } : { left: "50%", width: w }}
                />
              </span>
              <span className={`text-right font-bold ${v < 0 ? "text-neg-ink" : "text-pos"}`}>
                {formatMoney(r.netPnl, true)}
              </span>
            </li>
          );
        })}
      </ul>
      <span className="text-xs text-muted">{t("holdingNote")}</span>
    </section>
  );
}
