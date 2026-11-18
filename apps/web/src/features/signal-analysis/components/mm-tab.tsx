"use client";

import {
  MM_BREAKDOWNS,
  SIGNAL_RANGES,
  type MmBreakdown,
  type MmFill,
  type MmRow,
  type SignalMmView,
  type SignalSuggestion,
} from "@drift/shared";
import { Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { ApiError } from "@/lib/api";

import {
  isAnalysisTimeout,
  MM_DEFAULT,
  useMmFills,
  useMmQuantiles,
  useSignalMm,
  type MmFilters,
} from "../api";
import {
  clock,
  costTone,
  count,
  day,
  duration,
  favourTone,
  hourRange,
  pct,
  price,
  signed,
  usdc,
  usdM,
  volume,
} from "../format";

import {
  ColHead,
  DivBar,
  FilterSelect,
  Kpi,
  Refreshing,
  useKeepSelected,
  Na,
  ScrollTable,
  Section,
  Seg,
  StaleNote,
  StateBox,
  Suggestions,
  Tabs,
  td,
  th,
  ThinBanner,
  ThinTag,
} from "./bits";
import { GroupedBars, Legend, LineChart } from "./charts";
import { MmFillDetail } from "./mm-detail";
import type { PageCtx } from "./signal-analysis-page";

const HZ6 = ["0", "10", "30", "60", "120", "300"] as const;
type Sort = "newest" | "worst" | "cuts";
const n = (v: string | null) => (v === null ? null : Number(v));

export function MmTab({ ctx }: { ctx: PageCtx }) {
  const t = useTranslations("signalAnalysis");
  const tm = useTranslations("signalAnalysis.mm");
  const [f, setF] = useState<MmFilters>(MM_DEFAULT);
  const q = useSignalMm(f, ctx.tz, true);
  const v = q.data;
  const { onMeta, onForbidden } = ctx;
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.code === "FORBIDDEN") onForbidden();
  }, [q.error, onForbidden]);
  useEffect(() => {
    onMeta(v === undefined ? null : { bots: v.bots, computedAt: v.computedAt });
  }, [v, onMeta]);
  const keepSel = useKeepSelected();
  const set = (p: Partial<MmFilters>) => {
    setF((x) => ({ ...x, ...p }));
  };
  return (
    <>
      <section
        aria-label={t("filters.label")}
        className="flex flex-col gap-2 rounded-card border border-border bg-surface px-3 py-3 md:px-4"
      >
        <div className="flex flex-wrap items-end gap-3">
          <FilterSelect
            label={t("filters.time")}
            value={f.range}
            options={SIGNAL_RANGES.map((r) => ({ value: r, label: t(`filters.ranges.${r}`) }))}
            onChange={(range) => {
              set({ range });
            }}
          />
          <FilterSelect
            label={t("filters.market")}
            value={f.market ?? ""}
            options={[
              { value: "", label: t("filters.allMarkets") },
              ...keepSel(
                (v?.markets ?? []).map((m) => ({ value: m, label: m })),
                f.market,
              ),
            ]}
            onChange={(m) => {
              set({ market: m === "" ? null : m });
            }}
          />
          <FilterSelect
            label={t("filters.bot")}
            value={f.botId ?? ""}
            options={[
              { value: "", label: t("filters.allMmBots") },
              ...keepSel(
                (v?.botList ?? []).map((b) => ({ value: b.id, label: b.name })),
                f.botId,
              ),
            ]}
            onChange={(b) => {
              set({ botId: b === "" ? null : b });
            }}
          />
          <FilterSelect
            label={tm("whereToQuote")}
            value={f.level === null ? "" : String(f.level)}
            options={[
              { value: "", label: tm("allLevels") },
              ...[0, 1, 2, 3].map((l) => ({
                value: String(l),
                label: tm(`levels.${String(l) as "0"}`),
              })),
            ]}
            onChange={(l) => {
              set({ level: l === "" ? null : Number(l) });
            }}
          />
          <div className="flex flex-col gap-1">
            <span id="sa-mm-sm" className="text-[12.5px] font-bold text-ink-2">
              {tm("smart")}
            </span>
            <Seg
              labelId="sa-mm-sm"
              value={f.smart ?? "all"}
              options={[
                { value: "all", label: t("filters.all") },
                { value: "on", label: t("filters.on") },
                { value: "off", label: t("filters.off") },
              ]}
              onChange={(x) => {
                set({ smart: x === "all" ? null : x });
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span id="sa-mm-sd" className="text-[12.5px] font-bold text-ink-2">
              {tm("side")}
            </span>
            <Seg
              labelId="sa-mm-sd"
              value={f.side ?? "all"}
              options={[
                { value: "all", label: t("filters.all") },
                { value: "buy", label: tm("sides.buy") },
                { value: "sell", label: tm("sides.sell") },
              ]}
              onChange={(x) => {
                set({ side: x === "all" ? null : x });
              }}
            />
          </div>
        </div>
        <p className="m-0 text-[12.5px] text-muted">
          {t("scope.mm", { bots: v?.bots ?? 0, accounts: v?.accounts ?? 0 })}
        </p>
        {v !== undefined && v.summary.withContext < v.summary.fills ? (
          <p className="m-0 text-[12.5px] text-muted">
            {tm("noContext", { n: count(v.summary.fills - v.summary.withContext) })}
          </p>
        ) : null}
      </section>
      {q.isError && v !== undefined ? (
        <StaleNote time={clock(v.computedAt, ctx.tz, false)} />
      ) : null}
      {q.isPending ? (
        <StateBox kind="loading" what={t("states.whatMm")} />
      ) : q.isError && v === undefined && isAnalysisTimeout(q.error) ? (
        <StateBox
          kind="timeout"
          what=""
          onRetry={() => void q.refetch()}
          {...(f.range === "14d" || f.range === "30d"
            ? {
                onShow7d: () => {
                  set({ range: "7d" });
                },
              }
            : {})}
        />
      ) : q.isError && v === undefined ? (
        <StateBox kind="error" what="" onRetry={() => void q.refetch()} />
      ) : v === undefined ? null : v.summary.fills === 0 ? (
        <StateBox
          kind="empty"
          what=""
          emptyTitle={t("states.emptyMm")}
          onClear={() => {
            setF({ ...MM_DEFAULT, range: "30d" });
          }}
        />
      ) : (
        <Refreshing on={q.isPlaceholderData}>
          <MmBody v={v} f={f} ctx={ctx} />
        </Refreshing>
      )}
    </>
  );
}

function MmBody({ v, f, ctx }: { v: SignalMmView; f: MmFilters; ctx: PageCtx }) {
  const t = useTranslations("signalAnalysis");
  const tm = useTranslations("signalAnalysis.mm");
  const th2 = useTranslations("signalAnalysis.hz");
  const [by, setBy] = useState<MmBreakdown>("level");
  const [bdOpen, setBdOpen] = useState(false);
  const [cmp, setCmp] = useState<"all" | "smart">("all");
  // p25 / p75 theo bộ lọc tải sau trang chính (truy vấn riêng); lỗi / timeout → Not available.
  const qq = useMmQuantiles(f, true);
  const p25 = (i: number) => qq.data?.p25[i] ?? null;
  const p75 = (i: number) => qq.data?.p75[i] ?? null;
  const s = v.summary;
  const w = v.waterfall;
  const na = t("na");
  const bp = (x: number | null) => (x === null ? na : `${signed(x)} bp`);
  const days = v.range === "24h" ? 1 : Number(v.range.replace(/\D/g, ""));
  const d = s.vsPrev === null ? null : Number(s.vsPrev);
  const jump = (k: MmBreakdown) => {
    setBy(k);
    setBdOpen(true);
    document.getElementById("sa-mm-bd")?.scrollIntoView();
  };
  const levelName = (l: number) => tm(`levels.${String(l) as "0"}`);
  const render = (x: SignalSuggestion) => {
    const vals = { ...x.values } as Record<string, string | number>;
    if (typeof vals.level === "number") vals.levelName = levelName(vals.level);
    if (typeof vals.from === "number") vals.hours = hourRange(vals.from, 4);
    const link: Record<string, [string, () => void]> = {
      level: [
        tm("whereToQuote"),
        () => {
          jump("level");
        },
      ],
      levelNoRate: [
        tm("whereToQuote"),
        () => {
          jump("level");
        },
      ],
      smart: [
        tm("smart"),
        () => {
          jump("smart");
        },
      ],
      hours: [
        tm("by.hour"),
        () => {
          jump("hour");
        },
      ],
    };
    const [l, go] = link[x.key] ?? ["", () => undefined];
    return {
      title: tm(`sug.${x.key}.title` as "sug.level.title", vals),
      body: tm.rich(`sug.${x.key}.body` as "sug.level.body", {
        ...vals,
        b: (c) => <b className="text-ink">{c}</b>,
      }),
      link: l,
      onLink: go,
    };
  };
  const steps: { key: string; label: string; sub: string; v: string | null }[] = [
    { key: "spread", label: tm("wfSpread"), sub: tm("wfSpreadSub"), v: w.spread },
    { key: "against", label: tm("wfAgainst"), sub: tm("wfAgainstSub"), v: w.priceAgainst },
    {
      key: "fees",
      label: tm("wfFees"),
      sub: tm("wfFeesSub", {
        sodex: w.sodexFees === null ? na : usdM(w.sodexFees),
        builder: w.builderFees === null ? na : usdM(w.builderFees),
      }),
      v: w.fees,
    },
    {
      key: "inv",
      label: tm("wfInventory"),
      sub: tm("wfInventorySub", { cuts: s.cuts }),
      v: w.inventory,
    },
  ];
  return (
    <>
      {s.fills < 30 ? <ThinBanner n={s.fills} unit="fills" /> : null}
      <Section
        id="sa-mm-sum"
        title={tm("sumTitle", { range: t(`filters.ranges.${v.range}`), n: count(s.fills) })}
        sub={tm("sumSub")}
      >
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-6">
          <Kpi
            label={tm("kFills")}
            value={count(s.fills)}
            sub={tm("kFillsSub", { volume: volume(s.volume), bots: v.bots })}
          />
          <Kpi
            label={tm("kSpread")}
            value={bp(s.spread)}
            valueTone={favourTone(s.spread)}
            sub={tm("kSpreadSub")}
          />
          <Kpi
            label={tm("kMarkout")}
            value={bp(s.markout1m)}
            valueTone={favourTone(s.markout1m)}
            sub={tm("kMarkoutSub", { fees: s.feesBp === null ? na : s.feesBp.toFixed(2) })}
          />
          <Kpi
            label={tm("kAgainst")}
            value={s.againstPct === null ? <Na /> : pct(s.againstPct)}
            sub={tm("kAgainstSub")}
          />
          <Kpi
            label={tm("kCuts")}
            value={count(s.cuts)}
            sub={
              <>
                {s.cutsUsd === null ? na : usdc(s.cutsUsd, 2)}
                {s.cuts > 0 && s.cuts < 30 ? <ThinTag /> : null}
              </>
            }
          />
          <Kpi
            label={tm("kNet")}
            value={s.netPerM === null ? <Na /> : usdM(s.netPerM)}
            valueTone={costTone(s.netPerM)}
            sub={
              d === null ? (
                tm("vsNa")
              ) : (
                <span className={`font-bold ${d < 0 ? "text-pos" : "text-neg"}`}>
                  {d < 0 ? "▼" : "▲"} {tm("vsPrev", { v: usdM(Math.abs(d)), days })}
                </span>
              )
            }
          />
        </div>
        <div className="grid gap-3 lg:grid-cols-[1fr_300px]">
          <div className="flex min-w-0 flex-col gap-2">
            <h3 className="m-0 text-sm font-extrabold">{tm("wfTitle")}</h3>
            <Waterfall
              steps={steps}
              net={w.net}
              netSub={
                s.netUsd === null
                  ? na
                  : tm("wfNetSub", { usd: usdc(s.netUsd), volume: volume(s.volume) })
              }
            />
          </div>
          <div className="rounded-tile bg-surface-2 px-3.5 py-3 text-[13px] text-ink-2">
            {w.spread === null || w.priceAgainst === null ? null : (
              <b className="text-ink">
                {Number(w.priceAgainst) > -Number(w.spread)
                  ? tm("insightNotCover", {
                      spread: usdM(-Number(w.spread)),
                      against: usdM(w.priceAgainst),
                    })
                  : tm("insightCover", {
                      spread: usdM(-Number(w.spread)),
                      against: usdM(w.priceAgainst),
                    })}{" "}
              </b>
            )}
            {w.inventory === null ? null : tm("insightInventory", { inv: usdM(w.inventory) })}
            <span className="mt-1 block text-xs text-muted">{tm("insightNote")}</span>
          </div>
        </div>
      </Section>

      <Suggestions
        id="sa-mm-sug"
        unit="fills"
        items={v.suggestions}
        hidden={v.hidden}
        render={render}
        hiddenLabel={(h) => tm(`hiddenLead.${h.key}` as "hiddenLead.cuts", { n: h.n })}
        footer={tm("sugFoot")}
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <Section
          id="sa-mm-mk"
          title={tm("curveTitle")}
          sub={tm("curveSub")}
          right={
            <Seg
              label={tm("compare")}
              value={cmp}
              options={[
                { value: "all", label: tm("allFills") },
                { value: "smart", label: tm("smartOnOff") },
              ]}
              onChange={setCmp}
            />
          }
        >
          <Legend
            items={[
              ...(cmp === "smart"
                ? [
                    { label: tm("legendOn"), swatch: "bg-accent", line: true },
                    { label: tm("legendOff"), swatch: "bg-warn-bar", line: true },
                  ]
                : [
                    { label: tm("legendMean"), swatch: "bg-accent", line: true },
                    { label: tm("legendBand"), swatch: "bg-mh-vol-1" },
                  ]),
              {
                label: tm("legendFees", {
                  v: v.curve.feesBp === null ? na : signed(v.curve.feesBp, 2),
                }),
                swatch: "bg-ink",
                line: true,
              },
            ]}
          />
          <LineChart
            label={tm("curveAria", {
              first: bp(v.curve.all[0]?.mean ?? null),
              last: bp(v.curve.all[5]?.mean ?? null),
            })}
            xLabels={HZ6.map((h) => th2(h))}
            series={
              cmp === "smart"
                ? [
                    {
                      key: "on",
                      values: v.curve.on,
                      stroke: "stroke-accent",
                      endLabel: tm("endOn"),
                    },
                    {
                      key: "off",
                      values: v.curve.off,
                      stroke: "stroke-warn-bar",
                      dashed: true,
                      endLabel: tm("endOff"),
                    },
                  ]
                : [
                    {
                      key: "mean",
                      values: v.curve.all.map((x) => x.mean),
                      stroke: "stroke-accent",
                      endLabel: tm("endMean", { v: bp(v.curve.all[5]?.mean ?? null) }),
                    },
                  ]
            }
            {...(cmp === "all"
              ? {
                  band: {
                    lo: v.curve.all.map((_, i) => p25(i)),
                    hi: v.curve.all.map((_, i) => p75(i)),
                  },
                }
              : {})}
            {...(v.curve.feesBp === null
              ? {}
              : {
                  refLine: {
                    value: v.curve.feesBp,
                    label: tm("feeLine", { v: signed(v.curve.feesBp, 2) }),
                  },
                })}
          />
          <ScrollTable label={tm("curveTable")}>
            <table className="w-full min-w-[520px] border-collapse">
              <caption className="sr-only">{tm("curveTable")}</caption>
              <thead>
                <tr>
                  <th scope="col" className={th}>
                    {tm("afterFill")}
                  </th>
                  {HZ6.map((h) => (
                    <th key={h} scope="col" className={th}>
                      {th2(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" className={`${td} font-bold`}>
                    {tm("legendMean")}
                  </th>
                  {v.curve.all.map((x, i) => (
                    <td key={i} className={`${td} ${favourTone(x.mean)}`}>
                      {x.mean === null ? <Na /> : signed(x.mean)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row" className={`${td} font-bold`}>
                    {tm("p25p75")}
                  </th>
                  {v.curve.all.map((_, i) => {
                    const lo = p25(i);
                    const hi = p75(i);
                    return (
                      <td key={i} className={td} aria-busy={qq.isPending}>
                        {qq.isPending ? (
                          <span className="text-muted">
                            <span aria-hidden="true">…</span>
                            <span className="sr-only">{t("states.quantLoading")}</span>
                          </span>
                        ) : lo === null || hi === null ? (
                          <Na />
                        ) : (
                          tm("range", { lo: signed(lo), hi: signed(hi) })
                        )}
                      </td>
                    );
                  })}
                </tr>
                <tr>
                  <th scope="row" className={`${td} font-bold`}>
                    {tm("againstRow")}
                  </th>
                  {v.curve.all.map((x, i) => (
                    <td key={i} className={td}>
                      {i === 0 ? "—" : x.againstPct === null ? <Na /> : pct(x.againstPct)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row" className={`${td} font-bold`}>
                    {tm("smartRow")}
                  </th>
                  {v.curve.on.map((x, i) => (
                    <td key={i} className={td}>
                      {x === null ? na : signed(x)} /{" "}
                      {v.curve.off[i] == null ? na : signed(v.curve.off[i] ?? 0)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </ScrollTable>
          <p className="m-0 text-xs text-muted">{tm("curveFoot")}</p>
        </Section>
        <Section id="sa-mm-lv" title={tm("levelsTitle")} sub={tm("levelsSub")}>
          <Legend
            items={[
              { label: tm("legendSpread"), swatch: "bg-pos-dot" },
              { label: tm("legendAgainst"), swatch: "bg-warn-bar" },
              { label: tm("legendNetAfter"), swatch: "bg-ink" },
            ]}
          />
          <GroupedBars
            label={tm("levelsAria")}
            cats={v.levels.map((l) => ({
              label: levelName(l.level),
              sub: `${count(l.n)} · ${l.fillRatePct === null ? na : tm("fillRateShort", { v: l.fillRatePct.toFixed(1) })}`,
              thin: l.thin,
            }))}
            series={[
              { key: "spread", values: v.levels.map((l) => l.spread), fill: "fill-pos-dot" },
              {
                key: "against",
                values: v.levels.map((l) => l.priceAgainst),
                fill: "fill-warn-bar",
              },
              { key: "net", values: v.levels.map((l) => l.netAfterFees), fill: "fill-ink" },
            ]}
          />
          <ScrollTable label={tm("levelsTable")}>
            <table className="w-full min-w-[420px] border-collapse">
              <caption className="sr-only">{tm("levelsTable")}</caption>
              <thead>
                <tr>
                  <th scope="col" className={th}>
                    {tm("perFillBp")}
                  </th>
                  {v.levels.map((l) => (
                    <th key={l.level} scope="col" className={th}>
                      {tm(`levelsShort.${String(l.level) as "0"}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["legendSpread", (l: SignalMmView["levels"][number]) => l.spread],
                    ["legendAgainst", (l: SignalMmView["levels"][number]) => l.priceAgainst],
                    ["legendNetAfter", (l: SignalMmView["levels"][number]) => l.netAfterFees],
                  ] as const
                ).map(([k, get]) => (
                  <tr key={k}>
                    <th scope="row" className={`${td} font-bold`}>
                      {tm(k)}
                    </th>
                    {v.levels.map((l) => {
                      const x = get(l);
                      return (
                        <td key={l.level} className={`${td} ${favourTone(x)}`}>
                          {x === null ? <Na /> : signed(x)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr>
                  <th scope="row" className={`${td} font-bold`}>
                    {tm("fillRate")}
                  </th>
                  {v.levels.map((l) => (
                    <td key={l.level} className={td}>
                      {l.fillRatePct === null ? <Na /> : `${l.fillRatePct.toFixed(1)}%`}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </ScrollTable>
          <p className="m-0 text-xs text-muted">
            {tm.rich("fillRateNote", { b: (c) => <b className="text-ink">{c}</b> })}
          </p>
        </Section>
      </div>

      <Section id="sa-mm-inv" title={tm("invTitle")} sub={tm("invSub")}>
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <Kpi
            label={tm("timeFlat")}
            value={v.inventory.timeFlatPct === null ? <Na /> : pct(v.inventory.timeFlatPct)}
            sub={tm("timeFlatSub")}
          />
          <Kpi
            label={tm("avgPosition")}
            value={
              v.inventory.avgPositionOrders === null ? (
                <Na />
              ) : (
                tm("orders", { v: v.inventory.avgPositionOrders.toFixed(1) })
              )
            }
            sub={tm("avgPositionSub")}
          />
          <Kpi
            label={tm("invCost")}
            value={
              v.inventory.inventoryPerM === null ? (
                <Na />
              ) : (
                `${usdM(v.inventory.inventoryPerM)} / 1M`
              )
            }
            sub={tm("invCostSub")}
          />
          <Kpi
            label={tm("kCuts")}
            value={`${count(v.inventory.cuts)} · ${v.inventory.cutsUsd === null ? na : usdc(v.inventory.cutsUsd, 2)}`}
            sub={
              <>
                {tm("avgMove", {
                  v: v.inventory.avgCutMoveBp === null ? na : v.inventory.avgCutMoveBp.toFixed(1),
                })}
                {v.inventory.cuts > 0 && v.inventory.cuts < 30 ? <ThinTag /> : null}
              </>
            }
          />
        </div>
        <p className="m-0 flex items-start gap-2 rounded-tile bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2">
          <Info aria-hidden="true" size={15} className="mt-0.5 flex-none" />
          <span title={tm("cutRuleTip")}>
            {tm.rich("cutRule", { b: (c) => <b className="text-ink">{c}</b> })}
          </span>
        </p>
        <h3 className="m-0 text-sm font-extrabold">{tm("latestCuts")}</h3>
        {v.inventory.latestCuts.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">{tm("noCuts")}</p>
        ) : (
          <ScrollTable label={tm("latestCuts")}>
            <table className="w-full min-w-[720px] border-collapse">
              <caption className="sr-only">{tm("latestCuts")}</caption>
              <thead>
                <tr>
                  <th scope="col" className={th}>
                    {tm("colCut", { zone: ctx.utc ? "UTC" : t("yourTime") })}
                  </th>
                  <th scope="col" className={th}>
                    {tm("colMarketBot")}
                  </th>
                  <th scope="col" className={th}>
                    {tm("colPosition")}
                  </th>
                  <th scope="col" className={th}>
                    <ColHead main={tm("colBinance")} sub={tm("colBinanceSub")} />
                  </th>
                  <th scope="col" className={th}>
                    {tm("colEntryCut")}
                  </th>
                  <th scope="col" className={th}>
                    {tm("colHeld")}
                  </th>
                  <th scope="col" className={th}>
                    <ColHead main={tm("colResult")} sub={tm("colResultSub")} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {v.inventory.latestCuts.map((c) => (
                  <tr key={c.fillId}>
                    <td className={td}>
                      {day(c.at, ctx.tz)} {clock(c.at, ctx.tz)}
                    </td>
                    <td className={td}>
                      {c.market}
                      <span className="block text-xs text-muted">{c.botName}</span>
                    </td>
                    <td
                      className={`${td} font-bold ${c.position === "long" ? "text-pos" : "text-neg"}`}
                    >
                      {tm(`positions.${c.position}`)}
                    </td>
                    <td className={td}>{c.moveBp === null ? <Na /> : c.moveBp.toFixed(1)}</td>
                    <td className={td}>
                      {c.entry === null ? na : price(c.entry)} → {price(c.price)}
                    </td>
                    <td className={td}>{c.heldSecs === null ? <Na /> : duration(c.heldSecs)}</td>
                    <td className={`${td} font-bold ${favourTone(n(c.resultUsd))}`}>
                      {c.resultUsd === null ? <Na /> : signed(Number(c.resultUsd), 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollTable>
        )}
      </Section>

      <Section
        id="sa-mm-bd"
        title={tm("bdTitle")}
        sub={tm(`bdNote.${by}`)}
        right={
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-muted md:inline">{tm("bdRight")}</span>
            <button
              type="button"
              aria-expanded={bdOpen}
              aria-controls="sa-mm-bd-body"
              onClick={() => {
                setBdOpen((x) => !x);
              }}
              className="min-h-11 cursor-pointer rounded-control border border-border-input bg-surface px-3 text-sm font-bold text-ink"
            >
              {bdOpen ? tm("bdHide") : tm("bdShow")}
            </button>
          </div>
        }
      >
        <div id="sa-mm-bd-body" className="flex flex-col gap-3">
          {bdOpen ? (
            <>
              <Tabs
                label={tm("groupBy")}
                value={by}
                options={MM_BREAKDOWNS.map((b) => ({ value: b, label: tm(`by.${b}`) }))}
                onChange={setBy}
                panelId="sa-mm-bd-panel"
              />
              <div id="sa-mm-bd-panel" role="tabpanel" aria-labelledby={`sa-mm-bd-panel-${by}`}>
                <MmTable by={by} data={v.breakdown[by]} />
              </div>
            </>
          ) : (
            <MmTable by="level" data={v.breakdown.level} />
          )}
        </div>
      </Section>

      <Fills f={f} ctx={ctx} total={s.fills} feesBp={s.feesBp} />
    </>
  );
}

function Waterfall({
  steps,
  net,
  netSub,
}: {
  steps: { key: string; label: string; sub: string; v: string | null }[];
  net: string | null;
  netSub: string;
}) {
  const tm = useTranslations("signalAnalysis.mm");
  const t = useTranslations("signalAnalysis");
  let run = 0;
  const pts = [0];
  for (const s of steps) {
    run += Number(s.v ?? 0);
    pts.push(run);
  }
  pts.push(Number(net ?? 0));
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || 1;
  const X = (x: number) => ((x - lo) / span) * 100;
  const colors: Record<string, string> = {
    spread: "bg-pos-dot",
    against: "bg-warn-bar",
    fees: "bg-accent",
    inv: "bg-mh-shock-3",
  };
  let acc = 0;
  return (
    <div className="flex flex-col gap-2">
      {steps.map((s) => {
        const a = acc;
        const val = Number(s.v ?? 0);
        acc += val;
        const left = Math.min(X(a), X(acc));
        const width = Math.abs(X(acc) - X(a));
        return (
          <div
            key={s.key}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 md:grid-cols-[170px_minmax(0,1fr)_96px]"
          >
            <div className="min-w-0">
              <div className="text-[13px] font-extrabold">{s.label}</div>
              <div className="text-xs text-muted">{s.sub}</div>
            </div>
            <div
              role="img"
              aria-label={tm("wfAria", { label: s.label, v: s.v === null ? t("na") : usdM(s.v) })}
              className="relative col-span-2 h-5 rounded-[5px] bg-surface-2 md:col-span-1"
            >
              <span
                aria-hidden="true"
                className="absolute top-0 bottom-0 w-px bg-ink-2"
                style={{ left: `${String(X(0))}%` }}
              />
              {s.v === null ? null : (
                <span
                  aria-hidden="true"
                  className={`absolute top-0.5 bottom-0.5 rounded-[3px] ${colors[s.key] ?? ""}`}
                  style={{ left: `${String(left)}%`, width: `${String(Math.max(0.5, width))}%` }}
                />
              )}
            </div>
            <div
              className={`col-start-2 row-start-1 text-right text-[14px] font-extrabold md:col-start-auto md:row-start-auto ${costTone(s.v)}`}
            >
              {s.v === null ? <Na /> : Number(s.v) < 0 ? tm("earned", { v: usdM(s.v) }) : usdM(s.v)}
            </div>
          </div>
        );
      })}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t border-border pt-2 md:grid-cols-[170px_minmax(0,1fr)_96px]">
        <div>
          <div className="text-[13px] font-extrabold">{tm("kNet")}</div>
          <div className="text-xs text-muted">{netSub}</div>
        </div>
        <div
          role="img"
          aria-label={tm("wfAria", { label: tm("kNet"), v: net === null ? t("na") : usdM(net) })}
          className="relative col-span-2 h-5 rounded-[5px] bg-surface-2 md:col-span-1"
        >
          {net === null ? null : (
            <span
              aria-hidden="true"
              className="absolute top-0.5 bottom-0.5 rounded-[3px] bg-ink"
              style={{
                left: `${String(Math.min(X(0), X(Number(net))))}%`,
                width: `${String(Math.max(0.5, Math.abs(X(Number(net)) - X(0))))}%`,
              }}
            />
          )}
        </div>
        <div
          className={`col-start-2 row-start-1 text-right text-[15px] font-extrabold md:col-start-auto md:row-start-auto ${costTone(net)}`}
        >
          {net === null ? <Na /> : usdM(net)}
        </div>
      </div>
    </div>
  );
}

function MmTable({ by, data }: { by: MmBreakdown; data: SignalMmView["breakdown"][MmBreakdown] }) {
  const tm = useTranslations("signalAnalysis.mm");
  const max = Math.max(4, ...data.rows.map((r) => Math.abs(r.netAfterFees ?? 0)));
  const name = (k: string) => {
    if (k === "all") return tm("allFillsRow");
    if (k === "unknown") return tm("unknown");
    switch (by) {
      case "level":
        return tm(`levels.${k as "0"}`);
      case "smart":
        return tm(`onOff.${k as "on"}`);
      case "clamp":
        return tm(`clamps.${k as "hit"}`);
      case "hour":
        return hourRange(Number(k), 4);
      case "size":
        return tm(`sizes.${k as "0"}`);
      case "side":
        return tm(`sideFills.${k as "buy"}`);
      case "market":
        return k;
    }
  };
  const cell = (x: number | null) => (x === null ? <Na /> : signed(x));
  const row = (r: MmRow, all: boolean) => (
    <tr
      key={all ? "__all" : r.key}
      className={all ? "bg-surface-2 font-bold" : r.thin ? "text-muted" : undefined}
    >
      <th scope="row" className={`${td} font-bold`}>
        <span className="inline-flex flex-wrap items-center">
          {name(r.key)}
          {!all && r.thin ? <ThinTag /> : null}
        </span>
      </th>
      <td className={td}>{count(r.n)}</td>
      <td className={td}>{all ? "100%" : r.sharePct === null ? <Na /> : pct(r.sharePct)}</td>
      <td className={td}>{cell(r.spread)}</td>
      <td className={`${td} ${favourTone(r.markout10s)}`}>{cell(r.markout10s)}</td>
      <td className={`${td} ${favourTone(r.markout1m)}`}>{cell(r.markout1m)}</td>
      <td className={`${td} ${favourTone(r.markout5m)}`}>{cell(r.markout5m)}</td>
      <td className={td}>{r.againstPct === null ? <Na /> : pct(r.againstPct)}</td>
      <td className={`${td} font-extrabold ${favourTone(r.netAfterFees)}`}>
        <DivBar v={r.netAfterFees} max={max} bad={(r.netAfterFees ?? 0) < 0} />
        {cell(r.netAfterFees)}
      </td>
      <td className={`${td} ${costTone(r.netPerM)}`}>
        {r.netPerM === null ? <Na /> : usdM(r.netPerM)}
      </td>
    </tr>
  );
  return (
    <ScrollTable label={tm("bdTable", { by: tm(`by.${by}`) })}>
      <table className="w-full min-w-[900px] border-collapse">
        <caption className="sr-only">{tm("bdTable", { by: tm(`by.${by}`) })}</caption>
        <thead>
          <tr>
            <th scope="col" className={th}>
              {tm(`by.${by}`)}
            </th>
            <th scope="col" className={th}>
              {tm("colFills")}
            </th>
            <th scope="col" className={th}>
              {tm("colShare")}
            </th>
            <th scope="col" className={th}>
              <ColHead main={tm("colSpread")} sub="bp" />
            </th>
            <th scope="col" className={th}>
              <ColHead main={tm("colMarkout")} sub={tm("sub10s")} />
            </th>
            <th scope="col" className={th}>
              <ColHead main={tm("colMarkout")} sub={tm("sub1m")} />
            </th>
            <th scope="col" className={th}>
              <ColHead main={tm("colMarkout")} sub={tm("sub5m")} />
            </th>
            <th scope="col" className={th}>
              <ColHead main={tm("colAgainst")} sub={tm("sub1mShort")} />
            </th>
            <th scope="col" className={th}>
              <ColHead main={tm("colNetAfter")} sub={tm("sub1m")} />
            </th>
            <th scope="col" className={th}>
              <ColHead main={tm("colNetCost")} sub={tm("colNetCostSub")} />
            </th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => row(r, false))}
          {row(data.total, true)}
        </tbody>
      </table>
    </ScrollTable>
  );
}

function Fills({
  f,
  ctx,
  total,
  feesBp,
}: {
  f: MmFilters;
  ctx: PageCtx;
  total: number;
  feesBp: number | null;
}) {
  const tm = useTranslations("signalAnalysis.mm");
  const t = useTranslations("signalAnalysis");
  const th2 = useTranslations("signalAnalysis.hz");
  const [sort, setSort] = useState<Sort>("newest");
  const [open, setOpen] = useState<string | null>(null);
  const q = useMmFills(f, ctx.tz, sort, true);
  const items: MmFill[] = q.data?.pages.flatMap((p) => p.items) ?? [];
  const cell = (x: number | null) => (x === null ? <Na /> : signed(x));
  return (
    <Section
      id="sa-mm-fills"
      title={tm("fillsTitle")}
      sub={tm("fillsSub", { n: count(total) })}
      right={
        <Seg
          label={t("sort")}
          value={sort}
          options={[
            { value: "newest", label: tm("sortNewest") },
            { value: "worst", label: tm("sortWorst") },
            { value: "cuts", label: tm("sortCuts") },
          ]}
          onChange={setSort}
        />
      }
    >
      <ScrollTable label={tm("fillsTable")}>
        <table className="w-full min-w-[1040px] border-collapse">
          <caption className="sr-only">{tm("fillsTable")}</caption>
          <thead>
            <tr>
              <th scope="col" className={th}>
                {tm("colFilled", { zone: ctx.utc ? "UTC" : t("yourTime") })}
              </th>
              <th scope="col" className={th}>
                {tm("colMarketBot")}
              </th>
              <th scope="col" className={th}>
                {tm("side")}
              </th>
              <th scope="col" className={th}>
                {tm("whereToQuote")}
              </th>
              <th scope="col" className={th}>
                {tm("colSmartClamp")}
              </th>
              <th scope="col" className={th}>
                <ColHead main={tm("colSize")} sub="USDC" />
              </th>
              <th scope="col" className={th}>
                <ColHead main={tm("colSpread")} sub="bp" />
              </th>
              <th scope="col" className={th}>
                <ColHead main={tm("colMarkout")} sub={th2("10")} />
              </th>
              <th scope="col" className={th}>
                <ColHead main={tm("colMarkout")} sub={th2("60")} />
              </th>
              <th scope="col" className={th}>
                <ColHead main={tm("colMarkout")} sub={th2("300")} />
              </th>
              <th scope="col" className={th}>
                <ColHead main={tm("colNetAfter")} sub={tm("sub1m")} />
              </th>
              <th scope="col" className={th}>
                {tm("colOrder")}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((x) => (
              <tr key={x.id}>
                <td className={td}>
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    onClick={() => {
                      setOpen(x.id);
                    }}
                    className="min-h-6 cursor-pointer border-0 bg-transparent p-0 text-[13px] font-bold text-accent-ink underline"
                  >
                    {clock(x.filledAt, ctx.tz)}
                  </button>
                  <span className="block text-xs text-muted">{day(x.filledAt, ctx.tz)}</span>
                </td>
                <td className={td}>
                  {x.market}
                  <span className="block text-xs text-muted">{x.botName}</span>
                </td>
                <td className={`${td} font-bold ${x.side === "buy" ? "text-pos" : "text-neg"}`}>
                  {tm(`sides.${x.side}`)}
                </td>
                <td className={td}>
                  {x.level === null ? <Na /> : tm(`levels.${String(Math.min(3, x.level)) as "0"}`)}
                </td>
                <td className={td}>
                  {x.smart === null ? (
                    <Na />
                  ) : x.smart ? (
                    tm("smartClamp", { clamp: x.clamp === "hit" ? tm("clampYes") : tm("clampNo") })
                  ) : (
                    tm("onOff.off")
                  )}
                </td>
                <td className={td}>{Number(x.usd).toFixed(2)}</td>
                <td className={`${td} ${favourTone(x.spread)}`}>{cell(x.spread)}</td>
                <td className={`${td} ${favourTone(x.markout10s)}`}>{cell(x.markout10s)}</td>
                <td className={`${td} ${favourTone(x.markout1m)}`}>{cell(x.markout1m)}</td>
                <td className={`${td} ${favourTone(x.markout5m)}`}>{cell(x.markout5m)}</td>
                <td className={`${td} font-extrabold ${favourTone(x.netAfterFees)}`}>
                  {cell(x.netAfterFees)}
                </td>
                <td className={td}>
                  {x.kind === "cut" ? (
                    <span className="rounded-full bg-unknown-bg px-2 py-0.5 text-xs font-bold text-unknown">
                      {tm("kinds.cut")}
                    </span>
                  ) : (
                    tm(`kinds.${x.kind}`)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollTable>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>{tm("fillsFoot", { fees: feesBp === null ? t("na") : feesBp.toFixed(2) })}</span>
        {q.hasNextPage ? (
          <button
            type="button"
            disabled={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
            className="min-h-11 cursor-pointer rounded-control border border-border-input bg-surface px-4 text-sm font-bold text-ink"
          >
            {t("loadMore")}
          </button>
        ) : null}
      </div>
      <MmFillDetail
        id={open}
        f={f}
        ctx={ctx}
        onClose={() => {
          setOpen(null);
        }}
      />
    </Section>
  );
}
