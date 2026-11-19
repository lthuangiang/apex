"use client";

import type {
  ResearchLevelRow,
  ResearchPaperBot,
  ResearchRange,
  ResearchRisk,
  ResearchSource,
  ResearchSummary,
  ResearchSummaryRow,
  ResearchDirectionRow,
} from "@drift/shared";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";

import { ApiError } from "@/lib/api";

import { Refreshing, ScrollTable, StateBox, StaleNote } from "../components/bits";
import type { PageCtx } from "../components/signal-analysis-page";
import { clock, count, monthDay } from "../format";

import { useResearchSummary } from "./api";
import { balance, delay, pctPlain, pctSigned, tone } from "./format";
import { NewsTrace, type TraceRequest } from "./news-trace";
import type { Tr } from "./text";
import { ResearchTrades } from "./trades";
import {
  Block,
  Dash,
  LabelPill,
  LEVEL_TONE,
  Na,
  Note,
  NotEnough,
  Pill,
  SIDE_TONE,
  STATUS_TONE,
  Sub,
  tdR,
  tdW,
  thR,
} from "./ui";
import { NewsVersions } from "./versions";

// Tab "Signal research" (team, #273; thiết kế docs/mockups/signal-research, #269 v3.4). Chỉ nghiên cứu, tiền giả: tin
// được giao dịch paper khi xảy ra, whales / funding / price patterns chạy lại mỗi đêm. Không gì được gửi tới SoDEX. Mọi
// số đến từ API team của #271; thiếu thì hiện "Not available" / "Not enough trades", không bao giờ 0 (quy tắc 1.8).
// Dưới 768px theo mockup 390: News feed + funnel trace (#292), "Where each type stands" (thẻ) và "Trades" (thẻ).

export function ResearchTab({ ctx }: { ctx: PageCtx }) {
  const t = useTranslations("signalAnalysis.research");
  const [range, setRange] = useState<ResearchRange>("1d");
  const [trace, setTrace] = useState<TraceRequest | null>(null);
  // #306: News bot version của tổng kết, feed, trace và bảng Trades; null = Baseline (mặc định của API).
  const [versionId, setVersionId] = useState<string | null>(null);
  const q = useResearchSummary(range, versionId);
  const v = q.data;
  const { onMeta, onForbidden } = ctx;
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.code === "FORBIDDEN") onForbidden();
  }, [q.error, onForbidden]);
  useEffect(() => {
    onMeta(v === undefined ? null : { bots: null, computedAt: v.computedAt });
  }, [v, onMeta]);

  if (q.isPending) return <StateBox kind="loading" what={t("states.what")} />;
  if (q.isError && v === undefined)
    return <StateBox kind="error" what="" onRetry={() => void q.refetch()} />;
  if (v === undefined) return null;
  const empty =
    v.sources.length === 0 && v.bots.length === 0 && v.funnel === null && v.rows.length === 0;
  if (empty)
    return (
      <StateBox
        kind="empty"
        what=""
        emptyTitle={t("states.emptyTitle")}
        emptyBody={t("states.emptyBody")}
      />
    );
  return (
    <>
      {q.isError ? <StaleNote time={clock(v.computedAt, ctx.tz, false)} /> : null}
      <Refreshing on={q.isPlaceholderData}>
        <Body
          v={v}
          ctx={ctx}
          versionId={versionId}
          onVersion={setVersionId}
          news={
            <NewsTrace
              ctx={ctx}
              funnel={v.funnel}
              range={range}
              onRange={setRange}
              request={trace}
              versionId={versionId}
            />
          }
        />
      </Refreshing>
      <ResearchTrades
        ctx={ctx}
        assets={v.assets}
        versionId={versionId}
        onTrace={(id) => {
          setTrace((x) => ({ id, seq: (x?.seq ?? 0) + 1 }));
        }}
      />
    </>
  );
}

function Body({
  v,
  ctx,
  news,
  versionId,
  onVersion,
}: {
  v: ResearchSummary;
  ctx: PageCtx;
  news: ReactNode;
  versionId: string | null;
  onVersion: (id: string) => void;
}) {
  return (
    <>
      <Sources items={v.sources} now={v.computedAt} tz={ctx.tz} />
      <PaperBots
        bots={v.bots}
        tz={ctx.tz}
        versionId={versionId}
        onVersion={onVersion}
        summaryVersion={v.version?.id ?? null}
      />
      {news}
      <Rules version={v.newsRulesVersion} levels={v.levels} />
      <Summary
        rows={v.rows}
        directions={v.directions}
        costPct={v.costPct}
        risk={v.risk}
        tz={ctx.tz}
      />
    </>
  );
}

/* ---------------------------------------------------------------- Sources */

const DOT = { live: "bg-pos-dot", delayed: "bg-warn-bar", down: "bg-neg" } as const;

function Sources({ items, now, tz }: { items: ResearchSource[]; now: string; tz: string }) {
  const t = useTranslations("signalAnalysis.research.sources");
  const line = (s: ResearchSource): { text: string; statusShown: boolean } => {
    const name = t(`names.${s.key}`);
    const status = t(`status.${s.status}`);
    if (s.mode === "live") {
      if (s.lastAt === null) return { text: t("live", { name, status }), statusShown: true };
      const secs = Math.max(0, Math.round((Date.parse(now) - Date.parse(s.lastAt)) / 1000));
      return { text: t("liveAgo", { name, status, ago: delay(secs) }), statusShown: true };
    }
    if (s.lastAt === null) return { text: t("live", { name, status }), statusShown: true };
    const time = clock(s.lastAt, tz, false);
    if (s.status === "down")
      return { text: t("replayStatus", { name, status, time }), statusShown: true };
    if (s.gap !== null) {
      const hours = Math.round((Date.parse(s.gap.to) - Date.parse(s.gap.from)) / 3_600_000);
      return {
        text: t("replayGap", { name, time, hours, day: monthDay(s.gap.from, tz) }),
        statusShown: false,
      };
    }
    return { text: t("replayed", { name, time }), statusShown: false };
  };
  return (
    <section
      aria-labelledby="sr-src"
      // #297: hiện cả trên điện thoại (gọn hơn), cùng chấm trạng thái.
      className="flex flex-wrap items-center gap-x-[22px] gap-y-2 rounded-card bg-surface px-4 py-3.5 md:gap-y-2.5 md:px-5 md:py-[18px]"
    >
      <h2 id="sr-src" className="m-0 text-sm font-extrabold md:text-[15px]">
        {t("title")}
      </h2>
      {items.length === 0 ? (
        <Na />
      ) : (
        <ul className="m-0 flex list-none flex-wrap items-center gap-x-4 gap-y-1.5 p-0 md:gap-x-[22px] md:gap-y-2.5">
          {items.map((s) => {
            const l = line(s);
            return (
              <li key={s.key} className="inline-flex items-center gap-1.5 text-[13px] md:text-sm">
                <span aria-hidden="true" className={`size-2 rounded-full ${DOT[s.status]}`} />
                {l.text}
                {l.statusShown ? null : (
                  <span className="sr-only">
                    {" "}
                    {t("statusSr", { status: t(`status.${s.status}`) })}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- Paper bots */

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-bold text-muted">{label}</div>
      <div className="font-extrabold">{value}</div>
    </div>
  );
}

const btn =
  "inline-flex min-h-11 items-center rounded-control border border-border-input bg-surface px-4 font-bold text-ink no-underline disabled:cursor-not-allowed disabled:opacity-60";

function BotCard({
  title,
  pill,
  body,
  children,
  actions,
}: {
  title: string;
  pill: ReactNode;
  body: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-tile border border-border p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-[17px] font-extrabold">{title}</h3>
        {pill}
      </div>
      <p className="m-0 text-[13px] leading-normal text-ink-2">{body}</p>
      {children}
      {actions === undefined ? null : <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

function BotPill({ bot }: { bot: ResearchPaperBot }) {
  const t = useTranslations("signalAnalysis.research.bots");
  if (bot.state === "paused") return <Pill tone="neutral">{t("state.paused")}</Pill>;
  return bot.mode === "live" ? (
    <Pill tone="pos">{t("state.live")}</Pill>
  ) : (
    <Pill tone="neutral">{t("state.replay")}</Pill>
  );
}

function PaperBots({
  bots,
  tz,
  versionId,
  onVersion,
  summaryVersion,
}: {
  bots: ResearchPaperBot[];
  tz: string;
  versionId: string | null;
  onVersion: (id: string) => void;
  /** Version mà tổng kết (và lãi / lỗ chưa chốt của bot News) đang mô tả. */
  summaryVersion: string | null;
}) {
  const t = useTranslations("signalAnalysis.research.bots");
  const by = (k: ResearchPaperBot["type"]) => bots.find((b) => b.type === k);
  const news = by("news");
  const whales = by("whales");
  const funding = by("funding");
  const price = by("price");
  const group = funding ?? price;
  const bal = (b: ResearchPaperBot | undefined) =>
    b === undefined || b.balance === null ? <Na /> : balance(b.balance);
  const ver = (b: ResearchPaperBot) =>
    b.rulesVersion === null ? <Na /> : t("version", { v: b.rulesVersion });
  // #306: lane News là các News bot version (thẻ + bảng, `NewsVersions`); thẻ bot replay giữ như trước.
  const others =
    whales === undefined && group === undefined ? null : (
      <div className="grid grid-cols-[repeat(auto-fit,minmax(290px,1fr))] gap-3.5 max-md:hidden">
        {whales === undefined ? null : (
          <BotCard
            title={t("names.whales")}
            pill={<BotPill bot={whales} />}
            body={t("body.whales")}
            actions={
              <>
                <button type="button" disabled className={btn}>
                  {t("pauseReplays")}
                </button>
                <button type="button" disabled className={btn}>
                  {t("rules")}
                </button>
              </>
            }
          >
            <div className="grid grid-cols-3 gap-2">
              <Stat label={t("balance")} value={bal(whales)} />
              <Stat
                label={t("lastRun")}
                value={
                  whales.lastRun === null ? (
                    <Na />
                  ) : (
                    t("lastRunValue", {
                      time: clock(whales.lastRun.at, tz, false),
                      n: whales.lastRun.trades,
                    })
                  )
                }
              />
              <Stat label={t("rules")} value={ver(whales)} />
            </div>
          </BotCard>
        )}
        {group === undefined ? null : (
          <BotCard title={t("names.group")} pill={<BotPill bot={group} />} body={t("body.group")}>
            <div className="grid grid-cols-2 gap-2">
              <Stat label={t("fundingBalance")} value={bal(funding)} />
              <Stat label={t("priceBalance")} value={bal(price)} />
            </div>
          </BotCard>
        )}
      </div>
    );
  return (
    <Block id="sr-bots" title={t("title")}>
      <NewsVersions
        tz={tz}
        selected={versionId}
        onSelect={onVersion}
        others={others}
        unrealized={
          summaryVersion === null || news === undefined
            ? null
            : { versionId: summaryVersion, value: news.unrealized }
        }
      />
    </Block>
  );
}

/* ---------------------------------------------------------------- What counts as a news signal */

type Dir = "long" | "short";
const NEWS_ROWS: readonly {
  key: string;
  dirs: readonly Dir[] | "affected" | null;
  hold: string;
}[] = [
  { key: "hack", dirs: "affected", hold: "1 d" },
  { key: "listing", dirs: ["long"], hold: "1 d" },
  { key: "delisting", dirs: ["short"], hold: "2 d" },
  { key: "etf", dirs: ["long", "short"], hold: "3 d / 2 d" },
  { key: "regulator", dirs: ["short", "long"], hold: "3 d" },
  { key: "treasury", dirs: ["long", "short"], hold: "2 d" },
  { key: "earnings", dirs: ["long", "short"], hold: "3 d" },
  { key: "unlock", dirs: ["short"], hold: "2 d" },
];

function DirText({ d }: { d: Dir }) {
  const t = useTranslations("signalAnalysis.research");
  return (
    <span className={`font-bold ${d === "long" ? "text-pos" : "text-neg-ink"}`}>
      {t(`sides.${d}`)}
    </span>
  );
}

function Rules({ version, levels }: { version: number | null; levels: ResearchLevelRow[] }) {
  const t = useTranslations("signalAnalysis.research");
  const tr = useTranslations("signalAnalysis.research.rules");
  const b = (c: ReactNode) => <b>{c}</b>;
  return (
    <Block
      id="sr-rules"
      title={tr("title")}
      right={version === null ? undefined : tr("sub", { v: version })}
      className="max-md:hidden"
    >
      <p className="m-0 text-[15px] leading-normal text-ink-2">{tr.rich("intro", { b })}</p>
      <div className="flex flex-wrap gap-4">
        <div className="min-w-0 flex-[3_1_560px]">
          <ScrollTable label={tr("typesTable")}>
            <table className="w-full border-collapse">
              <caption className="sr-only">{tr("typesTable")}</caption>
              <thead>
                <tr>
                  <th scope="col" className={thR}>
                    {tr("colType")}
                  </th>
                  <th scope="col" className={thR}>
                    {tr("colDir")}
                  </th>
                  <th scope="col" className={thR}>
                    {tr("colHold")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {NEWS_ROWS.map((r) => (
                  <tr key={r.key}>
                    <td className={tdW}>{tr(`rows.${r.key}` as "rows.hack")}</td>
                    <td className={tdR}>
                      {r.dirs === "affected" ? (
                        <span className="font-bold text-neg-ink">{tr("shortAffected")}</span>
                      ) : r.dirs === null ? null : (
                        r.dirs.map((d, i) => (
                          <span key={d}>
                            {i > 0 ? " / " : null}
                            <DirText d={d} />
                          </span>
                        ))
                      )}
                    </td>
                    <td className={tdR}>{r.hold}</td>
                  </tr>
                ))}
                <tr>
                  <td className={`${tdW} text-muted`}>{tr("rows.notSignals")}</td>
                  <td className={tdR}>
                    <Dash />
                  </td>
                  <td className={tdR}>
                    <Dash />
                  </td>
                </tr>
              </tbody>
            </table>
          </ScrollTable>
        </div>
        <div className="flex flex-[2_1_360px] flex-col gap-3">
          <div className="rounded-[16px] bg-surface-2 p-3.5 text-sm leading-normal text-ink-2">
            {tr.rich("tiers", {
              b: (c) => <b className="text-ink">{c}</b>,
              t: (c) => <b>{c}</b>,
              br: () => <br />,
            })}
            <Sub>{tr("tiersNote")}</Sub>
          </div>
          <div className="rounded-[16px] bg-surface-2 p-3.5 text-sm leading-normal text-ink-2">
            {tr.rich("tpsl", { b: (c) => <b className="text-ink">{c}</b>, br: () => <br /> })}
          </div>
        </div>
      </div>
      <ScrollTable label={tr("levelsTable")}>
        <table className="w-full border-collapse">
          <caption className="sr-only">{tr("levelsTable")}</caption>
          <thead>
            <tr>
              {(
                [
                  "colLevel",
                  "colWhen",
                  "colSignals",
                  "colTrades",
                  "colLs",
                  "colAvg",
                  "colRandom",
                  "colVerdict",
                ] as const
              ).map((k) => (
                <th key={k} scope="col" className={thR}>
                  {tr(k)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {levels.length === 0 ? (
              <tr>
                <td colSpan={8} className={`${tdR} text-muted`}>
                  {tr("noLevels")}
                </td>
              </tr>
            ) : (
              levels.map((l) => (
                <tr key={l.level}>
                  <th scope="row" className={`${tdR} font-normal`}>
                    <Pill tone={LEVEL_TONE[l.level]}>{t(`levels.${l.level}`)}</Pill>
                  </th>
                  <td className={`${tdW} min-w-[240px]`}>
                    {tr(`when.${l.level}`)}
                    {l.laterHigh === null ? null : tr("laterHigh", { n: count(l.laterHigh) })}
                  </td>
                  <td className={tdR}>{count(l.signals)}</td>
                  <td className={tdR}>{tr("pair", { a: count(l.trades), b: count(l.closed) })}</td>
                  <td className={tdR}>
                    {tr("ls", { long: count(l.long), short: count(l.short) })}
                  </td>
                  <td className={tdR}>
                    <Avg v={l.avgPct} />
                  </td>
                  <td className={tdR}>
                    <RandomDiff avg={l.avgPct} random={l.randomPct} diff={l.diffPct} />
                  </td>
                  <td className={`${tdW} min-w-[160px]`}>
                    {l.status === "collecting" && l.needMore !== null
                      ? tr("needsClosed", { n: count(l.needMore) })
                      : t(`status.${l.status}`)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </ScrollTable>
      <div className="flex flex-wrap gap-3">
        <div className="flex-[1_1_360px]">
          <Note>{tr.rich("firstAnswer", { b: (c) => <b className="text-ink">{c}</b> })}</Note>
        </div>
        <div className="flex-[1_1_360px]">
          <Note>{tr.rich("passIf", { b: (c) => <b className="text-ink">{c}</b> })}</Note>
        </div>
      </div>
    </Block>
  );
}

function Avg({ v }: { v: number | null }) {
  if (v === null) return <NotEnough />;
  return <span className={`font-bold ${tone(v)}`}>{pctSigned(v)}</span>;
}

/** "Random entry · difference": "—" khi chưa có trung bình (như mockup), "Not available" khi có trung bình mà thiếu so sánh. */
function RandomDiff({
  avg,
  random,
  diff,
}: {
  avg: number | null;
  random: number | null;
  diff: number | null;
}) {
  const t = useTranslations("signalAnalysis.research.summary");
  if (avg === null) return <Dash />;
  if (random === null || diff === null) return <Na />;
  return (
    <>
      {t.rich(diff > 0 ? "randomBetter" : "randomDiff", {
        random: pctSigned(random),
        diff: pctSigned(diff),
        b: (c) => <b>{c}</b>,
      })}
    </>
  );
}

/* ---------------------------------------------------------------- Summary + risk filter */

function Needs({ n }: { n: ResearchSummaryRow["needs"] }) {
  const t = useTranslations("signalAnalysis.research.summary.needs");
  switch (n.kind) {
    case "pooled":
      return (
        <>
          {n.weeks === null
            ? t("pooledNoWeeks", { more: count(n.more) })
            : t("pooled", { more: count(n.more), weeks: n.weeks })}
        </>
      );
    case "rangeBelowZero":
      return <>{t("rangeBelowZero", { needed: n.needed })}</>;
    case "moreTrades":
      return (
        <>
          {n.fundingDays === null
            ? t("moreTrades", { more: n.more })
            : t("moreTradesFunding", { more: n.more, days: n.fundingDays })}
        </>
      );
    case "losesAfterFees":
      return <>{t("losesAfterFees")}</>;
    case "passed":
      return <>{t("passed")}</>;
  }
}

function cardLine(r: ResearchSummaryRow, t: Tr): string {
  const label = t(`labels.${r.label}`);
  const n = r.closed;
  if (r.avgPct === null) {
    const more = r.needs.kind === "pooled" || r.needs.kind === "moreTrades" ? r.needs.more : null;
    return more === null
      ? t("summary.cardPlain", { label, n })
      : t("summary.cardNeeds", { label, n, more: count(more) });
  }
  return r.range === null
    ? t("summary.cardAvg", { label, n, avg: pctSigned(r.avgPct) })
    : t("summary.cardAvgRange", {
        label,
        n,
        avg: pctSigned(r.avgPct),
        lo: pctSigned(r.range.lo),
        hi: pctSigned(r.range.hi),
      });
}

/** "Likely range" + số ngày (cụm) dùng cho khoảng 95%. "—" khi chưa có trung bình (như mockup). */
function RangeCell({
  avg,
  range,
  clusters,
}: {
  avg: number | null;
  range: { lo: number; hi: number } | null;
  clusters: number;
}) {
  const ts = useTranslations("signalAnalysis.research.summary");
  if (avg === null) return <Dash />;
  if (range === null) return <Na />;
  return (
    <>
      {ts("range", { lo: pctSigned(range.lo), hi: pctSigned(range.hi) })}
      <span className="ml-1.5 text-xs text-muted">{ts("clusters", { n: clusters })}</span>
    </>
  );
}

function dirLine(d: ResearchDirectionRow, t: Tr): string {
  const side = t(`sides.${d.side}`);
  const n = d.closed;
  if (d.avgPct === null) return t("summary.cardDirNone", { side, n });
  return d.range === null
    ? t("summary.cardDirAvg", { side, n, avg: pctSigned(d.avgPct) })
    : t("summary.cardDir", {
        side,
        n,
        avg: pctSigned(d.avgPct),
        lo: pctSigned(d.range.lo),
        hi: pctSigned(d.range.hi),
      });
}

/** Long / Short của News · live paper (#269 v3.4 điểm 5): một tuần tăng giá không được trông như có edge. */
function Directions({ rows }: { rows: readonly ResearchDirectionRow[] }) {
  const t = useTranslations("signalAnalysis.research");
  const ts = useTranslations("signalAnalysis.research.summary");
  if (rows.length === 0) return null;
  const cols = ["colSide", "colClosed", "colAvg", "colRandom", "colRange"] as const;
  return (
    <div className="mt-3 rounded-tile bg-surface-2 px-2 py-1">
      <table className="w-full border-collapse">
        <caption className="sr-only">{ts("dirTable")}</caption>
        <thead>
          <tr>
            {cols.map((k) => (
              <th key={k} scope="col" className={thR}>
                {ts(k)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.side}>
              <th scope="row" className={`${tdR} border-b-0 font-normal`}>
                <Pill tone={SIDE_TONE[d.side]}>{t(`sides.${d.side}`)}</Pill>
              </th>
              <td className={`${tdR} border-b-0`}>{count(d.closed)}</td>
              <td className={`${tdR} border-b-0`}>
                <Avg v={d.avgPct} />
              </td>
              <td className={`${tdR} border-b-0`}>
                <RandomDiff avg={d.avgPct} random={d.randomPct} diff={d.diffPct} />
              </td>
              <td className={`${tdR} border-b-0`}>
                <RangeCell avg={d.avgPct} range={d.range} clusters={d.clusters} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Summary({
  rows,
  directions,
  costPct,
  risk,
  tz,
}: {
  rows: ResearchSummaryRow[];
  directions: readonly ResearchDirectionRow[];
  costPct: number | null;
  risk: ResearchRisk | null;
  tz: string;
}) {
  const t = useTranslations("signalAnalysis.research");
  const ts = useTranslations("signalAnalysis.research.summary");
  const na = t("na");
  return (
    <Block
      id="sr-sum"
      title={ts("title")}
      titleShort={ts("titleShort")}
      right={
        <span className="max-md:hidden">
          {ts("sub", { cost: costPct === null ? na : pctPlain(costPct) })}
        </span>
      }
    >
      {rows.length === 0 ? (
        <p className="m-0 text-sm text-muted">{ts("none")}</p>
      ) : (
        <>
          <div className="max-md:hidden">
            <ScrollTable label={ts("table")}>
              <table className="w-full border-collapse">
                <caption className="sr-only">{ts("table")}</caption>
                <thead>
                  <tr>
                    {(
                      [
                        "colType",
                        "colTested",
                        "colClosed",
                        "colAvg",
                        "colRandom",
                        "colRange",
                        "colStatus",
                        "colNeeds",
                      ] as const
                    ).map((k) => (
                      <th key={k} scope="col" className={thR}>
                        {ts(k)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.type}-${r.label}`}>
                      <th scope="row" className={`${tdR} font-normal`}>
                        <span className="block font-bold">{t(`types.${r.type}`)}</span>
                        <Sub>{t("rulesV", { v: r.rulesVersion })}</Sub>
                      </th>
                      <td className={tdR}>
                        <LabelPill label={r.label} />
                      </td>
                      <td className={tdR}>
                        {count(r.closed)}
                        {r.opened === null ? null : (
                          <Sub>{ts("opened", { n: count(r.opened) })}</Sub>
                        )}
                      </td>
                      <td className={tdR}>
                        <Avg v={r.avgPct} />
                      </td>
                      <td className={tdR}>
                        <RandomDiff avg={r.avgPct} random={r.randomPct} diff={r.diffPct} />
                      </td>
                      <td className={tdR}>
                        <RangeCell avg={r.avgPct} range={r.range} clusters={r.clusters} />
                      </td>
                      <td className={tdR}>
                        <Pill tone={STATUS_TONE[r.status]}>{t(`status.${r.status}`)}</Pill>
                      </td>
                      <td className={`${tdW} min-w-[150px]`}>
                        <Needs n={r.needs} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTable>
            <Directions rows={directions} />
          </div>
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0 md:hidden">
            {rows.map((r) => (
              <li
                key={`${r.type}-${r.label}`}
                className="flex flex-col gap-1.5 rounded-tile border border-border p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <b>{t(`types.${r.type}`)}</b>
                  <Pill tone={STATUS_TONE[r.status]}>{t(`status.${r.status}`)}</Pill>
                </div>
                <span className="text-xs text-muted">{cardLine(r, t)}</span>
              </li>
            ))}
            {directions.length === 0 ? null : (
              <li className="flex flex-col gap-1 rounded-tile bg-surface-2 p-3 text-xs text-ink-2">
                {directions.map((d) => (
                  <span key={d.side}>{dirLine(d, t)}</span>
                ))}
              </li>
            )}
          </ul>
        </>
      )}
      <Risk risk={risk} tz={tz} />
    </Block>
  );
}

function Risk({ risk, tz }: { risk: ResearchRisk | null; tz: string }) {
  const t = useTranslations("signalAnalysis.research.risk");
  const b = (c: ReactNode) => <b>{c}</b>;
  const cost = risk?.costChangePct ?? null;
  const vol = risk?.volumeChangePct ?? null;
  const known = risk !== null && cost !== null && vol !== null;
  const next = risk?.next ?? null;
  const dir = (v: number) => (v <= 0 ? "lower" : "higher");
  return (
    <>
      <div className="flex flex-wrap items-start gap-3 rounded-tile bg-surface-2 px-4 py-3.5 max-md:hidden">
        <div className="flex flex-[1_1_380px] flex-col gap-1">
          <h3 className="m-0 text-[15px] font-extrabold">{t("title")}</h3>
          <p className="m-0 text-sm leading-normal text-ink-2">
            {known ? (
              t("body", {
                windows: risk.windows,
                days: risk.days,
                cost: Math.abs(cost).toFixed(0),
                costDir: dir(cost),
                volume: Math.abs(vol).toFixed(0),
                volumeDir: dir(vol),
              })
            ) : (
              <Na />
            )}
          </p>
        </div>
        <div className="flex min-w-[220px] flex-col gap-1">
          <span className="text-xs font-bold text-muted">{t("next")}</span>
          <span className="font-bold">
            {next === null ? (
              <Na />
            ) : (
              t("nextValue", {
                event: next.event,
                day: monthDay(next.from, tz),
                from: clock(next.from, tz, false),
                to: clock(next.to, tz, false),
              })
            )}
          </span>
        </div>
      </div>
      <p className="m-0 rounded-[14px] bg-surface-2 px-3 py-2.5 text-[13px] leading-normal text-ink-2 md:hidden">
        {!known
          ? t.rich("shortNa", { b })
          : next === null
            ? t.rich("shortNoNext", {
                b,
                dir: dir(cost),
                cost: Math.abs(cost).toFixed(0),
              })
            : t.rich("short", {
                b,
                dir: dir(cost),
                cost: Math.abs(cost).toFixed(0),
                event: next.event,
                day: monthDay(next.from, tz),
                time: clock(next.from, tz, false),
              })}
      </p>
    </>
  );
}
