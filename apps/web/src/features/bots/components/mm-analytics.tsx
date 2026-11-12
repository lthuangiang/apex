"use client";

import type { AnalyticsPeriod, MmAnalytics } from "@drift/shared";
import { Skeleton } from "@drift/ui";
import { BarChart3 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { AreaLine, GroupBars, PeriodTabs, pctText, Stat } from "./analytics-parts";
import { useBotAnalytics } from "./strategy-analytics";

// Analytics của Market Making (DEC-144): khớp bất lợi theo thời gian sau khi khớp (chỉ số chính để so Smart quoting
// bật / tắt), thực thi, tồn kho và nhận xét tính thẳng từ số.

function Box({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-[16px] border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 text-sm font-extrabold">{title}</h3>
        {sub === undefined ? null : <span className="text-xs text-muted">{sub}</span>}
      </div>
      {children}
    </section>
  );
}

const bpText = (v: number | null) =>
  v === null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)} bp`;
const bpTone = (v: number | null) => (v === null ? "" : v < 0 ? "text-neg-ink" : "text-pos");

function AdverseTable({ m }: { m: MmAnalytics }) {
  const t = useTranslations("agent.mma");
  const rows: { label: string; fills: number; adv: MmAnalytics["adverse"] }[] = [
    { label: t("allQuotes"), fills: m.quoteFills, adv: m.adverse },
    ...m.bySide.map((s) => ({ label: t(`side.${s.side}`), fills: s.fills, adv: s.adverse })),
    ...m.smart.map((g) => ({
      label: g.on ? t("smartOn") : t("smartOff"),
      fills: g.fills,
      adv: g.adverse,
    })),
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[460px] border-collapse text-sm tabular-nums">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th scope="col" className="py-2 pr-3 font-bold">
              {t("colGroup")}
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-bold">
              {t("colFills")}
            </th>
            {m.adverse.map((a) => (
              <th key={a.minutes} scope="col" className="py-2 pr-3 text-right font-bold">
                {t("colAfter", { m: a.minutes })}
              </th>
            ))}
            <th scope="col" className="py-2 text-right font-bold">
              {t("colAgainst")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-border">
              <td className="py-2 pr-3 font-bold">{r.label}</td>
              <td className="py-2 pr-3 text-right">{r.fills}</td>
              {r.adv.map((a) => (
                <td key={a.minutes} className={`py-2 pr-3 text-right ${bpTone(a.bp)}`}>
                  {bpText(a.bp)}
                </td>
              ))}
              <td className="py-2 text-right">{pctText(r.adv[0]?.againstPct ?? null)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MmAnalyticsCard({ botId }: { botId: string }) {
  const t = useTranslations("agent.mma");
  const ts = useTranslations("agent.sa");
  const [period, setPeriod] = useState<AnalyticsPeriod>("d7");
  const q = useBotAnalytics(botId, period);
  const a = q.data;
  const m = a?.mm ?? null;
  return (
    <section
      aria-labelledby="mma-title"
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
            <h2 id="mma-title" className="m-0 text-lg font-extrabold">
              {t("title")}
            </h2>
            <span className="text-xs text-muted">{t("subtitle")}</span>
          </div>
        </div>
        <PeriodTabs value={period} onChange={setPeriod} />
      </header>
      {a === undefined ? (
        <Skeleton className="h-64 w-full" />
      ) : m === null || m.fills === 0 ? (
        <p className="m-0 text-sm text-muted">{t("noFills")}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 rounded-[16px] border border-border p-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label={t("volume")} value={m.volume.toLocaleString("en-US")} sub="USDC" />
            <Stat
              label={t("feePerM")}
              value={m.feePerMillion === null ? "—" : `$${m.feePerMillion.toFixed(0)}`}
              sub={t("feesSub", { b: m.builderFees.toFixed(4) })}
            />
            <Stat
              label={t("adverse1m")}
              value={bpText(m.adverse[0]?.bp ?? null)}
              valueClass={bpTone(m.adverse[0]?.bp ?? null)}
              sub={t("adverseSub")}
            />
            <Stat
              label={t("fillRate")}
              value={pctText(m.fillRatePct)}
              sub={t("fillSub", { f: m.ordersFilled, p: m.ordersPlaced })}
            />
            <Stat
              label={t("rest")}
              value={m.medianRestSecs === null ? "—" : `${m.medianRestSecs.toFixed(1)} s`}
              sub={t("restSub")}
            />
            <Stat
              label={t("maker")}
              value={pctText(m.makerPct)}
              sub={t("rejected", { n: m.rejected })}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Box title={t("adverseTitle")} sub={t("adverseHint")}>
              <GroupBars
                items={m.adverse.map((x) => ({
                  key: String(x.minutes),
                  label: t("colAfter", { m: x.minutes }),
                  value: x.bp,
                  sub: pctText(x.againstPct),
                }))}
                format={(v) => `${v.toFixed(2)} bp`}
                height={150}
                label={t("adverseTitle")}
              />
              <AdverseTable m={m} />
            </Box>
            <div className="flex flex-col gap-3">
              <Box
                title={t("inventoryTitle")}
                sub={t("inventorySub", {
                  max: m.inventory.maxAbsUsd.toFixed(2),
                  flat: pctText(m.inventory.flatPct),
                })}
              >
                <AreaLine
                  points={m.inventory.series.map((p) => ({ t: p.t, v: p.usd }))}
                  height={140}
                  label={t("inventoryTitle")}
                />
              </Box>
              <Box title={ts("insights")}>
                {a.insights.length === 0 ? (
                  <p className="m-0 text-sm text-muted">{ts("noInsights")}</p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
                    {a.insights.map((i) => {
                      const p: Record<string, string | number> = { ...i.params };
                      if (typeof p.side === "string") p.side = t(`side.${p.side}`);
                      return (
                        <li key={i.key} className="flex gap-2">
                          <span
                            aria-hidden="true"
                            className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent"
                          />
                          <span className="text-ink-2">{ts(`insight.${i.key}`, p)}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Box>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
