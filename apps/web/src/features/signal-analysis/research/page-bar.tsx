"use client";

import {
  GATE_MIN_CLOSED,
  type ResearchClassifiers,
  type ResearchContextSummary,
  type ResearchSource,
  type ResearchVersion,
  type ResearchVersions,
} from "@drift/shared";
import { useTranslations } from "next-intl";
import { Fragment, type ReactNode } from "react";

import { clock, monthDay } from "../format";

import { delay } from "./format";
import type { HowTab } from "./how-it-works";
import { classifierShort, versionShort } from "./version-text";

// Đầu trang Signal research (#342, thiết kế docs/mockups/signal-research/redesign-full-page*.html): dải "Research only ·
// fake money" (token cảnh báo) với dòng nguồn, rồi thanh Version (một bộ chọn cho cả trang) · Progress · How it works.
// Mọi số của Progress đến từ API versions / classifiers; thiếu thì "Not available" (quy tắc 1.8). Context (#344) từ khối
// `context` (live) của tổng kết: còn câu hỏi nào đang thu thập thì "Context: collecting".

/** Câu một nguồn ("SoSoValue news · Live · 1 min ago"); `statusShown` = trạng thái đã có trong câu. */
function useSourceLine() {
  const t = useTranslations("signalAnalysis.research.sources");
  return (s: ResearchSource, now: string, tz: string): { text: string; statusShown: boolean } => {
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
}

export function ResearchBanner({
  sources,
  tz,
}: {
  /** null khi tổng kết chưa tải. */
  sources: { items: readonly ResearchSource[]; now: string } | null;
  tz: string;
}) {
  const t = useTranslations("signalAnalysis.research.page.banner");
  const ts = useTranslations("signalAnalysis.research.sources");
  const line = useSourceLine();
  return (
    <div
      role="note"
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-tile border border-warn-border bg-warn-bg px-3 py-2.5 text-[13px] text-warn md:px-4 md:py-3 md:text-sm"
    >
      <strong className="md:text-[15px]">
        <span className="md:hidden">{t("titleShort")}</span>
        <span className="max-md:hidden">{t("title")}</span>
      </strong>
      <span>{t("body")}</span>
      {sources === null || sources.items.length === 0 ? null : (
        <ul
          aria-label={t("sourcesLabel")}
          className="m-0 flex list-none flex-wrap gap-x-1 p-0 max-md:hidden"
        >
          {sources.items.map((s, i) => {
            const l = line(s, sources.now, tz);
            return (
              <li key={s.key}>
                {i > 0 ? <span aria-hidden="true">{" · "}</span> : null}
                <span>{l.text}</span>
                {l.statusShown ? null : (
                  <span className="sr-only">
                    {" "}
                    {ts("statusSr", { status: ts(`status.${s.status}`) })}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const linkCls =
  "font-semibold text-accent-ink underline-offset-2 hover:underline focus-visible:underline";

export function VersionBar({
  versions,
  versionsError,
  classifiers,
  context,
  current,
  onVersion,
  onHow,
}: {
  versions: ResearchVersions | undefined;
  versionsError: boolean;
  classifiers: ResearchClassifiers | undefined;
  /** Khối "Does context help?" (live) của tổng kết; null khi chưa tải / lane chưa chạy. */
  context: ResearchContextSummary | null;
  /** Version đang chọn (đã quy về Baseline khi chưa chọn); null khi chưa có danh sách. */
  current: ResearchVersion | null;
  onVersion: (id: string) => void;
  onHow: (tab: HowTab) => void;
}) {
  const t = useTranslations("signalAnalysis.research.page");
  const tv = useTranslations("signalAnalysis.research.versions");
  const tn = useTranslations("signalAnalysis.research");
  const p = useTranslations("signalAnalysis.research.page.progress");
  const optionName = (v: ResearchVersion) =>
    v.isBaseline ? t("baselineOption", { n: v.number }) : versionShort(v, tv);

  const c = versions?.classifier ?? null;
  const minLabels = classifiers?.gate.minLabels ?? null;
  const parts: { key: string; href: string; text: string }[] = [
    {
      key: "closed",
      href: "#sr-sum",
      text:
        current === null
          ? p("closedNa")
          : p("closed", { n: current.counted, gate: GATE_MIN_CLOSED }),
    },
    {
      key: "labels",
      // Khối gắn nhãn của classifier (#347).
      href: "#sr-labels",
      text:
        c === null || minLabels === null
          ? p("labelsNa")
          : c.precisionPct === null
            ? p("labelsNoPct", { name: classifierShort(c.current), n: c.labeled, min: minLabels })
            : p("labels", {
                name: classifierShort(c.current),
                n: c.labeled,
                min: minLabels,
                pct: Math.round(c.precisionPct),
              }),
    },
    {
      key: "context",
      href: "#sr-sum",
      text:
        context === null
          ? p("contextNa")
          : context.questions.some((q) => q.status === "collecting")
            ? p("context")
            : p("contextAnswered", { n: context.questions.length }),
    },
    {
      key: "open",
      href: "#sr-trades",
      text: current === null ? p("openNa") : p("open", { n: current.openTrades }),
    },
  ];

  let picker: ReactNode;
  if (versions === undefined)
    picker = versionsError ? (
      <span className="text-sm font-semibold text-muted">{tn("na")}</span>
    ) : (
      <span className="text-sm text-muted">{t("versionLoading")}</span>
    );
  else
    picker = (
      <select
        id="sr-version"
        value={current?.id ?? ""}
        onChange={(e) => {
          onVersion(e.target.value);
        }}
        className="min-h-11 min-w-0 max-w-full cursor-pointer rounded-control border-2 border-accent bg-surface px-3 text-sm font-extrabold text-ink"
      >
        {current === null ? <option value="">{tn("na")}</option> : null}
        {versions.items.map((v) => (
          <option key={v.id} value={v.id}>
            {optionName(v)}
          </option>
        ))}
      </select>
    );

  return (
    <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center md:gap-x-5 md:rounded-card md:bg-surface md:px-[18px] md:py-3.5 md:shadow-card">
      <div className="flex items-end gap-2 md:contents">
        <div className="flex min-w-0 flex-1 flex-col gap-1 md:flex-none md:flex-row md:items-center md:gap-2">
          {versions === undefined ? (
            <span className="text-xs font-extrabold md:text-[13px]">{t("version")}</span>
          ) : (
            <label htmlFor="sr-version" className="text-xs font-extrabold md:text-[13px]">
              {t("version")}
            </label>
          )}
          {picker}
        </div>
        <button
          type="button"
          onClick={() => {
            onHow("news");
          }}
          className="inline-flex min-h-11 flex-none cursor-pointer items-center rounded-control border border-accent bg-surface px-3.5 text-[13px] font-extrabold text-accent-ink hover:bg-surface-2 md:order-last md:ml-auto md:text-sm"
        >
          {t("howItWorks")}
        </button>
      </div>
      <nav
        aria-label={p("label")}
        className="flex min-w-0 flex-col gap-1 rounded-tile bg-surface px-3 py-2.5 text-[13px] shadow-card md:flex-1 md:flex-row md:flex-wrap md:items-center md:gap-x-3.5 md:gap-y-1.5 md:bg-transparent md:p-0 md:shadow-none"
      >
        <strong>{p("label")}</strong>
        {parts.map((x, i) => (
          <Fragment key={x.key}>
            {i > 0 ? (
              <span aria-hidden="true" className="text-border-input max-md:hidden">
                |
              </span>
            ) : null}
            <a href={x.href} className={linkCls}>
              {x.text}
            </a>
          </Fragment>
        ))}
      </nav>
    </div>
  );
}
