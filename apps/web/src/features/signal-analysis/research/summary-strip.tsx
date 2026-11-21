"use client";

import {
  CLASSIFIER_GATE,
  GATE_MIN_CLOSED,
  type ResearchContextSummary,
  type ResearchSource,
  type ResearchVersion,
  type ResearchVersions,
} from "@drift/shared";
import { Button } from "@drift/ui";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { clock, count, monthDay } from "../format";

import { balance, delay, tone, usdSigned } from "./format";
import { DEFAULT_HOW_TAB, type HowTab } from "./how-it-works";
import { Na, Pill } from "./ui";
import { gateText, versionShort, type Tv } from "./version-text";

// Dải tóm tắt đầu trang Signal research (thiết kế docs/mockups/signal-research/compact-desktop.html, người dùng duyệt
// 2026-11-20): thay khối Paper bots, Classifier quality và dòng Progress. Trên cùng là dải "Research only · fake money"
// với chấm nguồn; dưới là bộ chọn Version, mỗi version đang chạy / tạm dừng một dòng (tối đa 3), rồi một hàng nói bằng lời
// thường Claude reader đã đủ nhãn chưa, kèm [Label signals] [Manage versions]. Mọi số từ API versions / tổng kết; thiếu
// thì "Not available", không bao giờ 0 (quy tắc 1.8).

/** Tối đa ngần này dòng version trong dải (thiết kế; = số version chạy cùng lúc). */
export const STRIP_MAX_LINES = 3;

/** Các version hiện trong dải: đang chạy / tạm dừng (thứ tự API), version đang chọn luôn có mặt; tối đa 3. */
export function stripVersions(
  items: readonly ResearchVersion[],
  pickedId: string | null,
): ResearchVersion[] {
  const active = items.filter((v) => v.status === "running" || v.status === "paused");
  const picked = pickedId === null ? undefined : items.find((v) => v.id === pickedId);
  if (picked === undefined) return active.slice(0, STRIP_MAX_LINES);
  const rest = active.filter((v) => v.id !== picked.id);
  // Version đang chọn giữ chỗ của nó khi đã nằm trong 3 dòng đầu; không thì đứng đầu.
  const idx = active.indexOf(picked);
  if (idx >= 0 && idx < STRIP_MAX_LINES) return active.slice(0, STRIP_MAX_LINES);
  return [picked, ...rest].slice(0, STRIP_MAX_LINES);
}

export type CountPart =
  { kind: "none" } | { kind: "counting"; n: number; weeks: number | null } | { kind: "verdict" };

/**
 * Phần "đếm" của một dòng: chưa đếm (Claude reader chưa qua nhãn, hàng nhãn bên dưới đã nói) thì không ghi gì; đã có kết
 * luận thì "Verdict: …"; còn lại "Counting: n of ~100 closed trades · ~w weeks" (`weeks` chỉ có cho version của tổng kết).
 */
export function countPart(v: ResearchVersion, weeks: number | null): CountPart {
  if (v.gate.classifierStatus !== "passed") return { kind: "none" };
  if (v.gate.status === "passes" || v.gate.status === "fails" || v.gate.status === "needs_repeat")
    return { kind: "verdict" };
  return { kind: "counting", n: v.counted, weeks };
}

export type LabelState =
  | { kind: "na" }
  | { kind: "needs"; k: number; n: number }
  | { kind: "under"; pct: number | null; n: number }
  | { kind: "passed"; n: number; pct: number | null };

/** Hàng nhãn của dải, theo classifier hiện tại của API versions (chung cho mọi version). */
export function labelState(c: ResearchVersions["classifier"] | null): LabelState {
  if (c === null) return { kind: "na" };
  switch (c.status) {
    case "needsLabels":
      return { kind: "needs", k: c.labelsToGo, n: c.labeled };
    case "underPrecision":
      return { kind: "under", pct: c.precisionPct, n: c.labeled };
    case "passed":
      return { kind: "passed", n: c.labeled, pct: c.precisionPct };
  }
}

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

/** Chấm nguồn: Live xanh dương (trạng thái trung tính, không dùng xanh lá), Delayed hổ phách, Down đỏ. */
const DOT: Record<ResearchSource["status"], string> = {
  live: "bg-accent",
  delayed: "bg-warn-bar",
  down: "bg-neg",
};

function Banner({
  sources,
  tz,
}: {
  sources: { items: readonly ResearchSource[]; now: string } | null;
  tz: string;
}) {
  const t = useTranslations("signalAnalysis.research.page.banner");
  const ts = useTranslations("signalAnalysis.research.sources");
  const line = useSourceLine();
  return (
    <div
      role="note"
      className="flex flex-col gap-1 border-b border-warn-border bg-warn-bg px-3 py-2.5 text-xs text-warn md:flex-row md:flex-wrap md:items-center md:gap-x-4 md:px-[18px] md:py-2 md:text-[13px]"
    >
      <strong className="text-[13px] md:text-sm">
        <span className="md:hidden">{t("titleShort")}</span>
        <span className="max-md:hidden">{t("title")}</span>
      </strong>
      <span>{t("body")}</span>
      {sources === null || sources.items.length === 0 ? null : (
        <ul
          aria-label={t("sourcesLabel")}
          className="m-0 flex list-none flex-col gap-0.5 p-0 md:flex-row md:flex-wrap md:gap-x-4"
        >
          {sources.items.map((s) => {
            const l = line(s, sources.now, tz);
            return (
              <li key={s.key} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={`inline-block size-2 flex-none rounded-full ${DOT[s.status]}`}
                />
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

const Sep = () => (
  <span aria-hidden="true" className="text-muted">
    {" · "}
  </span>
);

function VersionLine({
  v,
  selected,
  weeks,
  unrealized,
  tv,
}: {
  v: ResearchVersion;
  selected: boolean;
  weeks: number | null;
  /** Lãi / lỗ chưa chốt (chỉ version của tổng kết); null = không ghi. */
  unrealized: string | null;
  tv: Tv;
}) {
  const t = useTranslations("signalAnalysis.research.strip");
  const b = (c: ReactNode) => <b className="text-ink">{c}</b>;
  const part = countPart(v, weeks);
  return (
    <li
      aria-current={selected || undefined}
      className={`rounded-control border-l-[3px] px-2.5 py-1.5 text-[13px] leading-normal text-ink-2 md:text-sm ${
        selected ? "border-accent bg-surface-2" : "border-transparent"
      }`}
    >
      <b className="text-ink">{t("lineName", { name: v.name, n: v.number })}</b>
      <Sep />
      <Pill tone={v.status === "running" ? "accent" : "neutral"}>{tv(`state.${v.status}`)}</Pill>
      <Sep />
      <span className="whitespace-nowrap">
        {t("balance")} <b className="text-ink tabular-nums">{balance(v.balance)}</b>
      </span>
      {unrealized === null ? null : (
        <>
          {" "}
          <span className={`font-bold whitespace-nowrap ${tone(Number(unrealized))}`}>
            {t("unrealized", { pnl: usdSigned(unrealized) })}
          </span>
        </>
      )}
      <Sep />
      <span className="whitespace-nowrap">{t("open", { n: count(v.openTrades) })}</span>
      {part.kind === "none" ? null : (
        <>
          <Sep />
          {part.kind === "verdict" ? (
            <span className="text-ink">{t("verdict", { text: gateText(v, new Map(), tv) })}</span>
          ) : (
            <span className="text-ink">
              {t.rich("counting", { n: count(part.n), gate: GATE_MIN_CLOSED, b })}
              {" · "}
              {part.weeks === null ? (
                <>
                  {t("timeLeft")} <Na />
                </>
              ) : (
                t("weeks", { weeks: part.weeks })
              )}
            </span>
          )}
        </>
      )}
      {selected ? (
        <span className="text-xs font-bold whitespace-nowrap text-accent-ink">
          {" · "}
          {t("shown")}
        </span>
      ) : null}
    </li>
  );
}

function LabelRow({
  versions,
  context,
  onLabel,
  onManage,
}: {
  versions: ResearchVersions | undefined;
  context: ResearchContextSummary | null;
  onLabel: () => void;
  onManage: () => void;
}) {
  const t = useTranslations("signalAnalysis.research.strip");
  const b = (c: ReactNode) => <b>{c}</b>;
  const s = labelState(versions?.classifier ?? null);
  const min = CLASSIFIER_GATE.minLabels;
  const pctMin = CLASSIFIER_GATE.minPrecisionPct;
  let msg: ReactNode;
  switch (s.kind) {
    case "na":
      msg = (
        <>
          {t.rich("labelsNa", { b })} <Na />
        </>
      );
      break;
    case "needs":
      msg = t.rich("labelsNeed", { k: s.k, n: count(s.n), b });
      break;
    case "under":
      msg =
        s.pct === null ? (
          <>
            {t.rich("labelsNa", { b })} <Na />
          </>
        ) : (
          t.rich("labelsUnder", {
            pct: Math.round(s.pct),
            n: s.n,
            min: pctMin,
            need: min,
            b,
          })
        );
      break;
    case "passed":
      msg =
        s.pct === null ? (
          <>
            {t.rich("labelsNa", { b })} <Na />
          </>
        ) : (
          t.rich("labelsPassed", { n: s.n, pct: Math.round(s.pct), b })
        );
      break;
  }
  const ctx =
    context === null ? (
      <>
        {t("contextNa")} <Na />
      </>
    ) : context.questions.some((q) => q.status === "collecting") ? (
      t("context")
    ) : (
      t("contextAnswered", { n: context.questions.length })
    );
  return (
    <div
      data-testid="sr-label-row"
      data-state={s.kind}
      className={`flex flex-col gap-2.5 rounded-tile px-3 py-3 md:flex-row md:flex-wrap md:items-center md:justify-between md:px-3.5 md:py-2.5 ${
        s.kind === "under" ? "bg-warn-bg" : s.kind === "na" ? "bg-surface-2" : "bg-accent-tint"
      }`}
    >
      <div className="min-w-0 text-sm leading-normal text-ink">
        <p className="m-0">{msg}</p>
        <p className="m-0 text-xs text-ink-2">{ctx}</p>
      </div>
      <div className="grid grid-cols-2 gap-2 md:flex md:flex-none">
        <Button onClick={onLabel} className="font-extrabold">
          {t("labelSignals")}
        </Button>
        <button
          type="button"
          onClick={onManage}
          className="inline-flex min-h-tap cursor-pointer items-center justify-center rounded-control border border-accent bg-surface px-4 text-sm font-extrabold whitespace-nowrap text-accent-ink hover:bg-surface-2"
        >
          {t("manage")}
        </button>
      </div>
    </div>
  );
}

export function SummaryStrip({
  sources,
  tz,
  versions,
  versionsError,
  current,
  context,
  weeks,
  unrealized,
  onVersion,
  onHow,
  onLabel,
  onManage,
}: {
  /** null khi tổng kết chưa tải. */
  sources: { items: readonly ResearchSource[]; now: string } | null;
  tz: string;
  versions: ResearchVersions | undefined;
  versionsError: boolean;
  /** Version đang chọn (đã quy về Baseline khi chưa chọn); null khi chưa có danh sách. */
  current: ResearchVersion | null;
  /** Khối "Does context help?" (live) của tổng kết; null khi chưa tải / lane chưa chạy. */
  context: ResearchContextSummary | null;
  /** "~3 weeks" của version mà tổng kết mô tả; null = không biết. */
  weeks: { versionId: string; weeks: number | null } | null;
  /** Lãi / lỗ chưa chốt của bot News trong tổng kết, chỉ của version tổng kết mô tả. */
  unrealized: { versionId: string; value: string | null } | null;
  onVersion: (id: string) => void;
  onHow: (tab: HowTab) => void;
  onLabel: () => void;
  onManage: () => void;
}) {
  const t = useTranslations("signalAnalysis.research.page");
  const ts = useTranslations("signalAnalysis.research.strip");
  const tv = useTranslations("signalAnalysis.research.versions");
  const tn = useTranslations("signalAnalysis.research");
  const optionName = (v: ResearchVersion) =>
    v.isBaseline ? t("baselineOption", { n: v.number }) : versionShort(v, tv);

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
        className="min-h-11 w-full min-w-0 cursor-pointer rounded-control border-2 border-accent bg-surface px-3 text-sm font-extrabold text-ink md:w-auto md:min-w-[190px]"
      >
        {current === null ? <option value="">{tn("na")}</option> : null}
        {versions.items.map((v) => (
          <option key={v.id} value={v.id}>
            {optionName(v)}
          </option>
        ))}
      </select>
    );

  let lines: ReactNode;
  if (versions === undefined)
    lines = versionsError ? (
      <p className="m-0 px-2.5 py-1.5 text-sm text-ink-2">
        {ts("versionsNa")} <Na />
      </p>
    ) : null;
  else {
    const shown = stripVersions(versions.items, current?.id ?? null);
    lines =
      shown.length === 0 ? null : (
        <ul aria-label={ts("linesLabel")} className="m-0 flex list-none flex-col gap-1.5 p-0">
          {shown.map((v) => (
            <VersionLine
              key={v.id}
              v={v}
              selected={v.id === current?.id}
              weeks={weeks?.versionId === v.id ? weeks.weeks : null}
              unrealized={unrealized?.versionId === v.id ? unrealized.value : null}
              tv={tv}
            />
          ))}
        </ul>
      );
  }

  const how = (
    <button
      type="button"
      onClick={() => {
        onHow(DEFAULT_HOW_TAB);
      }}
      className="inline-flex min-h-11 flex-none cursor-pointer items-center rounded-control border border-accent bg-surface px-3.5 text-[13px] font-extrabold text-accent-ink hover:bg-surface-2 md:text-sm"
    >
      {t("howItWorks")}
    </button>
  );

  return (
    <section
      aria-label={ts("label")}
      className="overflow-hidden rounded-card bg-surface shadow-card"
    >
      <Banner sources={sources} tz={tz} />
      <div className="flex flex-col gap-2.5 p-3 md:grid md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-start md:gap-x-5 md:gap-y-3 md:px-[18px] md:py-3.5">
        <div className="flex items-end gap-2 md:contents">
          <div className="flex min-w-0 flex-1 flex-col gap-1 md:col-start-1 md:row-start-1 md:flex-none">
            {versions === undefined ? (
              <span className="text-xs font-extrabold">{t("version")}</span>
            ) : (
              <label htmlFor="sr-version" className="text-xs font-extrabold">
                {t("version")}
              </label>
            )}
            {picker}
          </div>
          <div className="flex-none md:col-start-3 md:row-start-1 md:pt-[18px]">{how}</div>
        </div>
        <div className="min-w-0 md:col-start-2 md:row-start-1 md:pt-0.5">{lines}</div>
        <div className="md:col-span-3 md:row-start-2">
          <LabelRow versions={versions} context={context} onLabel={onLabel} onManage={onManage} />
        </div>
      </div>
    </section>
  );
}
