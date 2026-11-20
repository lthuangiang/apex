"use client";

import {
  MARKET_STATE_RULES,
  type ContextSource,
  type ResearchMarketSplit,
  type ResearchMarketState,
} from "@drift/shared";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { ScrollTable } from "../components/bits";
import { count } from "../format";

import { pctSigned, tone } from "./format";
import { useHowItWorks } from "./how-it-works";
import { Na, tdR, tdW, thW } from "./ui";

// Trạng thái thị trường lúc quyết định (#376, DEC-348 mục 1 / DEC-350; mockup docs/mockups/signal-research/
// catalyst-market-state-{1440,390}.png, catalyst-drawer-market-state-1440.png). Chỉ hiện số API trả; trạng thái không bao
// giờ đổi quyết định, chỉ dùng để tách kết quả. Thiếu dữ liệu: "Not available" (không bao giờ 0).

type Tm = ReturnType<typeof useTranslations<"signalAnalysis.research.market">>;

/** "ETH-USD" → "ETH" (mockup "Volatility (ETH)"). */
export const assetBase = (market: string): string => market.split("-")[0] ?? market;

const chipBase = "inline-block bg-bg px-2.5 py-1 text-xs font-bold text-ink-2";
const chipCls = `${chipBase} whitespace-nowrap rounded-full`;

const linkCls =
  "cursor-pointer border-0 bg-transparent p-0 font-semibold text-accent-ink underline-offset-2 hover:underline focus-visible:underline";

function btcText(s: ResearchMarketState | null, t: Tm): string {
  return s?.btcTrend == null ? t("na") : t(`trend.${s.btcTrend}`);
}
function volText(s: ResearchMarketState | null, t: Tm): string {
  return s?.volatility == null ? t("na") : t(`vol.${s.volatility}`);
}

/** Link "How it works › Market state" (ngoài provider của drawer thì không hiện). */
function HowLink() {
  const t = useTranslations("signalAnalysis.research.market");
  const open = useHowItWorks();
  if (open === null) return null;
  return (
    <button
      type="button"
      className={linkCls}
      onClick={() => {
        open("market");
      }}
    >
      {t("how")}
    </button>
  );
}

/**
 * Khối "Market at decision" trên thẻ Decide của trace. `state` null = snapshot ghi trước #376 → "Not available" ở cả hai
 * chip. Dòng số chỉ ghép phần có số thật.
 */
export function MarketAtDecision({
  state,
  market,
}: {
  state: ResearchMarketState | null;
  market: string;
}) {
  const t = useTranslations("signalAnalysis.research.market");
  const asset = assetBase(market);
  const parts: string[] = [];
  if (state?.btcChange24hPct != null)
    parts.push(
      t("btcLine", { pct: pctSigned(state.btcChange24hPct, 1), h: MARKET_STATE_RULES.btcHours }),
    );
  if (state?.volPercentile != null)
    parts.push(t("rankLine", { asset, n: Math.round(state.volPercentile) }));
  return (
    <section
      aria-label={t("title")}
      className="mt-2.5 flex flex-col gap-1.5 rounded-tile border border-border bg-surface-2 px-3 py-2.5"
    >
      <span className="text-xs font-bold text-muted">{t("title")}</span>
      <span className="flex flex-wrap gap-1.5">
        <span className={chipCls}>{t("chipBtc", { v: btcText(state, t) })}</span>
        <span className={chipCls}>{t("chipVol", { asset, v: volText(state, t) })}</span>
      </span>
      <span className="text-xs leading-normal text-ink-2">
        {parts.join(" · ")}
        {parts.length > 0 ? " · " : null}
        <HowLink />
      </span>
    </section>
  );
}

/** Ô "Market at entry" của bảng Paper trades; null = lệnh không có trạng thái (trước #376, replay) → "Not available". */
export function MarketEntry({
  state,
  short = false,
}: {
  state: ResearchMarketState | null;
  /** Thẻ điện thoại: "Market: Not available". */
  short?: boolean;
}) {
  const t = useTranslations("signalAnalysis.research.market");
  if (state === null) return short ? <span className={chipCls}>{t("entryNa")}</span> : <Na />;
  return (
    // Cột hẹp: chip xuống dòng, không tràn sang cột bên cạnh.
    <span className={`${chipBase} rounded-tile leading-snug`}>
      {t("entry", { btc: btcText(state, t), vol: volText(state, t) })}
    </span>
  );
}

/* ---------------------------------------------------------------- Is it working? › By market */

export function ByMarket({
  live,
  backfilled,
}: {
  live: ResearchMarketSplit | null;
  backfilled: ResearchMarketSplit | null;
}) {
  const t = useTranslations("signalAnalysis.research.market");
  const tc = useTranslations("signalAnalysis.research.contextHelp");
  const [source, setSource] = useState<ContextSource>("live");
  const s = source === "live" ? live : backfilled;
  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="m-0 max-w-[820px] text-[13px] leading-normal text-ink-2">
          {t("sub", { min: s?.minClosedPerGroup ?? MARKET_STATE_RULES.minClosedPerGroup })}{" "}
          <HowLink />
        </p>
        <div
          role="group"
          aria-label={tc("dataLabel")}
          className="flex gap-1 rounded-tile border border-border bg-surface-2 p-[3px]"
        >
          {(["live", "backfilled"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={source === k}
              onClick={() => {
                setSource(k);
              }}
              className={`min-h-11 cursor-pointer rounded-control border-0 px-3 text-[13px] font-extrabold md:min-h-9 ${
                source === k ? "bg-surface text-ink shadow-card" : "bg-transparent text-muted"
              }`}
            >
              {tc(`sources.${k}`)}
            </button>
          ))}
        </div>
      </div>
      {s === null ? (
        <p className="m-0 text-sm">
          <Na />
        </p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-3.5 lg:grid-cols-2">
          <SplitTable
            title={t("byBtc")}
            rows={s.btcTrend.map((g) => ({
              key: g.key,
              label: t("chipBtc", { v: t(`trend.${g.key}`) }),
              g,
            }))}
            notRecorded={s.notRecorded}
            notAvailable={s.btcNotAvailable}
          />
          <SplitTable
            title={t("byVol")}
            rows={s.volatility.map((g) => ({
              key: g.key,
              label: t("rowVol", { v: t(`vol.${g.key}`) }),
              g,
            }))}
            notRecorded={s.notRecorded}
            notAvailable={s.volNotAvailable}
          />
        </div>
      )}
    </div>
  );
}

interface SplitRow {
  key: string;
  label: string;
  g: { closed: number; avgPct: number | null; need: number };
}

function SplitTable({
  title,
  rows,
  notRecorded,
  notAvailable,
}: {
  title: string;
  rows: readonly SplitRow[];
  notRecorded: number;
  notAvailable: number;
}) {
  const t = useTranslations("signalAnalysis.research.market");
  const extra = (label: ReactNode, n: number) => (
    <tr>
      <th scope="row" className={`${tdW} font-bold`}>
        {label}
      </th>
      <td className={tdR}>{count(n)}</td>
      <td className={`${tdW} text-muted`}>{t("notCompared")}</td>
    </tr>
  );
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h3 className="m-0 text-sm font-extrabold">{title}</h3>
      <ScrollTable label={title}>
        <table className="w-full border-collapse">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col" className={thW}>
                {t("colState")}
              </th>
              <th scope="col" className={thW}>
                {t("colClosed")}
              </th>
              <th scope="col" className={thW}>
                {t("colAvg")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row" className={`${tdW} font-bold`}>
                  {r.label}
                </th>
                <td className={tdR}>{count(r.g.closed)}</td>
                <td className={tdW}>
                  {r.g.avgPct === null ? (
                    <span className="text-muted">{t("needs", { n: r.g.need })}</span>
                  ) : (
                    <span className={`font-bold ${tone(r.g.avgPct)}`}>{pctSigned(r.g.avgPct)}</span>
                  )}
                </td>
              </tr>
            ))}
            {notAvailable > 0 ? extra(t("na"), notAvailable) : null}
            {notRecorded > 0 ? extra(t("notRecorded"), notRecorded) : null}
          </tbody>
        </table>
      </ScrollTable>
    </div>
  );
}
