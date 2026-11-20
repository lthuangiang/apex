"use client";

import {
  AVG_SHOWN_AT_CLOSED,
  GATE_MIN_CLOSED,
  type ResearchClassifiers,
  type ResearchDirectionRow,
  type ResearchLevelRow,
  type ResearchRisk,
  type ResearchSummary,
  type ResearchSummaryRow,
  type ResearchVersion,
  type ResearchVersions,
} from "@drift/shared";
import { useTranslations } from "next-intl";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { ScrollTable } from "../components/bits";
import { clock, count, monthDay } from "../format";

import { useBotsLabels } from "./bots-labels-context";
import { ContextHelp } from "./context-help";
import { pctPlain, pctSigned, tone } from "./format";
import { HelpButton } from "./how-it-works";
import { ByMarket } from "./market-state";
import type { Tr } from "./text";
import {
  Bar,
  Block,
  Dash,
  GroupBar,
  LEVEL_TONE,
  Na,
  NotEnough,
  Pill,
  SIDE_TONE,
  STATUS_TONE,
  Sub,
  tdR,
  tdW,
  thR,
} from "./ui";
import { classifierShort } from "./version-text";

// "Is it working?" của Signal research (#344; thiết kế docs/mockups/signal-research/redesign-full-page*.html và
// redesign-does-context-help.html): ba thanh tiến độ (lệnh đóng cho cổng, nhãn classifier, Context H1) rồi ba tab Overall /
// By level / Does context help?. Mọi số từ API tổng kết / versions / classifiers; thiếu thì "Not available", không bao giờ 0
// (quy tắc 1.8). Trung bình sau phí chỉ hiện khi đã có 30 lệnh đóng được tính ("Average shows at 30 closed").

export const JUDGE_TABS = ["overall", "levels", "market", "context"] as const;
export type JudgeTab = (typeof JUDGE_TABS)[number];

/** Lệnh đóng ĐƯỢC TÍNH của một dòng (News: classifier đã qua cổng; replay: mọi lệnh đóng). */
const countedOf = (r: ResearchSummaryRow) => r.classifiers?.counted ?? r.closed;

export function IsItWorking({
  v,
  tz,
  versions,
  classifiers,
  picked,
}: {
  v: ResearchSummary;
  tz: string;
  versions: ResearchVersions | undefined;
  classifiers: ResearchClassifiers | undefined;
  /** Version đang chọn ở đầu trang (Baseline khi chưa chọn); null khi chưa có danh sách. */
  picked: ResearchVersion | null;
}) {
  const t = useTranslations("signalAnalysis.research.judge");
  const ts = useTranslations("signalAnalysis.research.summary");
  const [tab, setTab] = useState<JudgeTab>("overall");
  const refs = useRef(new Map<JudgeTab, HTMLButtonElement>());
  const onKey = (e: KeyboardEvent) => {
    const i = JUDGE_TABS.indexOf(tab);
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -i : 0;
    const end = e.key === "End";
    if (d === 0 && !end) return;
    e.preventDefault();
    const next = end
      ? "context"
      : (JUDGE_TABS[(i + d + JUDGE_TABS.length) % JUDGE_TABS.length] ?? "overall");
    setTab(next);
    refs.current.get(next)?.focus();
  };
  return (
    <Block
      id="sr-sum"
      title={ts("title")}
      right={
        <span
          role="tablist"
          aria-label={t("tabsLabel")}
          className="flex gap-1 overflow-x-auto max-md:mask-r-from-85% md:rounded-tile md:border md:border-border md:bg-surface-2 md:p-[3px]"
        >
          {JUDGE_TABS.map((k) => {
            const on = k === tab;
            return (
              <button
                key={k}
                ref={(el) => {
                  if (el === null) refs.current.delete(k);
                  else refs.current.set(k, el);
                }}
                type="button"
                role="tab"
                id={`sr-judge-tab-${k}`}
                aria-selected={on}
                aria-controls="sr-judge-panel"
                tabIndex={on ? 0 : -1}
                onKeyDown={onKey}
                onClick={() => {
                  setTab(k);
                }}
                className={`min-h-11 flex-none cursor-pointer whitespace-nowrap px-3.5 text-[13px] font-extrabold max-md:rounded-full max-md:border md:min-h-[38px] md:rounded-control md:border-0 ${
                  on
                    ? "max-md:border-accent max-md:bg-accent max-md:text-white md:bg-surface md:text-ink md:shadow-card"
                    : "max-md:border-border-input max-md:bg-surface max-md:text-ink md:bg-transparent md:text-muted"
                }`}
              >
                {t(`tabs.${k}`)}
              </button>
            );
          })}
        </span>
      }
    >
      <ProgressCards v={v} versions={versions} classifiers={classifiers} />
      <div
        id="sr-judge-panel"
        role="tabpanel"
        aria-labelledby={`sr-judge-tab-${tab}`}
        className="flex min-w-0 flex-col gap-3.5"
      >
        {tab === "overall" ? (
          <Overall v={v} tz={tz} />
        ) : tab === "levels" ? (
          <Levels levels={v.levels} />
        ) : tab === "market" ? (
          <ByMarket live={v.marketSplit} backfilled={v.marketSplitBackfilled} />
        ) : (
          <ContextHelp live={v.context} backfilled={v.contextBackfilled} picked={picked} />
        )}
      </div>
    </Block>
  );
}

/* ---------------------------------------------------------------- Thanh tiến độ */

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`flex min-w-0 flex-col gap-2 md:rounded-tile md:border md:border-border md:px-4 md:py-3.5 ${className}`}
    >
      {children}
    </div>
  );
}

const linkCls =
  "font-semibold text-accent-ink underline-offset-2 hover:underline focus-visible:underline";

/** "Label signals": mở khu Bots & labels và bắt đầu gắn nhãn (trong trang); đứng riêng thì là link tới khu nhãn. */
function useLabelLink() {
  const open = useBotsLabels();
  return (c: ReactNode) =>
    open === null ? (
      <a href="#sr-labels" className={linkCls}>
        {c}
      </a>
    ) : (
      <button
        type="button"
        onClick={open.openLabels}
        className={`cursor-pointer border-0 bg-transparent p-0 ${linkCls}`}
      >
        {c}
      </button>
    );
}

function ProgressCards({
  v,
  versions,
  classifiers,
}: {
  v: ResearchSummary;
  versions: ResearchVersions | undefined;
  classifiers: ResearchClassifiers | undefined;
}) {
  const t = useTranslations("signalAnalysis.research.judge");
  const tc = useTranslations("signalAnalysis.research.contextHelp");
  const na = useTranslations("signalAnalysis.research")("na");
  const labelLink = useLabelLink();
  const b = (c: ReactNode) => <b>{c}</b>;

  // Lệnh đóng cho cổng: dòng News · Live paper (cổng gộp mọi tin).
  const news = v.rows.find((r) => r.type === "news" && r.label === "live");
  const closed = news === undefined ? null : countedOf(news);
  const weeks = news?.needs.kind === "pooled" ? news.needs.weeks : null;
  const more = closed === null ? 0 : Math.max(0, GATE_MIN_CLOSED - closed);

  const c = versions?.classifier ?? null;
  const min = classifiers?.gate.minLabels ?? null;
  const pct = c?.precisionPct ?? null;
  const name = c === null ? null : classifierShort(c.current);
  const labelsMore = c === null || min === null ? 0 : Math.max(0, min - c.labeled);
  // Chưa đếm (Claude reader chưa qua nhãn, chưa có lệnh nào được tính): nói bằng lời thường thay vì "needs 100 more".
  const waits = c !== null && c.status !== "passed" && closed === 0 ? c : null;

  const h1 = v.context?.questions.find((q) => q.key === "h1") ?? null;
  const ctxMin = v.context?.minClosedPerGroup ?? null;
  return (
    <div className="grid gap-3 md:grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
      <Card>
        <div className="flex justify-between gap-2 text-[13px]">
          <strong>{t("closedTitle")}</strong>
          {weeks === null || more === 0 || waits !== null ? null : (
            <span className="text-muted max-md:hidden">{t("weeksToGo", { weeks })}</span>
          )}
        </div>
        {closed === null ? (
          <Na />
        ) : (
          <>
            <Bar label={t("closedAria")} now={closed} max={GATE_MIN_CLOSED} />
            <div className="text-[13px] text-ink-2 max-md:hidden">
              {waits !== null
                ? waits.status === "needsLabels"
                  ? t.rich("closedLineWaits", {
                      b,
                      n: count(closed),
                      gate: GATE_MIN_CLOSED,
                      k: waits.labelsToGo,
                    })
                  : t.rich("closedLineUnder", { b, n: count(closed), gate: GATE_MIN_CLOSED })
                : more === 0
                  ? t.rich("closedLineDone", { b, n: count(closed), gate: GATE_MIN_CLOSED })
                  : t.rich("closedLine", {
                      b,
                      n: count(closed),
                      gate: GATE_MIN_CLOSED,
                      more: count(more),
                    })}
            </div>
            <div className="text-xs text-ink-2 md:hidden">
              {waits !== null
                ? waits.status === "needsLabels"
                  ? t("closedShortWaits", {
                      n: count(closed),
                      gate: GATE_MIN_CLOSED,
                      k: waits.labelsToGo,
                    })
                  : t("closedShortUnder", { n: count(closed), gate: GATE_MIN_CLOSED })
                : more === 0
                  ? t.rich("closedLineDone", {
                      b: (x) => <>{x}</>,
                      n: count(closed),
                      gate: GATE_MIN_CLOSED,
                    })
                  : weeks === null
                    ? t("closedShortNoWeeks", {
                        n: count(closed),
                        gate: GATE_MIN_CLOSED,
                        more: count(more),
                      })
                    : t("closedShort", {
                        n: count(closed),
                        gate: GATE_MIN_CLOSED,
                        more: count(more),
                        weeks,
                      })}
            </div>
          </>
        )}
      </Card>
      <Card>
        <div className="flex justify-between gap-2 text-[13px]">
          <strong>{name === null ? t("labelsTitleNa") : t("labelsTitle", { name })}</strong>
          {pct === null ? null : (
            <span className="text-muted max-md:hidden">
              {t("labelsRight", { pct: Math.round(pct) })}
            </span>
          )}
        </div>
        {c === null || min === null ? (
          <Na />
        ) : (
          <>
            <Bar label={t("labelsAria")} now={c.labeled} max={min} />
            <div className="text-[13px] text-ink-2 max-md:hidden">
              {labelsMore === 0
                ? t.rich("labelsLineDone", { b, a: labelLink, n: count(c.labeled), min })
                : t.rich("labelsLine", {
                    b,
                    a: labelLink,
                    n: count(c.labeled),
                    min,
                    more: count(labelsMore),
                  })}
            </div>
            <div className="text-xs text-ink-2 md:hidden">
              {pct === null
                ? t.rich("labelsShortNoPct", { a: labelLink, n: count(c.labeled), min })
                : t.rich("labelsShort", {
                    a: labelLink,
                    n: count(c.labeled),
                    min,
                    pct: Math.round(pct),
                  })}
            </div>
          </>
        )}
      </Card>
      {/* Mockup 390 không có thẻ Context: chỉ từ 768px. */}
      <Card className="max-md:hidden">
        <div className="flex justify-between gap-2 text-[13px]">
          <strong>{t("contextTitle")}</strong>
          {ctxMin === null ? null : (
            <span className="text-muted">{t("contextNeeds", { min: ctxMin })}</span>
          )}
        </div>
        {h1 === null || ctxMin === null ? (
          <span className="text-[13px]">{na}</span>
        ) : (
          <>
            <GroupBar
              label={tc("groups.with")}
              aria={tc("groupAria", { question: t("contextTitle"), group: tc("groups.with") })}
              n={h1.with.closed}
              min={ctxMin}
            />
            <GroupBar
              label={tc("groups.without")}
              aria={tc("groupAria", { question: t("contextTitle"), group: tc("groups.without") })}
              n={h1.without.closed}
              min={ctxMin}
            />
          </>
        )}
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- Overall */

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
  if (r.avgPct === null || countedOf(r) < AVG_SHOWN_AT_CLOSED) {
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
  // PM (#358): như các dòng khác, trung bình chỉ hiện từ 30 lệnh đóng.
  if (n < AVG_SHOWN_AT_CLOSED)
    return t("summary.cardDirNeeds", { side, n, more: count(AVG_SHOWN_AT_CLOSED - n) });
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
    <div className="rounded-tile bg-surface-2 px-2 py-1">
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
          {rows.map((d) => {
            // PM (#358): dưới 30 lệnh đóng không hiện trung bình (cũng như so với ngẫu nhiên và khoảng).
            const hidden = d.closed < AVG_SHOWN_AT_CLOSED;
            const avg = hidden ? null : d.avgPct;
            return (
              <tr key={d.side}>
                <th scope="row" className={`${tdR} border-b-0 font-normal`}>
                  <Pill tone={SIDE_TONE[d.side]}>{t(`sides.${d.side}`)}</Pill>
                </th>
                <td className={`${tdR} border-b-0`}>{count(d.closed)}</td>
                <td className={`${tdR} border-b-0`}>
                  {hidden ? (
                    <span className="text-muted">
                      {ts("notEnoughNeeds", { more: count(AVG_SHOWN_AT_CLOSED - d.closed) })}
                    </span>
                  ) : (
                    <Avg v={avg} />
                  )}
                </td>
                <td className={`${tdR} border-b-0`}>
                  <RandomDiff avg={avg} random={d.randomPct} diff={d.diffPct} />
                </td>
                <td className={`${tdR} border-b-0`}>
                  <RangeCell avg={avg} range={d.range} clusters={d.clusters} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Câu chi phí một lệnh dưới bảng (#321): thiếu vì chưa lệnh v3 nào tới bước kiểm chi phí thì nói rõ. */
function CostLine({ v }: { v: ResearchSummary }) {
  const ts = useTranslations("signalAnalysis.research.summary");
  const tj = useTranslations("signalAnalysis.research.judge");
  const na = useTranslations("signalAnalysis.research")("na");
  const cost =
    v.costPct !== null
      ? pctPlain(v.costPct)
      : v.newsRulesVersion === null
        ? na
        : tj("costNaYet", { v: v.newsRulesVersion });
  return <p className="m-0 text-xs text-muted max-md:hidden">{ts("sub", { cost })}</p>;
}

function Overall({ v, tz }: { v: ResearchSummary; tz: string }) {
  const t = useTranslations("signalAnalysis.research");
  const ts = useTranslations("signalAnalysis.research.summary");
  const tj = useTranslations("signalAnalysis.research.judge");
  const rows = v.rows;
  const directions = v.directions;
  if (rows.length === 0)
    return (
      <>
        <p className="m-0 text-sm text-muted">{ts("none")}</p>
        <CostLine v={v} />
        <Risk risk={v.risk} tz={tz} />
      </>
    );
  return (
    <>
      <div className="flex flex-col gap-3 max-md:hidden">
        <ScrollTable label={ts("table")}>
          <table className="w-full border-collapse">
            <caption className="sr-only">{ts("table")}</caption>
            <thead>
              <tr>
                {(["colType", "colClosed", "colAvg", "colRandom", "colStatus"] as const).map(
                  (k) => (
                    <th key={k} scope="col" className={thR}>
                      {tj(k)}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const counted = countedOf(r);
                const hidden = counted < AVG_SHOWN_AT_CLOSED;
                return (
                  <tr key={`${r.type}-${r.label}`}>
                    <th scope="row" className={`${tdR} font-normal`}>
                      <span className="block font-extrabold">
                        {tj("typeLabel", {
                          type: t(`types.${r.type}`),
                          label: t(`labels.${r.label}`),
                        })}
                      </span>
                      <Sub>
                        {t("rulesV", { v: r.rulesVersion })}
                        <HelpButton tab="news" />
                      </Sub>
                    </th>
                    <td className={tdR}>
                      {count(r.closed)}
                      {r.opened === null ? null : <Sub>{ts("opened", { n: count(r.opened) })}</Sub>}
                    </td>
                    <td className={`${tdW} min-w-[220px]`}>
                      {hidden ? (
                        <span className="text-muted">
                          {tj("avgAt", {
                            at: AVG_SHOWN_AT_CLOSED,
                            more: count(AVG_SHOWN_AT_CLOSED - counted),
                            gate: GATE_MIN_CLOSED,
                          })}
                        </span>
                      ) : (
                        <>
                          <Avg v={r.avgPct} />
                          {r.avgPct === null ? null : (
                            <Sub>
                              {r.range === null ? (
                                <Na />
                              ) : (
                                tj("rangeSub", {
                                  lo: pctSigned(r.range.lo),
                                  hi: pctSigned(r.range.hi),
                                  n: r.clusters,
                                })
                              )}
                            </Sub>
                          )}
                        </>
                      )}
                    </td>
                    <td className={tdR}>
                      {hidden ? (
                        <span className="text-muted">
                          {tj("randomAt", { at: AVG_SHOWN_AT_CLOSED })}
                        </span>
                      ) : (
                        <RandomDiff avg={r.avgPct} random={r.randomPct} diff={r.diffPct} />
                      )}
                    </td>
                    <td className={`${tdW} min-w-[160px]`}>
                      <Pill tone={STATUS_TONE[r.status]}>{t(`status.${r.status}`)}</Pill>
                      {hidden ? null : (
                        <Sub>
                          <Needs n={r.needs} />
                        </Sub>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollTable>
        <Directions rows={directions} />
        <CostLine v={v} />
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
      <Risk risk={v.risk} tz={tz} />
    </>
  );
}

/* ---------------------------------------------------------------- By level */

function Levels({ levels }: { levels: ResearchLevelRow[] }) {
  const t = useTranslations("signalAnalysis.research");
  const tr = useTranslations("signalAnalysis.research.rules");
  return (
    <div className="flex flex-col gap-2">
      <h3 className="m-0 text-[15px] font-extrabold">{tr("levelsTable")}</h3>
      <ScrollTable label={tr("levelsTable")}>
        <table className="w-full min-w-[860px] border-collapse">
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
                    <HelpButton tab="levels" />
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
    </div>
  );
}

/* ---------------------------------------------------------------- Risk filter */

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
