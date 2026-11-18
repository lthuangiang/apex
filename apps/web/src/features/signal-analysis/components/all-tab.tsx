"use client";

import {
  SIGNAL_RANGES,
  type SignalAllView,
  type SignalCostGroup,
  type SignalDriver,
} from "@drift/shared";
import { Info } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { markersFor, offsetMinutes } from "@/features/account/market-hours-time";
import { ApiError } from "@/lib/api";

import { ALL_DEFAULT, useSignalAll, type AllFilters } from "../api";
import { costTone, count, hourRange, pct, shortDate, usdc, usdM, volume } from "../format";

import {
  ColHead,
  DivBar,
  FilterSelect,
  Kpi,
  Na,
  ScrollTable,
  Section,
  Seg,
  StaleNote,
  StateBox,
  Tabs,
  td,
  th,
  ThinBanner,
  ThinTag,
} from "./bits";
import { Legend, StackColumns, type StackRow } from "./charts";
import type { PageCtx } from "./signal-analysis-page";

type By = "strategy" | "market" | "bot" | "account";
const BYS: By[] = ["strategy", "market", "bot", "account"];
/** Thay đổi đã ship, đánh dấu trên biểu đồ theo ngày (chỉ là mốc, không phải nguyên nhân). */
const CHANGES = [
  { day: "2026-11-15", key: "cuts" },
  { day: "2026-11-17", key: "vbFresh" },
] as const;

const n = (v: string | null) => (v === null ? null : Number(v));

export function AllTab({ ctx }: { ctx: PageCtx }) {
  const t = useTranslations("signalAnalysis");
  const [f, setF] = useState<AllFilters>(ALL_DEFAULT);
  const q = useSignalAll(f, ctx.tz, true);
  const v = q.data;
  const { onMeta, onForbidden } = ctx;
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.code === "FORBIDDEN") onForbidden();
  }, [q.error, onForbidden]);
  useEffect(() => {
    onMeta(v === undefined ? null : { bots: v.bots, computedAt: v.computedAt });
  }, [v, onMeta]);
  const set = (p: Partial<AllFilters>) => {
    setF((x) => ({ ...x, ...p }));
  };

  return (
    <>
      <section
        aria-label={t("filters.label")}
        className="flex flex-col gap-2 rounded-card border border-border bg-surface px-3 py-3 md:px-4"
      >
        <div className="flex flex-wrap gap-3">
          <FilterSelect
            label={t("filters.time")}
            value={f.range}
            options={SIGNAL_RANGES.map((r) => ({ value: r, label: t(`filters.ranges.${r}`) }))}
            onChange={(range) => {
              set({ range });
            }}
          />
          <FilterSelect
            label={t("filters.strategy")}
            value={f.strategy ?? ""}
            options={[
              { value: "", label: t("filters.allStrategies") },
              { value: "volume_maker", label: t("strategies.volume_maker") },
              { value: "volume_farm", label: t("strategies.volume_farm") },
            ]}
            onChange={(s) => {
              set({ strategy: s === "" ? null : s });
            }}
          />
          <FilterSelect
            label={t("filters.market")}
            value={f.market ?? ""}
            options={[
              { value: "", label: t("filters.allMarkets") },
              ...(v?.markets ?? []).map((m) => ({ value: m, label: m })),
            ]}
            onChange={(m) => {
              set({ market: m === "" ? null : m });
            }}
          />
          <FilterSelect
            label={t("filters.account")}
            value={f.account ?? ""}
            options={[
              { value: "", label: t("filters.allAccounts") },
              ...(v?.accountList ?? []).map((a) => ({
                value: a.id,
                label: t("account", { tail: a.tail }),
              })),
            ]}
            onChange={(a) => {
              set({ account: a === "" ? null : a });
            }}
          />
        </div>
        <p className="m-0 text-[12.5px] text-muted">
          {t("scope.all", { bots: v?.bots ?? 0, accounts: v?.accounts ?? 0 })}
        </p>
      </section>
      {q.isError && v !== undefined ? (
        <StaleNote
          time={new Date(v.computedAt).toLocaleTimeString("en-GB", {
            timeZone: ctx.tz,
            hour: "2-digit",
            minute: "2-digit",
          })}
        />
      ) : null}
      {q.isPending ? (
        <StateBox kind="loading" what={t("states.whatFills")} />
      ) : q.isError && v === undefined ? (
        <StateBox kind="error" what="" onRetry={() => void q.refetch()} />
      ) : v === undefined ? null : v.total.fills === 0 ? (
        <StateBox
          kind="empty"
          what=""
          emptyTitle={t("states.emptyAll")}
          onClear={() => {
            setF({ ...ALL_DEFAULT, range: "30d" });
          }}
        />
      ) : (
        <AllBody v={v} ctx={ctx} range={f.range} />
      )}
    </>
  );
}

function AllBody({
  v,
  ctx,
  range,
}: {
  v: SignalAllView;
  ctx: PageCtx;
  range: AllFilters["range"];
}) {
  const t = useTranslations("signalAnalysis");
  const ta = useTranslations("signalAnalysis.all");
  const [by, setBy] = useState<By>("strategy");
  const [interval, setInterval] = useState<"daily" | "hourly">("daily");
  const total = v.total;
  const netTotal = n(total.net);
  const fees = n(total.fees);
  const label = (g: SignalCostGroup, kind: By) =>
    kind === "strategy"
      ? t(`strategies.${g.key as "volume_maker" | "volume_farm"}`)
      : kind === "account"
        ? t("account", { tail: g.label })
        : g.label;
  const rowsBy: Record<By, SignalCostGroup[]> = {
    strategy: v.byStrategy,
    market: v.byMarket,
    bot: v.byBot,
    account: v.byAccount,
  };
  const sub = (g: SignalCostGroup, kind: By) =>
    kind === "bot"
      ? `${g.strategy === null ? "" : t(`strategies.${g.strategy}`)} · ${g.market ?? ""}`
      : t("botsAccounts", { bots: g.bots, accounts: g.accounts });
  const prevDelta = (g: SignalCostGroup) =>
    g.net === null || g.prevNet === null ? null : Number(g.net) - Number(g.prevNet);
  const share = fees !== null && netTotal !== null && netTotal > 0 ? (fees / netTotal) * 100 : null;
  const top = [...v.byStrategy]
    .filter((g) => g.net !== null)
    .sort((a, b) => Number(b.net) - Number(a.net))[0];

  const stack = (g: SignalCostGroup, tip: string): StackRow => ({
    fees: n(g.fees),
    markout: n(g.markout),
    inventory: n(g.inventory),
    net: n(g.net),
    thin: g.thin,
    tip,
  });
  const tipOf = (title: string, g: SignalCostGroup) =>
    ta("tip", {
      title,
      net: g.net === null ? t("na") : usdM(g.net),
      fees: g.fees === null ? t("na") : usdM(g.fees),
      markout: g.markout === null ? t("na") : usdM(g.markout),
      inventory: g.inventory === null ? t("na") : usdM(g.inventory),
      volume: volume(g.volume),
      fills: count(g.fills),
    });
  const series = interval === "hourly" && v.hourly !== null ? v.hourly : v.daily;
  const marks =
    interval === "daily"
      ? CHANGES.flatMap((c) => {
          const i = v.daily.findIndex((d) => d.key === c.day);
          return i < 0 ? [] : [{ i, label: ta(`marks.${c.key}`), tip: ta(`marks.${c.key}Tip`) }];
        })
      : [];
  const offset = ctx.utc ? 0 : offsetMinutes(ctx.tz, new Date());
  const hourMarks = markersFor(offset, new Date()).map((m) => ({
    i: m.hour,
    label: m.us ? ta("usOpen") : `${String(Math.floor(m.utc / 60)).padStart(2, "0")} UTC`,
    tip: m.us ? ta("usOpenTip") : ta("utcMarkTip"),
  }));
  const hoursKnown = v.byHour.filter((h) => !h.thin && h.net !== null);
  const cheapest = [...hoursKnown].sort((a, b) => Number(a.net) - Number(b.net))[0];
  const priciest = [...hoursKnown].sort((a, b) => Number(b.net) - Number(a.net))[0];
  const rangeLabel = t(`filters.ranges.${range}`);
  const days = Number(range.replace(/\D/g, "")) * (range.endsWith("h") ? 1 / 24 : 1);

  return (
    <>
      {total.thin ? <ThinBanner n={total.fills} unit="fills" /> : null}
      <Section
        id="sa-all-sum"
        title={ta("sumTitle", { range: rangeLabel, volume: volume(total.volume) })}
        sub={ta("sumSub")}
      >
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-5">
          <Kpi
            label={ta("kVolume")}
            value={volume(total.volume)}
            sub={ta("kVolumeSub", { fills: count(total.fills), bots: total.bots })}
          />
          <Kpi
            label={ta("kNet")}
            value={total.net === null ? <Na /> : usdM(total.net)}
            valueTone={costTone(total.net)}
            sub={
              <>
                {total.netUsd === null ? null : ta("kNetTotal", { usd: usdc(total.netUsd) })}
                {" · "}
                <Delta d={prevDelta(total)} days={days} />
              </>
            }
          />
          <Kpi
            label={ta("kFees")}
            value={total.fees === null ? <Na /> : usdM(total.fees)}
            sub={ta("kFeesSub", {
              sodex: total.sodexFees === null ? t("na") : usdM(total.sodexFees),
              builder: total.builderFees === null ? t("na") : usdM(total.builderFees),
              share: share === null ? t("na") : pct(share),
            })}
          />
          <Kpi
            label={ta("kMarkout")}
            value={total.markout === null ? <Na /> : usdM(total.markout)}
            sub={ta("kMarkoutSub")}
          />
          <Kpi
            label={ta("kInventory")}
            value={total.inventory === null ? <Na /> : usdM(total.inventory)}
            sub={ta("kInventorySub")}
          />
        </div>
        <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
          <div className="flex min-w-0 flex-col gap-2">
            <h3 className="m-0 text-sm font-extrabold">{ta("byStrategy")}</h3>
            <StrategyBars
              rows={[
                ...v.byStrategy.map((g) => ({
                  g,
                  label: label(g, "strategy"),
                  sub: sub(g, "strategy"),
                })),
                { g: total, label: ta("allBots"), sub: ta("weighted") },
              ]}
              days={days}
            />
            <Legend
              items={[
                { label: ta("legendFees"), swatch: "bg-accent" },
                { label: ta("legendMarkout"), swatch: "bg-warn-bar" },
                { label: ta("legendInventory"), swatch: "bg-mh-shock-3" },
              ]}
            />
          </div>
          <div className="rounded-tile bg-surface-2 px-3.5 py-3 text-[13px] text-ink-2">
            {share === null ? null : (
              <b className="text-ink">{ta("insightFees", { share: pct(share) })} </b>
            )}
            {top === undefined || top.net === null
              ? null
              : ta("insightTop", { strategy: label(top, "strategy"), net: usdM(top.net) })}
          </div>
        </div>
      </Section>

      <Section
        id="sa-all-drivers"
        title={ta("driversTitle")}
        sub={ta("driversSub", { avg: total.net === null ? t("na") : usdM(total.net) })}
      >
        {v.drivers.length === 0 ? (
          <p className="m-0 text-sm text-ink-2">{ta("driversNone")}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
            {v.drivers.map((d, i) => (
              <Driver
                key={`${d.kind}-${d.group.key}`}
                d={d}
                i={i}
                onSee={() => {
                  setBy(d.kind === "account" ? "account" : d.kind === "bot" ? "bot" : "strategy");
                  document.getElementById("sa-all-bd")?.scrollIntoView();
                }}
              />
            ))}
          </ol>
        )}
        <p className="m-0 flex items-center gap-1.5 text-xs text-muted">
          <Info aria-hidden="true" size={14} />
          {ta("driversFoot")}
        </p>
      </Section>

      <div className="grid gap-3 lg:grid-cols-2">
        <Section
          id="sa-all-trend"
          title={ta("trendTitle")}
          sub={ta(interval === "daily" ? "trendSubDaily" : "trendSubHourly")}
          right={
            v.hourly === null ? undefined : (
              <Seg
                label={ta("interval")}
                value={interval}
                options={[
                  { value: "daily", label: ta("daily") },
                  { value: "hourly", label: ta("hourly") },
                ]}
                onChange={setInterval}
              />
            )
          }
        >
          <Legend
            items={[
              { label: ta("legendFees"), swatch: "bg-accent" },
              { label: ta("legendMarkout"), swatch: "bg-warn-bar" },
              { label: ta("legendInventory"), swatch: "bg-mh-shock-3" },
              { label: ta("legendNet"), swatch: "bg-ink rounded-full" },
              {
                label: ta("legendAvg", { avg: total.net === null ? t("na") : usdM(total.net) }),
                swatch: "bg-ink-2",
                line: true,
              },
            ]}
          />
          <StackColumns
            label={ta("trendAria", {
              first:
                series[0] === undefined || series[0].net === null ? t("na") : usdM(series[0].net),
              last: series.at(-1)?.net == null ? t("na") : usdM(series.at(-1)?.net ?? "0"),
              n: series.length,
            })}
            rows={series.map((g) =>
              stack(
                g,
                tipOf(
                  interval === "daily"
                    ? shortDate(g.key)
                    : `${shortDate(g.key.slice(0, 10))} ${g.key.slice(11)}:00`,
                  g,
                ),
              ),
            )}
            xLabel={(i, narrow) => {
              const g = series[i];
              if (g === undefined) return "";
              const every = Math.ceil(series.length / (narrow ? 5 : 14));
              if (i % every !== 0) return "";
              return interval === "daily" ? g.key.slice(8) : g.key.slice(11);
            }}
            {...(total.net === null ? {} : { avg: { value: Number(total.net), label: "" } })}
            marks={marks}
          />
          {marks.length === 0 ? null : <p className="m-0 text-xs text-muted">{ta("marksNote")}</p>}
        </Section>
        <Section
          id="sa-all-hours"
          title={ta("hoursTitle")}
          sub={ta("hoursSub", { range: rangeLabel })}
        >
          <StackColumns
            label={ta("hoursAria", {
              cheap: cheapest === undefined ? t("na") : hourRange(Number(cheapest.key), 1),
              dear: priciest === undefined ? t("na") : hourRange(Number(priciest.key), 1),
            })}
            rows={v.byHour.map((g) => stack(g, tipOf(hourRange(Number(g.key), 1), g)))}
            xLabel={(i) => (i % 3 === 0 ? String(i).padStart(2, "0") : "")}
            marks={hourMarks}
          />
          <table className="w-full border-collapse text-[13px]">
            <caption className="sr-only">{ta("hoursTable")}</caption>
            <thead>
              <tr>
                <th scope="col" className={th}>
                  <span className="sr-only">{ta("which")}</span>
                </th>
                <th scope="col" className={th}>
                  {ta("hour")}
                </th>
                <th scope="col" className={th}>
                  {ta("netPerM")}
                </th>
                <th scope="col" className={th}>
                  {ta("volume")}
                </th>
              </tr>
            </thead>
            <tbody>
              {[
                ["cheapest", cheapest],
                ["priciest", priciest],
              ].map(([k, g]) =>
                g === undefined || typeof g === "string" ? null : (
                  <tr key={k as string}>
                    <th scope="row" className={`${td} font-bold`}>
                      {ta(k as "cheapest" | "priciest")}
                    </th>
                    <td className={td}>{hourRange(Number(g.key), 1)}</td>
                    <td className={`${td} ${costTone(g.net)}`}>
                      {g.net === null ? <Na /> : usdM(g.net)}
                    </td>
                    <td className={td}>{volume(g.volume)}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
          <p className="m-0 text-xs text-muted">{ta("hoursFoot")}</p>
        </Section>
      </div>

      <Section
        id="sa-all-bd"
        title={ta("bdTitle")}
        sub={by === "account" ? ta("bdSubAccount") : by === "bot" ? ta("bdSubBot") : ta("bdSub")}
        right={
          <span className="text-xs text-muted">{t("thinNote", { unit: t("unitFills") })}</span>
        }
      >
        <Tabs
          label={ta("groupBy")}
          value={by}
          options={BYS.map((b) => ({ value: b, label: ta(`by.${b}`) }))}
          onChange={setBy}
          panelId="sa-all-bd-panel"
        />
        <div id="sa-all-bd-panel" role="tabpanel" aria-labelledby={`sa-all-bd-panel-${by}`}>
          <BreakdownTable
            rows={rowsBy[by]}
            total={total}
            by={by}
            label={label}
            sub={sub}
            days={days}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>{ta("bdFoot")}</span>
          <button
            type="button"
            onClick={() => {
              downloadCsv(rowsBy[by], (g) => label(g, by), by);
            }}
            className="min-h-11 cursor-pointer rounded-control border border-border-input bg-surface px-4 text-sm font-bold text-ink"
          >
            {ta("export")}
          </button>
        </div>
      </Section>
    </>
  );
}

function Delta({ d, days }: { d: number | null; days: number }) {
  const ta = useTranslations("signalAnalysis.all");
  if (d === null) return <span>{ta("vsNa")}</span>;
  const down = d < 0;
  return (
    <span className={`font-bold ${down ? "text-pos" : "text-neg"}`}>
      {down ? "▼" : "▲"} {ta("vsPrev", { v: usdM(Math.abs(d)), days })}
    </span>
  );
}

/** Thanh âm / dương quanh $0 cho từng strategy; ba phần chi tiết ghi thành một dòng số dưới thanh. */
function StrategyBars({
  rows,
  days,
}: {
  rows: { g: SignalCostGroup; label: string; sub: string }[];
  days: number;
}) {
  const ta = useTranslations("signalAnalysis.all");
  const t = useTranslations("signalAnalysis");
  const pos = Math.max(
    1,
    ...rows.map(({ g }) =>
      [n(g.fees), n(g.markout), n(g.inventory)].reduce<number>(
        (s, x) => s + Math.max(0, x ?? 0),
        0,
      ),
    ),
  );
  const neg = Math.min(
    0,
    ...rows.map(({ g }) =>
      [n(g.fees), n(g.markout), n(g.inventory)].reduce<number>(
        (s, x) => s + Math.min(0, x ?? 0),
        0,
      ),
    ),
  );
  const span = pos - neg || 1;
  const zero = (-neg / span) * 100;
  const colors = ["bg-accent", "bg-warn-bar", "bg-mh-shock-3"];
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map(({ g, label, sub }) => {
        const parts: [number | null, number | null, number | null] = [
          n(g.fees),
          n(g.markout),
          n(g.inventory),
        ];
        let up = 0;
        let dn = 0;
        const d = g.net === null || g.prevNet === null ? null : Number(g.net) - Number(g.prevNet);
        return (
          <div
            key={label}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 md:grid-cols-[150px_minmax(0,1fr)_110px]"
          >
            <div className="min-w-0">
              <div className="text-[13px] font-extrabold">{label}</div>
              <div className="text-xs text-muted">{sub}</div>
            </div>
            <div
              role="img"
              aria-label={ta("barAria", {
                label,
                fees: parts[0] === null ? t("na") : usdM(parts[0]),
                markout: parts[1] === null ? t("na") : usdM(parts[1]),
                inventory: parts[2] === null ? t("na") : usdM(parts[2]),
                net: g.net === null ? t("na") : usdM(g.net),
              })}
              className="relative col-span-2 h-6 rounded-[6px] bg-surface-2 md:col-span-1"
            >
              <span
                aria-hidden="true"
                className="absolute top-0 bottom-0 w-px bg-ink-2"
                style={{ left: `${String(zero)}%` }}
              />
              {parts.map((x, k) => {
                if (x === null || x === 0) return null;
                const w = (Math.abs(x) / span) * 100;
                const left =
                  x > 0
                    ? zero + (up / span) * 100
                    : zero - ((Math.abs(dn) + Math.abs(x)) / span) * 100;
                if (x > 0) up += x;
                else dn += x;
                return (
                  <span
                    key={k}
                    aria-hidden="true"
                    className={`absolute top-0.5 bottom-0.5 ${colors[k] ?? ""} ${k === 0 ? "text-white" : "text-ink"} flex items-center justify-center overflow-hidden text-[11px] font-bold`}
                    style={{ left: `${String(left)}%`, width: `${String(w)}%` }}
                    title={usdM(x)}
                  >
                    {w > 12 ? usdM(x) : ""}
                  </span>
                );
              })}
            </div>
            <div className="col-start-2 row-start-1 text-right md:col-start-auto md:row-start-auto">
              <div className={`text-[15px] font-extrabold ${costTone(g.net)}`}>
                {g.net === null ? <Na /> : usdM(g.net)}
              </div>
              <div className="text-xs">
                <Delta d={d} days={days} />
              </div>
            </div>
            <div className="col-span-2 text-xs text-muted md:col-start-2 md:col-span-1">
              {ta("parts", {
                fees: parts[0] === null ? t("na") : usdM(parts[0]),
                markout: parts[1] === null ? t("na") : usdM(parts[1]),
                inventory: parts[2] === null ? t("na") : usdM(parts[2]),
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Driver({ d, i, onSee }: { d: SignalDriver; i: number; onSee: () => void }) {
  const t = useTranslations("signalAnalysis");
  const ta = useTranslations("signalAnalysis.all");
  const g = d.group;
  const strategy = g.strategy === null ? "" : t(`strategies.${g.strategy}`);
  const title =
    d.kind === "account"
      ? t("account", { tail: g.label })
      : d.kind === "bot"
        ? `${g.label} · ${strategy} · ${g.market ?? ""}`
        : `${strategy} · ${g.market ?? ""} · ${hourRange(d.hourFrom ?? 0, 4)}`;
  const value = d.part === "fees" ? g.fees : d.part === "markout" ? g.markout : g.inventory;
  return (
    <li className="grid gap-2 rounded-tile border border-border p-3.5 md:grid-cols-[28px_1fr_auto]">
      <span
        aria-hidden="true"
        className="flex size-6 items-center justify-center rounded-full bg-neg-bg text-xs font-extrabold text-neg-ink"
      >
        {i + 1}
      </span>
      <div className="min-w-0">
        <h3 className="m-0 text-[14px] font-extrabold">{title}</h3>
        <p className="m-0 text-[13px] text-ink-2">
          {ta("driverWhy", {
            part: ta(`part.${d.part}`),
            value: value === null ? t("na") : usdM(value),
            overall: d.partOverall === null ? t("na") : usdM(d.partOverall),
            scope: d.kind === "account" ? ta("allBots") : strategy,
          })}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="rounded-full bg-surface-2 px-2 py-0.5 font-bold text-ink-2">
            {ta("biggest", { part: ta(`part.${d.part}`) })}
          </span>
          <span>{ta("volFills", { volume: volume(g.volume), fills: count(g.fills) })}</span>
          {d.kind === "account" ? (
            <Link href={`/admin/users/${g.key}`} className="font-bold text-accent-ink underline">
              {ta("openUser")}
            </Link>
          ) : null}
          <button
            type="button"
            onClick={onSee}
            className="min-h-6 cursor-pointer border-0 bg-transparent p-0 text-xs font-bold text-accent-ink underline"
          >
            {t("suggestions.see", {
              what: ta(
                `by.${d.kind === "account" ? "account" : d.kind === "bot" ? "bot" : "strategy"}`,
              ),
            })}
          </button>
        </div>
      </div>
      <div className="text-right">
        <div className="text-[15px] font-extrabold text-neg">+{usdc(d.extraUsd)}</div>
        <div className="text-xs text-muted">
          {ta("driverSub", {
            net: g.net === null ? t("na") : usdM(g.net),
            share: d.sharePct === null ? t("na") : pct(d.sharePct),
          })}
        </div>
      </div>
    </li>
  );
}

function BreakdownTable({
  rows,
  total,
  by,
  label,
  sub,
  days,
}: {
  rows: readonly SignalCostGroup[];
  total: SignalCostGroup;
  by: By;
  label: (g: SignalCostGroup, kind: By) => string;
  sub: (g: SignalCostGroup, kind: By) => string;
  days: number;
}) {
  const ta = useTranslations("signalAnalysis.all");
  const totalVol = Number(total.volume);
  const max = Math.max(1, ...rows.map((g) => Math.abs(Number(g.net ?? 0))));
  const cell = (v: string | null) => (v === null ? <Na /> : usdM(v));
  const row = (g: SignalCostGroup, all: boolean) => {
    const d = g.net === null || g.prevNet === null ? null : Number(g.net) - Number(g.prevNet);
    return (
      <tr
        key={all ? "__all" : g.key}
        className={all ? "bg-surface-2 font-bold" : g.thin ? "text-muted" : undefined}
      >
        <th scope="row" className={`${td} font-bold`}>
          <span className="inline-flex flex-wrap items-center">
            {all ? (
              ta("allBots")
            ) : by === "account" ? (
              <Link href={`/admin/users/${g.key}`} className="text-accent-ink underline">
                {label(g, by)}
              </Link>
            ) : (
              label(g, by)
            )}
            {!all && g.thin ? <ThinTag /> : null}
          </span>
          {all ? null : (
            <span className="block text-[11.5px] font-semibold text-muted">{sub(g, by)}</span>
          )}
        </th>
        <td className={td}>{volume(g.volume)}</td>
        <td className={td}>
          {all ? "100%" : totalVol > 0 ? pct((Number(g.volume) / totalVol) * 100) : <Na />}
        </td>
        <td className={td}>{count(g.fills)}</td>
        <td className={td}>{cell(g.fees)}</td>
        <td className={td}>{cell(g.markout)}</td>
        <td className={td}>{cell(g.inventory)}</td>
        <td className={`${td} font-extrabold ${costTone(g.net)}`}>
          <DivBar v={n(g.net)} max={max} bad={Number(g.net ?? 0) > 0} />
          {cell(g.net)}
        </td>
        <td className={td}>{g.netUsd === null ? <Na /> : usdc(g.netUsd)}</td>
        <td className={td}>
          {d === null ? (
            <Na />
          ) : (
            <span className={d < 0 ? "text-pos" : "text-neg"}>
              {d < 0 ? "▼" : "▲"} {usdM(Math.abs(d))}
            </span>
          )}
        </td>
      </tr>
    );
  };
  return (
    <ScrollTable label={ta("bdTable", { by: ta(`by.${by}`) })}>
      <table className="w-full min-w-[860px] border-collapse">
        <caption className="sr-only">{ta("bdTable", { by: ta(`by.${by}`) })}</caption>
        <thead>
          <tr>
            <th scope="col" className={th}>
              {ta(`by.${by}`)}
            </th>
            <th scope="col" className={th}>
              <ColHead main={ta("volume")} sub="USDC" />
            </th>
            <th scope="col" className={th}>
              {ta("share")}
            </th>
            <th scope="col" className={th}>
              {ta("fills")}
            </th>
            <th scope="col" className={th}>
              <ColHead main={ta("colFees")} sub="$ / 1M" />
            </th>
            <th scope="col" className={th}>
              <ColHead main={ta("colMarkout")} sub={ta("colMarkoutSub")} />
            </th>
            <th scope="col" className={th}>
              <ColHead main={ta("colInventory")} sub="$ / 1M" />
            </th>
            <th scope="col" className={th}>
              <ColHead main={ta("colNet")} sub="$ / 1M" />
            </th>
            <th scope="col" className={th}>
              <ColHead main={ta("colNet")} sub={ta("colTotal")} />
            </th>
            <th scope="col" className={th}>
              <ColHead main={ta("colPrev")} sub={ta("colPrevSub", { days })} />
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => row(g, false))}
          {row(total, true)}
        </tbody>
      </table>
    </ScrollTable>
  );
}

function downloadCsv(
  rows: readonly SignalCostGroup[],
  name: (g: SignalCostGroup) => string,
  by: By,
) {
  const head = [
    "group",
    "volume_usdc",
    "fills",
    "fees_per_1m",
    "markout_per_1m",
    "inventory_per_1m",
    "net_per_1m",
    "net_usdc",
    "prev_net_per_1m",
  ];
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = rows.map((g) =>
    [
      name(g),
      g.volume,
      String(g.fills),
      g.fees ?? "",
      g.markout ?? "",
      g.inventory ?? "",
      g.net ?? "",
      g.netUsd ?? "",
      g.prevNet ?? "",
    ]
      .map(esc)
      .join(","),
  );
  const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `signal-analysis-${by}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
