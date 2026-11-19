"use client";

import {
  SIGNAL_RANGES,
  VB_BREAKDOWNS,
  VB_REGIMES,
  type SignalSuggestion,
  type SignalVbView,
  type VbBreakdown,
  type VbEntry,
  type VbRow,
} from "@drift/shared";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { ApiError } from "@/lib/api";

import { useSignalVb, useVbEntries, VB_DEFAULT, type VbFilters, isAnalysisTimeout } from "../api";
import {
  clock,
  count,
  day,
  favourTone,
  hourRange,
  pct,
  signed,
  usdc,
  usdM,
  volume,
} from "../format";

import {
  BotSelect,
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
import { BarsWithDots, Legend, LineChart } from "./charts";
import type { PageCtx } from "./signal-analysis-page";
import { VbEntryDetail } from "./vb-detail";

const HZ = ["10", "30", "60", "120", "300"] as const;
const FAST = 4;
type Sort = "newest" | "worst" | "move";

export function VbTab({ ctx }: { ctx: PageCtx }) {
  const t = useTranslations("signalAnalysis");
  const tv = useTranslations("signalAnalysis.vb");
  const [f, setF] = useState<VbFilters>(VB_DEFAULT);
  const q = useSignalVb(f, ctx.tz, true);
  const v = q.data;
  const { onMeta, onForbidden } = ctx;
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.code === "FORBIDDEN") onForbidden();
  }, [q.error, onForbidden]);
  useEffect(() => {
    onMeta(v === undefined ? null : { bots: v.bots, computedAt: v.computedAt });
  }, [v, onMeta]);
  const keepSel = useKeepSelected();
  const set = (p: Partial<VbFilters>) => {
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
          <BotSelect
            label={t("filters.bot")}
            allLabel={t("filters.allVbBots")}
            strategy="volume_farm"
            bots={v?.botList ?? []}
            value={f.botId}
            tz={ctx.tz}
            onChange={(b) => {
              set({ botId: b });
            }}
          />
          <FilterSelect
            label={tv("regime")}
            value={f.regime ?? ""}
            options={[
              { value: "", label: tv("allRegimes") },
              ...VB_REGIMES.map((r) => ({ value: r, label: tv(`regimes.${r}`) })),
            ]}
            onChange={(r) => {
              set({ regime: r === "" ? null : r });
            }}
          />
          <div className="flex flex-col gap-1">
            <span id="sa-vb-et" className="text-[12.5px] font-bold text-ink-2">
              {tv("entryType")}
            </span>
            <Seg
              labelId="sa-vb-et"
              value={f.entryType ?? "all"}
              options={[
                { value: "all", label: t("filters.all") },
                { value: "signal", label: tv("types.signal") },
                { value: "balance", label: tv("types.balance") },
              ]}
              onChange={(x) => {
                set({ entryType: x === "all" ? null : x });
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span id="sa-vb-rv" className="text-[12.5px] font-bold text-ink-2">
              {tv("reverse")}
            </span>
            <Seg
              labelId="sa-vb-rv"
              value={f.reversed ?? "all"}
              options={[
                { value: "all", label: t("filters.all") },
                { value: "on", label: t("filters.on") },
                { value: "off", label: t("filters.off") },
              ]}
              onChange={(x) => {
                set({ reversed: x === "all" ? null : x });
              }}
            />
          </div>
        </div>
        <p className="m-0 text-[12.5px] text-muted">
          {t("scope.vb", { bots: v?.bots ?? 0, accounts: v?.accounts ?? 0 })}
        </p>
        {v !== undefined && v.summary.noSnapshot > 0 ? (
          <p className="m-0 text-[12.5px] text-muted">
            {tv("noSnapshot", { n: v.summary.noSnapshot })}
          </p>
        ) : null}
      </section>
      {q.isError && v !== undefined ? (
        <StaleNote time={clock(v.computedAt, ctx.tz, false)} />
      ) : null}
      {q.isPending ? (
        <StateBox kind="loading" what={t("states.whatEntries")} />
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
      ) : v === undefined ? null : v.summary.entries === 0 ? (
        <StateBox
          kind="empty"
          what=""
          emptyTitle={t("states.emptyVb")}
          onClear={() => {
            setF({ ...VB_DEFAULT, range: "30d" });
          }}
        />
      ) : (
        <Refreshing on={q.isPlaceholderData}>
          <VbBody v={v} f={f} ctx={ctx} />
        </Refreshing>
      )}
    </>
  );
}

function VbBody({ v, f, ctx }: { v: SignalVbView; f: VbFilters; ctx: PageCtx }) {
  const t = useTranslations("signalAnalysis");
  const tv = useTranslations("signalAnalysis.vb");
  const th2 = useTranslations("signalAnalysis.hz");
  const [by, setBy] = useState<VbBreakdown>("regime");
  const [win, setWin] = useState<"m1" | "m3" | "m5">("m3");
  const s = v.summary;
  const na = t("na");
  const bp = (x: number | null) => (x === null ? na : `${signed(x)} bp`);
  const jump = (k: VbBreakdown | "markout" | "move") => {
    if (k === "markout") document.getElementById("sa-vb-mk")?.scrollIntoView();
    else if (k === "move") document.getElementById("sa-vb-mv")?.scrollIntoView();
    else {
      setBy(k);
      document.getElementById("sa-vb-bd")?.scrollIntoView();
    }
  };
  const feeShare = s.net !== null && s.fees !== null && s.net < 0 ? (s.fees / s.net) * 100 : null;
  const render = (x: SignalSuggestion) => {
    const vals = x.values;
    const link: Record<string, [string, () => void]> = {
      fastMove: [
        tv("links.move"),
        () => {
          jump("move");
        },
      ],
      pullback: [
        tv("links.markout"),
        () => {
          jump("markout");
        },
      ],
      pullbackNoSeconds: [
        tv("links.markout"),
        () => {
          jump("markout");
        },
      ],
      momentum: [
        tv("links.part"),
        () => {
          jump("part");
        },
      ],
      signalVsBalance: [
        tv("links.type"),
        () => {
          jump("entryType");
        },
      ],
      signalVsBalanceShort: [
        tv("links.type"),
        () => {
          jump("entryType");
        },
      ],
    };
    const [l, go] = link[x.key] ?? ["", () => undefined];
    return {
      title: tv(`sug.${x.key}.title` as "sug.fastMove.title"),
      body: tv.rich(`sug.${x.key}.body` as "sug.fastMove.body", {
        ...vals,
        b: (c) => <b className="text-ink">{c}</b>,
      }),
      link: l,
      onLink: go,
    };
  };
  const buckets = v.moveBefore[win];
  const totalMv = buckets.reduce((a, b) => a + b.n, 0);
  const fastN = buckets
    .filter((b) => b.key === "4-6" || b.key === "6+")
    .reduce((a, b) => a + b.n, 0);

  return (
    <>
      {s.entries < 30 ? <ThinBanner n={s.entries} unit="entries" /> : null}
      <Section
        id="sa-vb-sum"
        title={tv("sumTitle", { range: t(`filters.ranges.${v.range}`), n: count(s.entries) })}
        sub={tv("sumSub")}
      >
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-5">
          <Kpi
            label={tv("kEntries")}
            value={count(s.entries)}
            sub={tv("kEntriesSub", {
              volume: volume(s.volume),
              signal: count(s.signal),
              balance: count(s.balance),
            })}
          />
          <Kpi
            label={tv("kTiming")}
            value={bp(s.beforeFees)}
            valueTone={favourTone(s.beforeFees)}
            sub={tv("kTimingSub", {
              perM: s.beforeFeesPerM === null ? na : usdM(s.beforeFeesPerM),
            })}
          />
          <Kpi
            label={tv("kFees")}
            value={bp(s.fees)}
            valueTone={favourTone(s.fees)}
            sub={tv("kFeesSub", {
              perM: s.feesPerM === null ? na : usdM(s.feesPerM),
              sodex: s.sodexFees === null ? na : signed(s.sodexFees),
              builder: s.builderFees === null ? na : signed(s.builderFees),
            })}
          />
          <Kpi
            label={tv("kNet")}
            value={bp(s.net)}
            valueTone={favourTone(s.net)}
            sub={tv("kNetSub", {
              perM: s.netPerM === null ? na : usdM(s.netPerM),
              usd: s.netUsd === null ? na : usdc(s.netUsd),
            })}
          />
          <Kpi
            label={tv("kOpposite")}
            value={bp(s.oppositeNet)}
            valueTone={favourTone(s.oppositeNet)}
            sub={
              s.oppositeNet === null || s.net === null
                ? tv("kOppositeNa")
                : tv("kOppositeSub", {
                    diff: signed(s.oppositeNet - s.net),
                    perM: s.oppositeNetPerM === null ? na : usdM(s.oppositeNetPerM),
                    n: count(s.oppositeN),
                  })
            }
          />
        </div>
        <div className="grid gap-3 lg:grid-cols-[1fr_300px]">
          <div className="flex min-w-0 flex-col gap-2">
            <h3 className="m-0 text-sm font-extrabold">{tv("lossTitle")}</h3>
            <LossBar
              label={tv("actual")}
              sub={tv("asTraded")}
              parts={[s.beforeFees, s.sodexFees, s.builderFees]}
              total={s.net}
              perM={s.netPerM}
            />
            <LossBar
              label={tv("opposite")}
              sub={tv("sameMoments")}
              parts={[s.opposite, s.sodexFees, s.builderFees]}
              total={s.oppositeNet}
              perM={s.oppositeNetPerM}
            />
            <Legend
              items={[
                { label: tv("legendTiming"), swatch: "bg-warn-bar" },
                { label: tv("legendSodex"), swatch: "bg-accent" },
                { label: tv("legendBuilder"), swatch: "bg-mh-vol-2" },
              ]}
            />
          </div>
          <div className="rounded-tile bg-surface-2 px-3.5 py-3 text-[13px] text-ink-2">
            {feeShare === null ? null : (
              <b className="text-ink">{tv("insightFees", { share: pct(feeShare) })} </b>
            )}
            {s.beforeFees !== null && s.beforeFees < 0
              ? tv("insightTiming", { bp: Math.abs(s.beforeFees).toFixed(1) })
              : null}{" "}
            {s.opposite !== null ? tv("insightOpposite", { bp: signed(s.opposite) }) : null}
            <span className="mt-1 block text-xs text-muted">{tv("assumption")}</span>
          </div>
        </div>
      </Section>

      <Suggestions
        id="sa-vb-sug"
        unit="entries"
        items={v.suggestions}
        hidden={v.hidden}
        render={render}
        hiddenLabel={(h) => tv(`hiddenLead.${h.key}` as "hiddenLead.fastMove", { n: h.n })}
        footer={tv("sugFoot")}
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <Section id="sa-vb-mk" title={tv("mkTitle")} sub={tv("mkSub")}>
          <Legend
            items={[
              { label: tv("legendMean"), swatch: "bg-accent", line: true },
              { label: tv("legendBand"), swatch: "bg-mh-vol-1" },
              { label: tv("legendOpposite"), swatch: "bg-warn-bar", line: true },
            ]}
          />
          <LineChart
            label={tv("mkAria", {
              first: bp(v.markout.actual[0]?.mean ?? null),
              last: bp(v.markout.actual[4]?.mean ?? null),
            })}
            xLabels={HZ.map((h) => th2(h))}
            series={[
              {
                key: "actual",
                values: v.markout.actual.map((x) => x.mean),
                stroke: "stroke-accent",
                endLabel: tv("endActual", { v: bp(v.markout.actual.at(-1)?.mean ?? null) }),
              },
              {
                key: "opp",
                values: v.markout.opposite,
                stroke: "stroke-warn-bar",
                dashed: true,
                endLabel: tv("endOpposite", { v: bp(v.markout.opposite.at(-1) ?? null) }),
              },
            ]}
            band={{
              lo: v.markout.actual.map((x) => x.p25),
              hi: v.markout.actual.map((x) => x.p75),
            }}
          />
          <ScrollTable label={tv("mkTable")}>
            <table className="w-full min-w-[460px] border-collapse">
              <caption className="sr-only">{tv("mkTable")}</caption>
              <thead>
                <tr>
                  <th scope="col" className={th}>
                    {tv("afterFill")}
                  </th>
                  {HZ.map((h) => (
                    <th key={h} scope="col" className={th}>
                      {th2(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" className={`${td} font-bold`}>
                    {tv("legendMean")}
                  </th>
                  {v.markout.actual.map((x, i) => (
                    <td key={i} className={`${td} ${favourTone(x.mean)}`}>
                      {x.mean === null ? <Na /> : signed(x.mean)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row" className={`${td} font-bold`}>
                    {tv("p25p75")}
                  </th>
                  {v.markout.actual.map((x, i) => (
                    <td key={i} className={td}>
                      {x.p25 === null || x.p75 === null ? (
                        <Na />
                      ) : (
                        tv("range", { lo: signed(x.p25), hi: signed(x.p75) })
                      )}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row" className={`${td} font-bold`}>
                    {tv("behind")}
                  </th>
                  {v.markout.actual.map((x, i) => (
                    <td key={i} className={td}>
                      {x.againstPct === null ? <Na /> : pct(x.againstPct)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th scope="row" className={`${td} font-bold`}>
                    {tv("oppositeMean")}
                  </th>
                  {v.markout.opposite.map((x, i) => (
                    <td key={i} className={td}>
                      {x === null ? <Na /> : signed(x)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </ScrollTable>
          <p className="m-0 text-xs text-muted">{tv("mkFoot")}</p>
        </Section>
        <Section
          id="sa-vb-mv"
          title={tv("mvTitle")}
          sub={tv("mvSub")}
          right={
            <Seg
              label={tv("window")}
              value={win}
              options={[
                { value: "m1", label: th2("60") },
                { value: "m3", label: th2("180") },
                { value: "m5", label: th2("300") },
              ]}
              onChange={setWin}
            />
          }
        >
          <Legend
            items={[
              { label: tv("legendActualBf"), swatch: "bg-neg" },
              { label: tv("legendOppositeBf"), swatch: "bg-warn-bar rounded-full" },
            ]}
          />
          <BarsWithDots
            label={tv("mvAria", { win: win.slice(1) })}
            cats={buckets.map((b) => ({
              label: tv(`buckets.${b.key}`),
              sub: `${count(b.n)} · ${totalMv > 0 ? pct((b.n / totalMv) * 100) : na}`,
              thin: b.thin,
            }))}
            bars={buckets.map((b) => b.beforeFees)}
            dots={buckets.map((b) => b.opposite)}
          />
          <p className="m-0 text-xs text-muted">
            {tv.rich("mvFoot", {
              win: win.slice(1),
              n: count(fastN),
              share: totalMv > 0 ? pct((fastN / totalMv) * 100) : na,
              b: (c) => <b className="text-ink">{c}</b>,
            })}
          </p>
        </Section>
      </div>

      <Section
        id="sa-vb-bd"
        title={tv("bdTitle")}
        sub={tv(`bdNote.${by}`)}
        right={<span className="text-xs text-muted">{tv("bdRight")}</span>}
      >
        <Tabs
          label={tv("groupBy")}
          value={by}
          options={VB_BREAKDOWNS.map((b) => ({ value: b, label: tv(`by.${b}`) }))}
          onChange={setBy}
          panelId="sa-vb-bd-panel"
        />
        <div id="sa-vb-bd-panel" role="tabpanel" aria-labelledby={`sa-vb-bd-panel-${by}`}>
          <VbTable by={by} data={v.breakdown[by]} />
        </div>
      </Section>

      <Entries f={f} ctx={ctx} total={s.entries} />
    </>
  );
}

function LossBar({
  label,
  sub,
  parts,
  total,
  perM,
}: {
  label: string;
  sub: string;
  parts: readonly (number | null)[];
  total: number | null;
  perM: string | null;
}) {
  const t = useTranslations("signalAnalysis");
  const tv = useTranslations("signalAnalysis.vb");
  const na = t("na");
  const abs = parts.map((x) => Math.abs(x ?? 0));
  const span = Math.max(
    1,
    abs.reduce((a, b) => a + b, 0),
  );
  const colors = ["bg-warn-bar text-ink", "bg-accent text-white", "bg-mh-vol-2 text-ink"];
  const names = [tv("legendTiming"), tv("legendSodex"), tv("legendBuilder")];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 md:grid-cols-[140px_minmax(0,1fr)_90px]">
      <div>
        <div className="text-[13px] font-extrabold">{label}</div>
        <div className="text-xs text-muted">{sub}</div>
      </div>
      <div
        role="img"
        aria-label={tv("lossAria", {
          label,
          parts: parts
            .map((x, i) => `${names[i] ?? ""} ${x === null ? na : signed(x)} bp`)
            .join(", "),
          total: total === null ? na : signed(total),
        })}
        className="col-span-2 flex h-7 overflow-hidden rounded-[6px] bg-surface-2 md:col-span-1"
      >
        {parts.map((x, i) =>
          x === null || x === 0 ? null : (
            <span
              key={i}
              aria-hidden="true"
              title={`${names[i] ?? ""}: ${signed(x)} bp`}
              className={`flex items-center justify-center text-xs font-bold ${colors[i] ?? ""}`}
              style={{ width: `${String(((abs[i] ?? 0) / span) * 100)}%` }}
            >
              {(abs[i] ?? 0) / span > 0.1 ? signed(x) : ""}
            </span>
          ),
        )}
      </div>
      <div className="col-start-2 row-start-1 text-right md:col-start-auto md:row-start-auto">
        <div className={`text-[15px] font-extrabold ${favourTone(total)}`}>
          {total === null ? <Na /> : `${signed(total)} bp`}
        </div>
        <div className="text-xs text-muted">{perM === null ? na : `${usdM(perM)} / 1M`}</div>
      </div>
    </div>
  );
}

function VbTable({ by, data }: { by: VbBreakdown; data: SignalVbView["breakdown"][VbBreakdown] }) {
  const tv = useTranslations("signalAnalysis.vb");
  const max = Math.max(4, ...data.rows.map((r) => Math.abs(r.beforeFees ?? 0)));
  const name = (k: string) => {
    if (k === "all" || k === "allSignal") return tv(k === "all" ? "allEntries" : "allSignal");
    if (k === "unknown") return tv("unknown");
    switch (by) {
      case "regime":
        return tv(`regimes.${k as "up"}`);
      case "score":
        return tv(`scores.${k as "50"}`);
      case "part":
        return tv(`parts.${k as "momentum"}`);
      case "exit":
        return tv(`exits.${k as "hold"}`);
      case "entryType":
        return tv(`types.${k as "signal"}`);
      case "hour":
        return hourRange(Number(k), 4);
      case "size":
        return tv(`sizes.${k as "0"}`);
      case "market":
        return k;
    }
  };
  const cell = (x: number | null) => (x === null ? <Na /> : signed(x));
  const row = (r: VbRow, all: boolean) => (
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
      <td className={td}>{cell(r.moveBefore3)}</td>
      <td className={`${td} ${favourTone(r.markout1m)}`}>{cell(r.markout1m)}</td>
      <td className={`${td} font-bold ${favourTone(r.beforeFees)}`}>
        <DivBar v={r.beforeFees} max={max} bad={(r.beforeFees ?? 0) < 0} />
        {cell(r.beforeFees)}
      </td>
      <td className={td}>{cell(r.fees)}</td>
      <td className={`${td} font-extrabold ${favourTone(r.net)}`}>{cell(r.net)}</td>
      <td className={td}>{r.netPerM === null ? <Na /> : usdM(r.netPerM)}</td>
      <td className={td}>{cell(r.oppositeNet)}</td>
    </tr>
  );
  return (
    <ScrollTable label={tv("bdTable", { by: tv(`by.${by}`) })}>
      <table className="w-full min-w-[860px] border-collapse">
        <caption className="sr-only">{tv("bdTable", { by: tv(`by.${by}`) })}</caption>
        <thead>
          <tr>
            <th scope="col" className={th}>
              {tv(`by.${by}`)}
            </th>
            <th scope="col" className={th}>
              {tv("colEntries")}
            </th>
            <th scope="col" className={th}>
              {tv("colShare")}
            </th>
            <th scope="col" className={th}>
              <ColHead main={tv("colMove")} sub={tv("colMoveSub")} />
            </th>
            <th scope="col" className={th}>
              <ColHead main={tv("colMarkout")} sub={tv("colMarkoutSub")} />
            </th>
            <th scope="col" className={th}>
              <ColHead main={tv("colBefore")} sub="bp" />
            </th>
            <th scope="col" className={th}>
              <ColHead main={tv("colFees")} sub="bp" />
            </th>
            <th scope="col" className={th}>
              <ColHead main={tv("colNet")} sub="bp" />
            </th>
            <th scope="col" className={th}>
              <ColHead main={tv("colNet")} sub="$ / 1M" />
            </th>
            <th scope="col" className={th}>
              <ColHead main={tv("colOpp")} sub={tv("colOppSub")} />
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

function Entries({ f, ctx, total }: { f: VbFilters; ctx: PageCtx; total: number }) {
  const tv = useTranslations("signalAnalysis.vb");
  const t = useTranslations("signalAnalysis");
  const [sort, setSort] = useState<Sort>("newest");
  const [open, setOpen] = useState<string | null>(null);
  const q = useVbEntries(f, ctx.tz, sort, true);
  const items: VbEntry[] = q.data?.pages.flatMap((p) => p.items) ?? [];
  const cell = (x: number | null) => (x === null ? <Na /> : signed(x));
  return (
    <Section
      id="sa-vb-entries"
      title={tv("entriesTitle")}
      sub={tv("entriesSub", { n: count(total) })}
      right={
        <Seg
          label={t("sort")}
          value={sort}
          options={[
            { value: "newest", label: tv("sortNewest") },
            { value: "worst", label: tv("sortWorst") },
            { value: "move", label: tv("sortMove") },
          ]}
          onChange={setSort}
        />
      }
    >
      <ScrollTable label={tv("entriesTable")}>
        <table className="w-full min-w-[980px] border-collapse">
          <caption className="sr-only">{tv("entriesTable")}</caption>
          <thead>
            <tr>
              <th scope="col" className={th}>
                {tv("colFilled", { zone: ctx.utc ? "UTC" : t("yourTime") })}
              </th>
              <th scope="col" className={th}>
                {tv("colMarketBot")}
              </th>
              <th scope="col" className={th}>
                {tv("colSide")}
              </th>
              <th scope="col" className={th}>
                {tv("entryType")}
              </th>
              <th scope="col" className={th}>
                {tv("colScore")}
              </th>
              <th scope="col" className={th}>
                <ColHead main={tv("colMove")} sub={tv("colMoveSub")} />
              </th>
              <th scope="col" className={th}>
                <ColHead main={tv("colMarkout")} sub={tv("colMarkoutSub")} />
              </th>
              <th scope="col" className={th}>
                {tv("colExit")}
              </th>
              <th scope="col" className={th}>
                <ColHead main={tv("colBefore")} sub="bp" />
              </th>
              <th scope="col" className={th}>
                <ColHead main={tv("colNet")} sub="bp" />
              </th>
              <th scope="col" className={th}>
                <ColHead main={tv("colOpp")} sub={tv("colOppSub")} />
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id}>
                <td className={td}>
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    onClick={() => {
                      setOpen(e.id);
                    }}
                    className="min-h-6 cursor-pointer border-0 bg-transparent p-0 text-[13px] font-bold text-accent-ink underline"
                  >
                    {clock(e.filledAt, ctx.tz)}
                  </button>
                  <span className="block text-xs text-muted">{day(e.filledAt, ctx.tz)}</span>
                </td>
                <td className={td}>
                  {e.market}
                  <span className="block text-xs text-muted">{e.botName}</span>
                </td>
                <td className={`${td} font-bold ${e.side === "long" ? "text-pos" : "text-neg"}`}>
                  {tv(`sides.${e.side}`)}
                </td>
                <td className={td}>{e.entryType === null ? <Na /> : tv(`types.${e.entryType}`)}</td>
                <td className={td}>{e.score === null ? "—" : Math.round(e.score)}</td>
                <td
                  className={`${td} ${e.moveBefore3 !== null && e.moveBefore3 >= FAST ? "font-extrabold" : ""}`}
                >
                  {e.moveBefore3 !== null && e.moveBefore3 >= FAST ? "▲ " : ""}
                  {cell(e.moveBefore3)}
                </td>
                <td className={`${td} ${favourTone(e.markout1m)}`}>{cell(e.markout1m)}</td>
                <td className={td}>{e.exit === null ? <Na /> : tv(`exits.${e.exit}`)}</td>
                <td className={`${td} ${favourTone(e.beforeFees)}`}>{cell(e.beforeFees)}</td>
                <td className={`${td} font-extrabold ${favourTone(e.net)}`}>{cell(e.net)}</td>
                <td className={`${td} ${favourTone(e.oppositeNet)}`}>{cell(e.oppositeNet)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollTable>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>{tv("entriesFoot")}</span>
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
      <VbEntryDetail
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
