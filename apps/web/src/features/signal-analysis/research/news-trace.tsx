"use client";

import {
  funnelSteps,
  RESEARCH_ARTICLE_SHOWS,
  RESEARCH_DROP_REASONS,
  RESEARCH_RANGES,
  type ResearchArticle,
  type ResearchDropReason,
  type ResearchFunnel,
  type ResearchRange,
  type ResearchStage,
} from "@drift/shared";
import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { ApiError } from "@/lib/api";
import { useMarketNames } from "@/lib/markets";

import type { PageCtx } from "../components/signal-analysis-page";
import { clock, count } from "../format";

import { useResearchArticles, useResearchTrace, type ArticleFilters } from "./api";
import { delay, delayLong } from "./format";
import type { Tr } from "./text";
import {
  articleTitle,
  assetsText,
  claudeCost,
  reached,
  STAGES,
  traceView,
  type ChipTone,
  type StepView,
  type TraceView,
} from "./trace-text";
import { Na, Sub } from "./ui";

// "How news becomes a paper trade" (#292, thiết kế docs/mockups/signal-research/news-trace*.html, API #291). Một phễu
// hai chế độ: tổng của 1 ngày / 7 ngày (mặc định), và trace một bài khi chọn bài ở News feed hoặc bấm Trace ở bảng
// Trades: chip chạy xuống từng tầng, thẻ từng bước hiện dần. prefers-reduced-motion: không chạy, hiện ngay kết quả.
// Mọi số từ API; thiếu thì "Not available", không bao giờ 0 (quy tắc 1.8).

/** Thời gian mỗi bước (thiết kế: `normal` = 950 ms). */
export const STEP_MS = 950;
/** Sau bước cuối (5) là kết luận. */
const DONE = 6;

type Show = ArticleFilters["show"];
type BandState = "total" | "pass" | "drop" | "merge" | "active" | "idle" | "skip";

export interface TraceRequest {
  id: string;
  /** Tăng mỗi lần bấm Trace, kể cả cùng bài (chạy lại). */
  seq: number;
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function scrollToId(id: string, onlyBelowMd: boolean) {
  if (typeof window === "undefined") return;
  if (
    onlyBelowMd &&
    !(typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches)
  )
    return;
  const el = document.getElementById(id);
  if (el === null || typeof el.scrollIntoView !== "function") return;
  el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
}

// Hình học tầng desktop (thiết kế: cao 392, mỗi tầng 60 px, cách 76 px, rộng 54 → 26 %). Dưới 768 px các tầng xếp chồng,
// rộng 100 → 60 %, nhãn và kết quả một dòng nằm trong tầng.
const ROW = 76;
const TOP = 4;
const WIDTHS = [54, 47, 40, 33, 26] as const;
// #297: tầng cuối đủ rộng cho "5 · Decide" và "Long 0 · Short 2" trên cùng một dòng.
const MOBILE_WIDTHS = [100, 94, 88, 82, 76] as const;
// Màu tầng: chỉ token (accent-ink → accent → pos-dot).
const BLUES = [
  "bg-accent-ink",
  "bg-[color-mix(in_srgb,var(--accent-ink)_50%,var(--accent))]",
  "bg-accent",
  "bg-[color-mix(in_srgb,var(--accent)_82%,var(--surface))]",
  "bg-pos-dot",
] as const;
const BAND_BG: Record<Exclude<BandState, "total" | "pass">, string> = {
  drop: "bg-neg",
  merge: "bg-ink-2",
  active: "bg-accent",
  skip: "bg-[color-mix(in_srgb,var(--ink)_92%,var(--accent))]",
  idle: "bg-[color-mix(in_srgb,var(--ink)_84%,var(--accent))]",
};
const CHIP: Record<ChipTone, string> = {
  pos: "bg-pos-bg text-pos",
  neg: "bg-neg-bg text-neg-ink",
  neutral: "bg-bg text-ink-2",
  accent: "bg-accent-tint text-accent-ink",
};

const toggle = (on: boolean) =>
  `inline-flex min-h-10 cursor-pointer items-center rounded-control border px-3 text-[13px] font-bold ${
    on ? "border-accent bg-accent text-white" : "border-border-input bg-surface text-ink"
  }`;
const linkBtn =
  "inline-flex min-h-11 cursor-pointer items-center self-start border-0 bg-transparent p-0 text-[13px] font-bold text-accent-ink underline hover:text-ink disabled:cursor-not-allowed disabled:opacity-60";

/* ---------------------------------------------------------------- Totals (chế độ tổng) */

interface Totals {
  counts: (string | null)[];
  notes: (string | null)[];
  reasons: { reason: ResearchDropReason; n: number }[];
}

function totals(f: ResearchFunnel | null, t: Tr): Totals {
  if (f === null)
    return { counts: STAGES.map(() => null), notes: STAGES.map(() => null), reasons: [] };
  const dropped = f.articleStops.filter((s) => s.outcome === "dropped" && s.reason !== null);
  const byReason = new Map<ResearchDropReason, { n: number; stage: number }>();
  for (const s of dropped) {
    if (s.reason === null) continue;
    const cur = byReason.get(s.reason);
    const stage = STAGES.indexOf(s.stage);
    byReason.set(s.reason, {
      n: (cur?.n ?? 0) + s.n,
      stage: cur === undefined ? stage : Math.min(cur.stage, stage),
    });
  }
  const reasons = [...byReason.entries()]
    .filter(([, v]) => v.n > 0)
    .sort(
      (a, b) =>
        a[1].stage - b[1].stage ||
        b[1].n - a[1].n ||
        RESEARCH_DROP_REASONS.indexOf(a[0]) - RESEARCH_DROP_REASONS.indexOf(b[0]),
    )
    .map(([reason, v]) => ({ reason, n: v.n }));
  // #297: mọi tầng đếm cùng một đơn vị (bài thu trong khoảng) từ `articleStops`: vào − ra − chờ = tầng sau.
  const steps = funnelSteps(f.articleStops);
  const noteAt = (i: number): string => {
    const st = steps[i];
    if (st === undefined) return t("trace.notes.outNone");
    const out = st.dropped + st.merged;
    const parts = st.reasons
      .slice(0, 2)
      .map((r) =>
        t("trace.notes.reasonN", { n: count(r.n), label: t(`trace.noteReasons.${r.reason}`) }),
      );
    if (st.merged > 0) parts.push(t("trace.notes.merged", { n: count(st.merged) }));
    const head =
      out === 0
        ? t("trace.notes.outNone")
        : t("trace.notes.out", { n: count(out), reasons: parts.join(", ") });
    return st.waiting === 0 ? head : t("trace.notes.waiting", { text: head, n: count(st.waiting) });
  };
  const passed = (i: number) => steps[i]?.passed ?? 0;
  return {
    counts: [
      t("trace.counts.collect", { n: steps[0]?.in ?? 0 }),
      t("trace.counts.normalize", { n: passed(1) }),
      t("trace.counts.score", { n: passed(2) }),
      t("trace.counts.filter", { n: count(passed(3)) }),
      t("trace.counts.decide", { long: count(f.long), short: count(f.short) }),
    ],
    notes: [
      t("trace.notes.collect"),
      noteAt(1),
      noteAt(2),
      noteAt(3),
      t("trace.notes.decide", { size: count(Number(f.sizeUsdc)) }),
    ],
    reasons,
  };
}

/* ---------------------------------------------------------------- Component */

export function NewsTrace({
  ctx,
  funnel,
  range,
  onRange,
  request,
  versionId = null,
}: {
  ctx: PageCtx;
  funnel: ResearchFunnel | null;
  range: ResearchRange;
  onRange: (r: ResearchRange) => void;
  request: TraceRequest | null;
  /** #306: News bot version (bước Filter / Decide, story và lệnh của version); null = Baseline. */
  versionId?: string | null;
}) {
  const t = useTranslations("signalAnalysis.research");
  const ts = useTranslations("signalAnalysis.states");
  const [show, setShow] = useState<Show>("all");
  const [stage, setStage] = useState<ResearchStage | null>(null);
  const [reason, setReason] = useState<ResearchDropReason | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const [step, setStep] = useState(DONE);

  const trace = useResearchTrace(sel, versionId);
  const names = useMarketNames();
  const data = (trace.data?.article.id === sel ? trace.data : undefined) ?? null;
  const view: TraceView | null =
    data === null ? null : traceView(data, ctx.tz, t, (m) => names.info(m)?.tickSize ?? null);
  const stop = view?.stop ?? STAGES.length;

  // Mỗi bước một timeout; dừng khi tới kết luận. Chưa có dữ liệu trace thì đứng ở "Article arriving…".
  useEffect(() => {
    if (sel === null || view === null || step > stop) return;
    const id = setTimeout(() => {
      setStep((s) => s + 1);
    }, STEP_MS);
    return () => {
      clearTimeout(id);
    };
  }, [sel, run, view, step, stop]);

  const start = (id: string, scroll: "funnel" | "trace") => {
    setSel(id);
    setRun((r) => r + 1);
    setStep(reducedMotion() ? DONE : 0);
    if (scroll === "funnel") scrollToId("sr-funnel", false);
    else scrollToId("sr-trace", true);
  };
  const back = () => {
    setSel(null);
    setStep(DONE);
  };

  // Nút Trace ở bảng Trades: cuộn tới phễu và chạy bài đó.
  const handled = useRef(0);
  useEffect(() => {
    if (request === null || request.seq === handled.current) return;
    handled.current = request.seq;
    start(request.id, "funnel");
  });

  const tracing = sel !== null;
  const tot = totals(funnel, t);
  const pos = Math.min(step, stop);
  const finished = view !== null && step > stop;
  const bandState = (i: number): BandState => {
    if (!tracing) return "total";
    const n = i + 1;
    if (view === null) return n === 1 && step > 0 ? "active" : "idle";
    if (n > stop) return step > stop ? "skip" : "idle";
    if (n < pos) return "pass";
    if (n === pos) {
      if (step <= n) return "active";
      const s = view.steps[i]?.status;
      return s === "drop" ? "drop" : s === "merge" ? "merge" : "pass";
    }
    return "idle";
  };

  const rangeLabel = t(`trace.range.${range}`);
  let verdict: string;
  let verdictTone = "text-on-ink-accent";
  let verdictMobile: string | null = null;
  if (!tracing) {
    verdict = t("trace.verdict.idle");
    verdictMobile = t("trace.verdict.idleMobile");
  } else if (view === null)
    verdict = trace.isError ? t("trace.verdict.error") : t("trace.verdict.arriving");
  else if (!finished)
    verdict =
      pos === 0
        ? t("trace.verdict.arriving")
        : t("trace.verdict.step", {
            n: pos,
            name: t(`trace.stages.${STAGES[pos - 1] ?? "collect"}`),
          });
  else {
    verdict = `${view.verdict}${t("trades.sep")}${view.cost}`;
    if (view.end === "drop") verdictTone = "text-on-ink-neg";
    else if (view.end === "traded") verdictTone = "text-on-ink-pos";
  }

  const onBand = (i: number) => {
    const s = STAGES[i] ?? null;
    setStage((x) => (x === s ? null : s));
    setReason(null);
  };
  const onReason = (r: ResearchDropReason) => {
    setReason((x) => (x === r ? null : r));
    setStage(null);
  };

  return (
    <section
      id="sr-funnel"
      aria-labelledby="sr-fn-title"
      className="flex min-w-0 scroll-mt-4 flex-col gap-3 rounded-card bg-surface p-4 shadow-card md:gap-[18px] md:p-6"
    >
      <div className="flex flex-col items-start gap-3 md:flex-row md:flex-wrap md:items-center md:justify-between">
        <h2 id="sr-fn-title" className="m-0 text-[17px] font-extrabold md:text-xl">
          <span className="md:hidden">{t("trace.titleShort")}</span>
          <span className="max-md:hidden">{t("trace.title", { range: rangeLabel })}</span>
        </h2>
        <div
          role="group"
          aria-label={t("trace.period")}
          className="flex gap-1 rounded-control border border-border bg-surface-2 p-1"
        >
          {RESEARCH_RANGES.map((r) => {
            const on = r === range;
            return (
              <button
                key={r}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  onRange(r);
                }}
                className={`min-h-9 cursor-pointer rounded-lg border-0 px-3.5 text-[13px] font-extrabold ${
                  on ? "bg-surface text-ink shadow-card" : "bg-transparent text-muted"
                }`}
              >
                {t(`trace.periods.${r}`)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <Feed
          ctx={ctx}
          filters={{ range, show, stage, reason }}
          versionId={versionId}
          sel={sel}
          onShow={setShow}
          onClear={() => {
            setStage(null);
            setReason(null);
          }}
          onPick={(id) => {
            start(id, "trace");
          }}
        />

        <div
          id="sr-trace"
          className="flex min-w-0 flex-[999_1_640px] scroll-mt-4 flex-col gap-4 max-md:border-t max-md:border-border max-md:pt-1"
        >
          <p className="m-0 mt-2 text-xs text-muted md:hidden">{t("trace.mobileHint")}</p>
          <div className="flex flex-col gap-3 md:min-h-11 md:flex-row md:items-start md:justify-between">
            {tracing ? (
              <TraceHead article={data?.article ?? null} tz={ctx.tz} />
            ) : (
              <p className="m-0 max-w-[560px] text-[13px] text-ink-2">
                {t("trace.totalsHint", { range: rangeLabel })}
              </p>
            )}
            {tracing ? (
              <div className="flex flex-none gap-2">
                <button
                  type="button"
                  onClick={back}
                  className="min-h-11 flex-1 cursor-pointer rounded-control border border-border-input bg-surface px-3.5 text-[13px] font-extrabold text-ink"
                >
                  {t("trace.back")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    start(sel, "trace");
                  }}
                  className="min-h-11 flex-1 cursor-pointer rounded-control border border-accent bg-accent px-4 text-[13px] font-extrabold text-white"
                >
                  {t("trace.replay")}
                </button>
              </div>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-tile bg-ink px-3 pb-4 pt-3.5 md:rounded-[16px] md:px-4 md:pb-[22px] md:pt-5">
            <div className="relative flex flex-col items-center gap-0.5 md:block md:h-[392px]">
              <div
                aria-hidden="true"
                className="absolute inset-y-0 left-1/2 -ml-px w-0.5 bg-[linear-gradient(var(--ink-2)_50%,transparent_50%)] bg-[length:2px_20px] max-md:hidden motion-safe:animate-[sr-spark_1.2s_linear_infinite]"
              />
              {STAGES.map((s, i) => (
                <Band
                  key={s}
                  i={i}
                  state={bandState(i)}
                  tracing={tracing}
                  pressed={!tracing && stage === s}
                  count={tot.counts[i] ?? null}
                  note={tot.notes[i] ?? null}
                  step={view?.steps[i] ?? null}
                  onClick={() => {
                    onBand(i);
                  }}
                />
              ))}
              {tracing && view !== null ? (
                <Token view={view} pos={pos} step={step} finished={finished} />
              ) : null}
            </div>
            <p
              role="status"
              className={`m-0 mt-2 text-center text-[13px] font-extrabold md:text-sm ${verdictTone}`}
            >
              {verdictMobile === null ? (
                verdict
              ) : (
                <>
                  <span className="md:hidden">{verdictMobile}</span>
                  <span className="max-md:hidden">{verdict}</span>
                </>
              )}
            </p>
            {tracing ? null : (
              <p className="m-0 mt-1 text-center text-xs text-on-ink-2">
                {t("trace.unitNote", { range: rangeLabel })}
              </p>
            )}
            {tracing &&
            trace.isError &&
            view === null &&
            !(trace.error instanceof ApiError && trace.error.status < 500) ? (
              <div className="mt-2 flex justify-center">
                <button
                  type="button"
                  onClick={() => void trace.refetch()}
                  className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-control border-0 bg-accent px-4 text-sm font-bold text-white"
                >
                  <RefreshCw aria-hidden="true" size={16} />
                  {ts("retry")}
                </button>
              </div>
            ) : null}
          </div>

          {tracing ? (
            <Steps
              key={`${sel}:${String(run)}`}
              steps={view?.steps ?? []}
              states={STAGES.map((_, i) => bandState(i))}
            />
          ) : (
            <TotalsPanel
              funnel={funnel}
              range={range}
              reasons={tot.reasons}
              reason={reason}
              onReason={onReason}
            />
          )}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- News feed */

function Feed({
  ctx,
  filters,
  sel,
  onShow,
  onClear,
  onPick,
  versionId,
}: {
  ctx: PageCtx;
  filters: ArticleFilters;
  versionId: string | null;
  sel: string | null;
  onShow: (s: Show) => void;
  onClear: () => void;
  onPick: (id: string) => void;
}) {
  const t = useTranslations("signalAnalysis.research");
  const ts = useTranslations("signalAnalysis.states");
  const q = useResearchArticles(filters, versionId);
  const pages = q.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const first = pages[0];
  const { stage, reason, show } = filters;
  const filterLabel =
    stage !== null
      ? t("trace.stoppedAt", {
          n: STAGES.indexOf(stage) + 1,
          name: t(`trace.stages.${stage}`),
        })
      : reason !== null
        ? t("trace.reasonFilter", { label: t(`trace.reasonLabels.${reason}`) })
        : null;
  return (
    <div className="flex min-w-0 flex-[1_1_340px] flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="m-0 mt-1 text-sm font-extrabold md:mt-0 md:text-[15px]">
          {t("trace.feed")}
        </h3>
        {first === undefined ? null : (
          <span className="text-xs text-muted">
            {t("trace.feedCount", { n: count(first.total), total: first.totalInRange })}
          </span>
        )}
      </div>
      <div
        role="group"
        aria-label={t("trace.filters")}
        className="flex gap-1.5 max-md:overflow-x-auto md:flex-wrap"
      >
        {RESEARCH_ARTICLE_SHOWS.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={show === k}
            onClick={() => {
              onShow(k);
            }}
            className={`flex-none ${toggle(show === k)}`}
          >
            {t(`trace.shows.${k}`)}
          </button>
        ))}
      </div>
      {filterLabel === null ? null : (
        <div className="flex items-center justify-between gap-2 rounded-control bg-accent-tint px-3 py-2 text-[13px] font-bold text-accent-ink">
          <span>{filterLabel}</span>
          <button
            type="button"
            onClick={onClear}
            className="min-h-8 cursor-pointer border-0 bg-transparent px-1.5 font-bold text-accent-ink underline"
          >
            {t("trace.clear")}
          </button>
        </div>
      )}
      {q.isPending ? (
        <div aria-busy="true" className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <span key={i} aria-hidden="true" className="h-20 rounded-tile bg-surface-2" />
          ))}
          <p role="status" className="m-0 text-xs text-muted">
            {t("trace.feedLoading")}
          </p>
        </div>
      ) : q.isError && items.length === 0 ? (
        <div role="alert" className="flex flex-col items-start gap-2 py-2">
          <span className="text-sm text-ink-2">{t("trace.feedError")}</span>
          <button
            type="button"
            onClick={() => void q.refetch()}
            className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-control border-0 bg-accent px-4 text-sm font-bold text-white"
          >
            <RefreshCw aria-hidden="true" size={16} />
            {ts("retry")}
          </button>
        </div>
      ) : items.length === 0 ? (
        <p className="m-0 py-2 text-sm text-muted">{t("trace.feedEmpty")}</p>
      ) : (
        // #297: chiều cao cố định (≈ khối phễu), cuộn trong khung; "Load more" ở cuối khung, 20 bài mỗi trang.
        <div
          data-testid="sr-feed-scroll"
          className="-mx-1 flex max-h-[420px] flex-col gap-2 overflow-y-auto overscroll-contain px-1 py-0.5 md:max-h-[470px]"
        >
          <ul
            aria-busy={q.isPlaceholderData}
            className={`m-0 flex list-none flex-col gap-2 p-0 ${q.isPlaceholderData ? "opacity-50" : ""}`}
          >
            {items.map((a) => (
              <li key={a.id}>
                <ArticleCard
                  a={a}
                  tz={ctx.tz}
                  selected={a.id === sel}
                  onPick={() => {
                    onPick(a.id);
                  }}
                />
              </li>
            ))}
          </ul>
          {q.hasNextPage ? (
            <button
              type="button"
              disabled={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
              className={`${linkBtn} flex-none`}
            >
              {t("trace.loadMore")}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ArticleCard({
  a,
  tz,
  selected,
  onPick,
}: {
  a: ResearchArticle;
  tz: string;
  selected: boolean;
  onPick: () => void;
}) {
  const t = useTranslations("signalAnalysis.research");
  const cost = claudeCost(a.sentToClaude, a.claude, t);
  const chip = reached(a, t);
  const title = articleTitle(a);
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onPick}
      className={`block w-full cursor-pointer rounded-tile border p-3 text-left transition-[background-color,border-color,transform] duration-200 hover:border-accent md:px-3.5 motion-safe:md:hover:translate-x-[3px] ${
        selected ? "border-accent bg-accent-tint" : "border-border bg-surface"
      }`}
    >
      <span className="flex justify-between gap-2 text-xs text-muted">
        <span>
          {t("trace.seen", { time: clock(a.publishedAt, tz, false), d: delay(a.delaySecs) })}
        </span>
        <span>{cost ?? t("na")}</span>
      </span>
      <span className="mb-1.5 mt-1 block text-sm font-bold text-ink">{title ?? t("na")}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <span
          className={`inline-block rounded-full px-2 py-[3px] text-xs font-bold ${CHIP[chip.tone]}`}
        >
          {chip.text}
        </span>
        <span className="text-xs text-muted">{assetsText(a, t)}</span>
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------- Trace header */

function TraceHead({ article, tz }: { article: ResearchArticle | null; tz: string }) {
  const t = useTranslations("signalAnalysis.research");
  if (article === null) return <div className="min-w-0 flex-1" />;
  const source =
    article.tier === null
      ? t("trace.source", { source: article.source })
      : t("trace.sourceTier", { source: article.source, tier: t(`trace.tiers.${article.tier}`) });
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h3 className="m-0 text-[15px] font-extrabold md:text-lg">
        {articleTitle(article) ?? t("na")}
      </h3>
      <span className="text-xs text-muted">
        {t("trace.published", { source, time: clock(article.publishedAt, tz, false) })}
        {article.url === null ? null : (
          <>
            {t("trades.sep")}
            <a
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold text-accent-ink hover:text-ink"
            >
              {t("trace.openArticle")}
            </a>
          </>
        )}
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------- Funnel bands */

function Band({
  i,
  state,
  tracing,
  pressed,
  count: countText,
  note,
  step,
  onClick,
}: {
  i: number;
  state: BandState;
  tracing: boolean;
  pressed: boolean;
  count: string | null;
  note: string | null;
  step: StepView | null;
  onClick: () => void;
}) {
  const t = useTranslations("signalAnalysis.research");
  const name = t(`trace.stages.${STAGES[i] ?? "collect"}`);
  const w = WIDTHS[i] ?? 26;
  const bg = state === "total" || state === "pass" ? (BLUES[i] ?? BLUES[0]) : BAND_BG[state];
  const showNote = state === "total" || state === "pass" || state === "drop" || state === "merge";
  const short = step?.short ?? "";
  const noteText =
    state === "total"
      ? note
      : state === "drop"
        ? t("trace.dropNote", { text: short })
        : state === "merge"
          ? t("trace.mergeNote", { text: short })
          : short;
  const mobileText =
    state === "total" ? countText : state === "drop" ? t("trace.out") : showNote ? short : "";
  const vars = {
    "--top": `${String(TOP + i * ROW)}px`,
    "--w": `${String(w)}%`,
    "--mw": `${String(MOBILE_WIDTHS[i] ?? 60)}%`,
    "--side": `${String(50 + w / 2 + 2)}%`,
  } as CSSProperties;
  const labelTone =
    state === "idle" || state === "skip"
      ? "text-on-ink-2/60"
      : state === "drop"
        ? "md:text-on-ink-neg text-white"
        : "text-white";
  const noteTone =
    state === "total"
      ? "text-on-ink-accent"
      : state === "drop"
        ? "text-on-ink-neg-2"
        : state === "merge"
          ? "text-on-ink-2"
          : "text-on-ink-pos";
  return (
    <div
      style={vars}
      className="relative h-11 w-[var(--mw)] md:absolute md:inset-x-0 md:top-[var(--top)] md:h-[60px] md:w-auto"
    >
      <button
        type="button"
        disabled={tracing}
        aria-label={tracing ? name : t("trace.bandAria", { name })}
        aria-pressed={tracing ? undefined : pressed}
        onClick={onClick}
        style={{ clipPath: "polygon(0 0, 100% 0, 95% 100%, 5% 100%)" }}
        className={`absolute inset-0 flex items-center justify-center border-0 p-0 text-sm font-extrabold whitespace-nowrap text-white transition-[background-color,transform,filter] duration-300 md:left-1/2 md:right-auto md:w-[var(--w)] md:-translate-x-1/2 ${bg} ${
          tracing ? "cursor-default" : "cursor-pointer hover:brightness-110"
        } ${state === "active" || pressed ? "md:scale-x-[1.04] md:scale-y-[1.04]" : ""} ${
          state === "active" ? "motion-safe:animate-[sr-glow_1s_ease-in-out_infinite]" : ""
        } ${pressed ? "outline outline-[3px] -outline-offset-[3px] outline-white" : ""} disabled:opacity-100`}
      >
        {state === "total" ? <span className="max-md:hidden">{countText ?? t("na")}</span> : null}
      </button>
      <span
        className={`pointer-events-none absolute left-[22px] top-1/2 -translate-y-1/2 text-[13px] font-extrabold whitespace-nowrap md:left-auto md:right-[var(--side)] md:text-right md:text-sm ${labelTone}`}
      >
        {t("trace.band", { n: i + 1, name })}
      </span>
      <span
        className={`pointer-events-none absolute right-[22px] top-1/2 max-w-[52%] -translate-y-1/2 truncate text-right text-[13px] font-semibold md:hidden ${
          state === "total" ? "text-on-ink-pos" : noteTone
        }`}
      >
        {mobileText ?? t("na")}
      </span>
      {showNote ? (
        <span
          className={`pointer-events-none absolute right-0 top-3 left-[var(--side)] text-[13px] leading-[1.35] font-bold max-md:hidden motion-safe:animate-[sr-slide_.4s_ease-out] ${noteTone}`}
        >
          {noteText ?? t("na")}
        </span>
      ) : null}
    </div>
  );
}

function Token({
  view,
  pos,
  step,
  finished,
}: {
  view: TraceView;
  pos: number;
  step: number;
  finished: boolean;
}) {
  const t = useTranslations("signalAnalysis.research");
  const dropped = finished && view.end === "drop";
  const traded = finished && view.end === "traded";
  const merged = finished && view.end === "merge";
  const top = pos === 0 ? -48 : TOP + (pos - 1) * ROW + 12;
  const text = dropped
    ? t("trace.token.out", { assets: view.assets })
    : traded
      ? t("trace.token.traded", { assets: view.assets })
      : merged
        ? t("trace.token.merged", { assets: view.assets })
        : view.assets;
  const style: CSSProperties = {
    top: `${String(dropped ? top + 30 : top)}px`,
    left: dropped ? "calc(50% + 46px)" : "50%",
    transform: `translateX(-50%)${dropped ? " rotate(-4deg)" : ""}`,
    opacity: step === 0 ? 0 : 1,
  };
  const tone = dropped
    ? "border-on-ink-neg bg-neg text-white"
    : traded
      ? "border-on-ink-pos bg-pos-dot text-white"
      : merged
        ? "border-on-ink-2 bg-ink-2 text-white"
        : "border-on-ink-accent bg-surface text-ink";
  return (
    <div
      aria-hidden="true"
      style={style}
      className={`absolute z-[2] max-w-[220px] truncate rounded-full border-2 px-3.5 py-2 text-[13px] font-extrabold whitespace-nowrap shadow-float transition-[top,left,transform,background-color,border-color,color,opacity] duration-700 ease-[cubic-bezier(.65,0,.35,1)] max-md:hidden ${tone}`}
    >
      {text}
    </div>
  );
}

/* ---------------------------------------------------------------- Step cards */

function Steps({ steps, states }: { steps: StepView[]; states: BandState[] }) {
  const t = useTranslations("signalAnalysis.research");
  const visible = steps
    .map((s, i) => ({ s, i, state: states[i] }))
    .filter((x) => x.state === "pass" || x.state === "drop" || x.state === "merge");
  if (visible.length === 0) return null;
  return (
    <ol aria-label={t("trace.steps")} className="m-0 flex list-none flex-col gap-2 p-0 md:gap-2.5">
      {visible.map(({ s, i, state }) => {
        const drop = state === "drop";
        const merge = state === "merge";
        return (
          <li
            key={s.key}
            className={`rounded-tile border bg-surface p-3 shadow-card motion-safe:animate-[sr-reveal_.45s_cubic-bezier(.2,.8,.2,1)_both] md:rounded-[14px] md:px-4 md:py-3.5 ${
              drop ? "border-neg-border" : "border-border"
            }`}
          >
            <div className="flex items-center gap-2 md:gap-2.5">
              <span
                aria-hidden="true"
                className={`inline-flex size-6 flex-none items-center justify-center rounded-full text-xs font-extrabold text-white md:size-7 md:text-[13px] ${
                  drop ? "bg-neg" : (BLUES[i] ?? BLUES[0])
                }`}
              >
                {i + 1}
              </span>
              <h4 className="m-0 flex-1 text-sm font-extrabold md:text-[15px]">
                <span className="sr-only">{i + 1}. </span>
                {t(`trace.stages.${s.key}`)}
              </h4>
              <span
                className={`flex-none rounded-full px-2 py-[3px] text-xs font-extrabold md:px-2.5 ${
                  drop
                    ? "bg-neg-bg text-neg-ink"
                    : merge
                      ? "bg-bg text-ink-2"
                      : "bg-pos-bg text-pos"
                }`}
              >
                {t(`trace.status.${drop ? "drop" : merge ? "merge" : "pass"}`)}
              </span>
            </div>
            {s.summary === "" ? null : (
              <p className="m-0 mt-2 text-[13px] text-ink-2 md:ml-[38px]">{s.summary}</p>
            )}
            {s.rows.length === 0 ? null : (
              <dl className="m-0 mt-2 flex flex-col gap-1 text-[13px] md:ml-[38px] md:gap-[5px]">
                {s.rows.map((r) => (
                  <div
                    key={r.label}
                    className="flex justify-between gap-3 md:grid md:grid-cols-[minmax(0,170px)_minmax(0,1fr)] md:gap-3.5"
                  >
                    <dt className="text-muted">{r.label}</dt>
                    <dd className="m-0 text-right font-bold text-ink md:text-left">
                      {r.value ?? <Na />}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ---------------------------------------------------------------- Totals panel */

function TotalsPanel({
  funnel: f,
  range,
  reasons,
  reason,
  onReason,
}: {
  funnel: ResearchFunnel | null;
  range: ResearchRange;
  reasons: { reason: ResearchDropReason; n: number }[];
  reason: ResearchDropReason | null;
  onReason: (r: ResearchDropReason) => void;
}) {
  const t = useTranslations("signalAnalysis.research");
  const card = "rounded-[14px] border border-border px-4 py-3.5";
  const cost = f?.claudeCostPerDay ?? null;
  const median = f?.delayMedianSecs ?? null;
  const read = f?.articlesRead ?? null;
  return (
    <div className="flex flex-wrap gap-3">
      <div className={`flex-[1_1_180px] ${card}`}>
        <div className="text-xs text-muted">{t("trace.delay")}</div>
        <div className="text-[22px] font-extrabold">
          {median === null ? <Na /> : delayLong(median)}
        </div>
        {f === null ? null : <Sub>{t("trace.delaySub", { every: delay(f.pollSecs) })}</Sub>}
      </div>
      <div className={`flex-[1_1_180px] ${card}`}>
        <div className="text-xs text-muted">{t("trace.cost")}</div>
        <div className="text-[22px] font-extrabold">
          {cost === null ? (
            <Na />
          ) : (
            t(range === "1d" ? "trace.costToday" : "trace.costPerDay", {
              usd: Number(cost).toFixed(2),
            })
          )}
        </div>
        <Sub>
          {f === null || read === null ? (
            <Na />
          ) : f.soso === null ? (
            t("trace.costSubNoSoso", { articles: read })
          ) : (
            t("trace.costSub", {
              articles: read,
              used: count(f.soso.used),
              limit: count(f.soso.limit),
            })
          )}
        </Sub>
      </div>
      <div className={`flex flex-[2_1_320px] flex-col gap-2 ${card}`}>
        <h3 className="m-0 text-[13px] font-extrabold">{t("trace.drops")}</h3>
        {f === null ? (
          <Na />
        ) : reasons.length === 0 ? (
          <span className="text-[13px] text-muted">{t("trace.dropsNone")}</span>
        ) : (
          <div role="group" aria-label={t("trace.drops")} className="flex flex-wrap gap-1.5">
            {reasons.map((r) => (
              <button
                key={r.reason}
                type="button"
                aria-pressed={reason === r.reason}
                onClick={() => {
                  onReason(r.reason);
                }}
                className={toggle(reason === r.reason)}
              >
                {t("trace.reasonChip", {
                  label: t(`trace.reasonLabels.${r.reason}`),
                  n: count(r.n),
                })}
              </button>
            ))}
          </div>
        )}
        <span className="text-xs text-muted">{t("trace.dropsHint")}</span>
      </div>
    </div>
  );
}
