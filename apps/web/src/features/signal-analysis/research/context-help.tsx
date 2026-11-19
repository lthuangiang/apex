"use client";

import type {
  ContextSource,
  ResearchContextQuestion,
  ResearchContextSummary,
  ResearchVersion,
} from "@drift/shared";
import { useTranslations } from "next-intl";
import { Fragment, useState, type ReactNode } from "react";

import { ScrollTable } from "../components/bits";
import { count } from "../format";

import { pctSigned, tone } from "./format";
import { HelpButton } from "./how-it-works";
import { Dash, GroupBar, Na, Pill, type PillTone, Sub, tdR, tdW, thW } from "./ui";
import { versionShort } from "./version-text";

// Tab "Does context help?" của "Is it working?" (#344; thiết kế docs/mockups/signal-research/redesign-does-context-help.html):
// ba câu hỏi đăng ký trước (H1 / H2 / H3), mỗi câu so nhóm With / Without trên lệnh đã đóng được tính của version đang chọn.
// API (#329) đã áp quy tắc: `na` bị loại khỏi cả hai nhóm, H1 `against` vào nhóm Without, mỗi nhóm cần ≥ 30 lệnh đóng; dưới
// ngưỡng API không trả trung bình / chênh / khoảng (null) và web chỉ hiện tiến độ. Live và Backfilled là hai khối riêng.

const KEYS = ["h1", "h2", "h3"] as const;
const GROUPS = ["with", "without"] as const;

const STATUS_TONE: Record<ResearchContextQuestion["status"], PillTone> = {
  collecting: "warn",
  no_clear_difference: "neutral",
  better_with: "pos",
  worse_with: "neg",
};

export function ContextHelp({
  live,
  backfilled,
  picked,
}: {
  live: ResearchContextSummary | null;
  backfilled: ResearchContextSummary | null;
  picked: ResearchVersion | null;
}) {
  const t = useTranslations("signalAnalysis.research.context");
  const tn = useTranslations("signalAnalysis.research");
  const tv = useTranslations("signalAnalysis.research.versions");
  const [source, setSource] = useState<ContextSource>("live");
  const c = source === "live" ? live : backfilled;
  const b = (x: ReactNode) => <b>{x}</b>;
  const name =
    picked === null
      ? null
      : picked.isBaseline
        ? tn("page.baselineOption", { n: picked.number })
        : versionShort(picked, tv);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex max-w-[820px] flex-col gap-1">
          <h3 className="m-0 text-base font-extrabold md:text-lg">
            {t("title")}
            <HelpButton tab="context" />
          </h3>
          <p className="m-0 text-[13px] leading-normal text-ink-2">{t("intro")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {name === null ? null : (
            <span className="text-xs font-bold text-muted">{t("baseline", { name })}</span>
          )}
          <div
            role="group"
            aria-label={t("dataLabel")}
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
                {t(`sources.${k}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="m-0 rounded-tile bg-warn-bg px-4 py-3 text-[13px] leading-normal text-warn">
        {t.rich("slow", { b })}
      </p>

      {c === null ? (
        <p className="m-0 text-sm">
          <Na />
        </p>
      ) : (
        <>
          {c.coverage.signals === 0 ? (
            <p className="m-0 text-[13px] text-muted">{t("noSnapshots", { source })}</p>
          ) : null}
          <Table c={c} />
          {c.closedWithoutSnapshot > 0 ? (
            <p className="m-0 text-xs text-muted">
              {t("leftOut", { n: c.closedWithoutSnapshot, source })}
            </p>
          ) : null}
        </>
      )}
      <p className="m-0 text-xs leading-normal text-muted">{t("footnote")}</p>

      <div className="flex flex-wrap gap-3">
        <div className="flex flex-[1_1_320px] flex-col gap-1.5 rounded-tile border border-border px-4 py-3.5">
          <div className="text-[13px] font-extrabold">{t("optionTitle")}</div>
          <p className="m-0 text-[13px] leading-normal text-ink-2">{t("optionBody")}</p>
        </div>
        <div className="flex flex-[1_1_320px] flex-col gap-1.5 rounded-tile border border-border px-4 py-3.5">
          <div className="text-[13px] font-extrabold">{t("coverageTitle")}</div>
          <p className="m-0 text-[13px] leading-normal text-ink-2">
            {c === null ? (
              <Na />
            ) : (
              t("coverage", {
                whale: count(c.coverage.whale),
                funding: count(c.coverage.funding),
                price: count(c.coverage.priceRun),
                signals: count(c.coverage.signals),
              })
            )}
          </p>
        </div>
      </div>

      <details className="rounded-tile border border-dashed border-border-input px-4 py-3">
        <summary className="flex min-h-8 cursor-pointer items-center text-sm font-extrabold">
          {t("exploratory")}
        </summary>
        <p className="m-0 mt-2 text-[13px] leading-normal text-ink-2">{t("exploratoryBody")}</p>
      </details>
    </div>
  );
}

function Table({ c }: { c: ResearchContextSummary }) {
  const t = useTranslations("signalAnalysis.research.context");
  const min = c.minClosedPerGroup;
  const cols = [
    "colQuestion",
    "colGroup",
    "colClosed",
    "colAvg",
    "colDiff",
    "colRange",
    "colStatus",
  ] as const;
  return (
    <ScrollTable label={t("table")}>
      <table className="w-full min-w-[980px] border-collapse">
        <caption className="sr-only">{t("table")}</caption>
        <thead>
          <tr>
            {cols.map((k) => (
              <th key={k} scope="col" className={`${thW} ${k === "colQuestion" ? "w-[26%]" : ""}`}>
                {t(k)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {KEYS.map((key) => {
            const q = c.questions.find((x) => x.key === key);
            if (q === undefined) return null;
            const collecting = q.status === "collecting";
            const title = t(`q.${key}.title`);
            return (
              <Fragment key={key}>
                {GROUPS.map((g, i) => {
                  const grp = q[g];
                  const done = grp.closed >= min;
                  return (
                    <tr key={g} data-question={key} data-group={g}>
                      {i === 0 ? (
                        <th scope="row" rowSpan={2} className={`${tdW} font-normal`}>
                          <strong>{title}</strong>
                          <Sub>{t(`q.${key}.body`)}</Sub>
                        </th>
                      ) : null}
                      <td className={tdR}>
                        <Pill tone={g === "with" ? "pos" : "neutral"}>{t(`groups.${g}`)}</Pill>
                      </td>
                      <td className={`${tdR} min-w-[150px]`}>
                        {done ? (
                          count(grp.closed)
                        ) : (
                          <GroupBar
                            aria={t("groupAria", { question: title, group: t(`groups.${g}`) })}
                            n={grp.closed}
                            min={min}
                          />
                        )}
                      </td>
                      <td className={tdR}>
                        {collecting || grp.avgPct === null ? (
                          <span className="text-muted">{t("notEnough")}</span>
                        ) : (
                          <span className={tone(grp.avgPct)}>{pctSigned(grp.avgPct)}</span>
                        )}
                      </td>
                      {i === 0 ? (
                        <>
                          <td rowSpan={2} className={`${tdW} min-w-[170px] align-top`}>
                            {collecting || q.diffPct === null ? (
                              <span className="text-muted">{t("notEnoughCompare")}</span>
                            ) : (
                              <strong className={tone(q.diffPct)}>{pctSigned(q.diffPct)}</strong>
                            )}
                          </td>
                          <td rowSpan={2} className={`${tdR} align-top`}>
                            {collecting ? (
                              <Dash />
                            ) : q.range === null ? (
                              <Na />
                            ) : (
                              t("range", { lo: pctSigned(q.range.lo), hi: pctSigned(q.range.hi) })
                            )}
                          </td>
                          <td rowSpan={2} className={`${tdW} min-w-[180px] align-top`}>
                            <Pill tone={STATUS_TONE[q.status]}>{t(`status.${q.status}`)}</Pill>
                            <StatusSub q={q} />
                          </td>
                        </>
                      ) : null}
                    </tr>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </ScrollTable>
  );
}

function StatusSub({ q }: { q: ResearchContextQuestion }) {
  const t = useTranslations("signalAnalysis.research.context");
  if (q.status === "collecting") {
    const w = count(q.needWith);
    const wo = count(q.needWithout);
    if (q.needWith > 0 && q.needWithout > 0)
      return <Sub>{t("moreBoth", { with: w, without: wo })}</Sub>;
    if (q.needWith > 0) return <Sub>{t("moreWith", { n: w })}</Sub>;
    if (q.needWithout > 0) return <Sub>{t("moreWithout", { n: wo })}</Sub>;
    return null;
  }
  if (q.status === "no_clear_difference") return <Sub>{t("includesZero")}</Sub>;
  if (q.status === "worse_with" && q.key === "h3") return <Sub>{t("candidateH3")}</Sub>;
  return null;
}
