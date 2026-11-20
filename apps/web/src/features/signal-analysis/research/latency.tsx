"use client";

import {
  RESEARCH_LATENCY_STAGES,
  type ResearchArticle,
  type ResearchLatency,
  type ResearchLatencyStageKey,
  type ResearchRange,
  type ResearchTraceLatency,
} from "@drift/shared";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { clock } from "../format";

import { useResearchLatency, type VersionId } from "./api";
import type { Tr } from "./text";

// Độ trễ theo chặng (#375, mockup docs/mockups/signal-research/catalyst-latency-*, DEC-348 mục 4, DEC-349). Hai phần:
// - `LatencyCard`: ô "Where the time goes" ở chế độ tổng (thay ô "Delay"): median từng chặng từ `GET /latency`, thanh chia
//   chặng, làm nổi chặng chậm nhất.
// - `LatencyTimeline`: dòng thời gian 6 mốc trong thẻ 1 · Collect của trace.
// Mọi số từ API; chặng chưa có bài → "Not measured yet", chặng nguồn → SoSoValue → "Not provided"; không bao giờ hiện 0.

/** "40 ms", "9 s", "5 min 45 s", "1 h 12 min" từ số ms (≥ 0). */
export function durationText(ms: number, t: Tr): string {
  if (ms < 1) return t("latency.underMs");
  if (ms < 1000) return t("latency.ms", { n: Math.round(ms) });
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${String(secs)} s`;
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s === 0 ? `${String(m)} min` : `${String(m)} min ${String(s)} s`;
  }
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m === 0 ? `${String(h)} h` : `${String(h)} h ${String(m)} min`;
}

const b = (c: ReactNode) => <strong className="text-ink">{c}</strong>;

/** Chặng đo được (bỏ chặng nguồn → SoSoValue, không bao giờ có số). */
const MEASURED = RESEARCH_LATENCY_STAGES.filter((k) => k !== "sourceToSoso");

// Màu thanh: chặng chậm nhất hổ phách (cảnh báo), còn lại các sắc accent (chỉ token).
const SEG: Record<Exclude<ResearchLatencyStageKey, "sourceToSoso">, string> = {
  publishedToCollected: "bg-accent-ink",
  collectedToClaudeDone: "bg-accent",
  claudeDoneToDecided: "bg-[color-mix(in_srgb,var(--accent)_55%,var(--surface))]",
  decidedToOpened: "bg-[color-mix(in_srgb,var(--accent)_30%,var(--surface))]",
};

export interface LatencyRow {
  key: ResearchLatencyStageKey;
  medianMs: number | null;
  slowest: boolean;
}

/** Chặng chậm nhất trong các chặng đo được (null khi chưa chặng nào có số). */
export function latencyRows(l: ResearchLatency | null): LatencyRow[] {
  const by = new Map(l?.stages.map((s) => [s.key, s.medianMs]) ?? []);
  let slow: ResearchLatencyStageKey | null = null;
  let max = -1;
  for (const k of MEASURED) {
    const v = by.get(k) ?? null;
    if (v !== null && v > max) {
      max = v;
      slow = k;
    }
  }
  return RESEARCH_LATENCY_STAGES.map((key) => ({
    key,
    medianMs: key === "sourceToSoso" ? null : (by.get(key) ?? null),
    slowest: key === slow,
  }));
}

export function LatencyCard({
  range,
  versionId,
  pollSecs,
  className = "",
}: {
  range: ResearchRange;
  versionId: VersionId;
  /** Nhịp hỏi SoSoValue (giây) từ tổng kết; null = không biết. */
  pollSecs: number | null;
  className?: string;
}) {
  const t = useTranslations("signalAnalysis.research");
  const q = useResearchLatency(range, versionId);
  const data = q.data ?? null;
  const rows = latencyRows(data);
  const minutes = pollSecs === null ? null : Math.max(1, Math.round(pollSecs / 60));
  const articles = data?.stages.find((s) => s.key === "publishedToCollected")?.n ?? null;
  const measured = rows.filter((r) => r.key !== "sourceToSoso");
  // Tổng = median của cả quãng published → opened do API tính trên bài đủ mọi chặng (không cộng các median).
  const full = data?.total ?? null;
  const slow = rows.find((r) => r.slowest) ?? null;
  const total = measured.reduce((a, r) => a + (r.medianMs ?? 0), 0);
  const label = (key: ResearchLatencyStageKey) =>
    key === "publishedToCollected"
      ? minutes === null
        ? t("latency.stages.publishedToCollectedPlain")
        : t("latency.stages.publishedToCollected", { n: minutes })
      : t(`latency.stages.${key}`);
  const slowName = (key: ResearchLatencyStageKey) =>
    key === "publishedToCollected" && minutes !== null
      ? t("latency.slowestWait", { n: minutes })
      : label(key);

  return (
    <div
      data-testid="sr-latency"
      aria-busy={q.isPending}
      className={`flex flex-col gap-2 rounded-[14px] border border-border px-4 py-3.5 ${className}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="m-0 text-[13px] font-extrabold">{t("latency.title")}</h3>
        {articles === null ? null : (
          <span className="text-xs text-muted">
            {t("latency.sub", { range: t(`latency.ranges.${range}`), n: articles })}
          </span>
        )}
      </div>
      {total > 0 ? (
        <div
          role="img"
          aria-label={t("latency.barAria")}
          className="flex h-3 w-full overflow-hidden rounded-full bg-bg"
        >
          {measured.map((r) =>
            r.medianMs === null || r.medianMs <= 0 || r.key === "sourceToSoso" ? null : (
              <span
                key={r.key}
                data-seg={r.key}
                style={{ width: `${String((r.medianMs / total) * 100)}%` }}
                className={`h-full min-w-[3px] ${r.slowest ? "bg-warn-bar" : SEG[r.key]}`}
              />
            ),
          )}
        </div>
      ) : null}
      <dl className="m-0 flex flex-col gap-0.5 text-[13px]">
        {rows.map((r) => (
          <div
            key={r.key}
            data-stage={r.key}
            data-slowest={r.slowest ? "" : undefined}
            className={`flex items-start justify-between gap-3 rounded-md px-1.5 py-0.5 ${r.slowest ? "bg-warn-bg" : ""}`}
          >
            <dt className="flex min-w-0 items-start gap-2 text-ink-2">
              <span
                aria-hidden="true"
                className={`mt-[5px] size-2.5 flex-none rounded-[3px] ${
                  r.key === "sourceToSoso" || r.medianMs === null
                    ? "border border-border-input bg-surface"
                    : r.slowest
                      ? "bg-warn-bar"
                      : SEG[r.key]
                }`}
              />
              <span>{label(r.key)}</span>
            </dt>
            <dd
              className={`m-0 flex-none text-right ${r.medianMs === null ? "text-muted" : "font-extrabold text-ink"}`}
            >
              {r.key === "sourceToSoso"
                ? t("latency.notProvided")
                : q.isError && data === null
                  ? t("na")
                  : r.medianMs === null
                    ? t("latency.notMeasured")
                    : durationText(r.medianMs, t)}
            </dd>
          </div>
        ))}
      </dl>
      {slow === null ? null : (
        <p data-testid="sr-latency-slowest" className="m-0 text-xs leading-normal text-warn">
          {t.rich("latency.slowest", {
            leg: slowName(slow.key),
            b: (c) => <strong>{c}</strong>,
          })}
          {slow.key === "publishedToCollected" && minutes !== null ? (
            <span className="text-ink-2"> {t("latency.slowestWaitWhy", { n: minutes })}</span>
          ) : null}
        </p>
      )}
      {data === null ? null : (
        <p data-testid="sr-latency-total" className="m-0 text-xs leading-normal text-ink-2">
          {full === null
            ? t.rich("latency.totalNone", { b })
            : t.rich("latency.totalMedian", {
                duration: durationText(full.medianMs, t),
                n: full.n,
                b,
              })}
        </p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Trace › thẻ Collect */

interface Mark {
  key: string;
  label: string;
  /** Giờ của mốc; null = chưa đo được (hoặc không có nguồn với mốc đầu). */
  at: string | null;
  /** Chữ thay giờ khi `at` null. */
  empty: string;
  /** Dòng phụ dưới nhãn ("+8 s", giải thích "Not provided"). */
  sub: string | null;
}

const gapMs = (from: string | null, to: string | null): number | null =>
  from === null || to === null ? null : Math.max(0, Date.parse(to) - Date.parse(from));

/** Dòng thời gian 6 mốc của một bài: nguồn → SoSoValue → collected → Claude done → decided → opened. */
export function LatencyTimeline({
  article,
  latency,
  pollSecs,
  tz,
}: {
  article: ResearchArticle;
  latency: ResearchTraceLatency;
  pollSecs: number | null;
  tz: string;
}) {
  const t = useTranslations("signalAnalysis.research");
  const minutes = pollSecs === null ? null : Math.max(1, Math.round(pollSecs / 60));
  const gap = (from: string | null, to: string | null, wait = false): string | null => {
    const ms = gapMs(from, to);
    if (ms === null) return null;
    const d = durationText(ms, t);
    return wait && minutes !== null
      ? t("latency.timeline.gapWait", { duration: d, n: minutes })
      : t("latency.timeline.gap", { duration: d });
  };
  const { claudeDoneAt, decidedAt, decision, openedAt } = latency;
  const decidedLabel =
    decision === "open" && article.side !== null
      ? t("latency.timeline.decidedTrade", {
          side: t(`sides.${article.side}`),
          asset: article.tagged[0] ?? article.asset ?? "",
        })
      : decision === "noTrade"
        ? t("latency.timeline.decidedNoTrade")
        : t("latency.timeline.decided");
  const marks: Mark[] = [
    {
      key: "published",
      label: t("latency.timeline.published"),
      at: null,
      empty: t("latency.notProvided"),
      sub: t("latency.timeline.notProvidedWhy"),
    },
    {
      key: "released",
      label: t("latency.timeline.released"),
      at: article.publishedAt,
      empty: t("latency.notMeasured"),
      sub: null,
    },
    {
      key: "collected",
      label: t("latency.timeline.collected"),
      at: article.collectedAt,
      empty: t("latency.notMeasured"),
      sub: gap(article.publishedAt, article.collectedAt, true),
    },
    {
      key: "claudeDone",
      label: t("latency.timeline.claudeDone"),
      at: claudeDoneAt,
      empty: t("latency.notMeasured"),
      sub: gap(article.collectedAt, claudeDoneAt),
    },
    {
      key: "decided",
      label: decidedLabel,
      at: decidedAt,
      empty: t("latency.notMeasured"),
      sub: gap(claudeDoneAt, decidedAt),
    },
    {
      key: "opened",
      label: t("latency.timeline.opened"),
      at: openedAt,
      // Đã quyết định không vào lệnh: không bao giờ có lệnh để đo.
      empty: decision === "noTrade" ? t("na") : t("latency.notMeasured"),
      sub: gap(decidedAt, openedAt),
    },
  ];
  const toOpened = gapMs(article.publishedAt, openedAt);
  const toDecided = gapMs(article.publishedAt, decidedAt);
  return (
    <div data-testid="sr-latency-timeline" className="mt-3 rounded-tile border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        {/* Không phải tiêu đề: thẻ Collect đã có tiêu đề bước. */}
        <span className="text-[13px] font-extrabold">{t("latency.timeline.title")}</span>
        <span className="text-xs text-ink-2">
          {toOpened !== null
            ? t.rich("latency.timeline.toOpened", { duration: durationText(toOpened, t), b })
            : toDecided !== null
              ? t.rich("latency.timeline.toDecided", { duration: durationText(toDecided, t), b })
              : t.rich("latency.timeline.toDecided", { duration: t("latency.notMeasured"), b })}
        </span>
      </div>
      {/* Không dùng <ol>: thẻ nằm trong danh sách bước, tránh lồng mục danh sách vào "Steps this article went through". */}
      <div className="mt-2 flex flex-col">
        {marks.map((m, i) => {
          const has = m.at !== null;
          return (
            <div key={m.key} data-mark={m.key} className="relative flex gap-2.5 pb-2.5 last:pb-0">
              {i < marks.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="absolute top-3 bottom-0 left-[5px] w-px bg-border"
                />
              ) : null}
              <span
                aria-hidden="true"
                className={`relative mt-[3px] size-[11px] flex-none rounded-full ${
                  has ? "bg-accent" : "border border-border-input bg-surface"
                }`}
              />
              <div className="flex min-w-0 flex-1 items-start justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <div className="text-ink">{m.label}</div>
                  {m.sub === null ? null : (
                    <div className={m.key === "published" ? "font-bold text-ink-2" : "text-ink-2"}>
                      {m.sub}
                    </div>
                  )}
                </div>
                <div
                  className={`flex-none text-right ${has ? "font-extrabold text-ink" : "text-muted"}`}
                >
                  {m.at === null ? m.empty : clock(m.at, tz)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
