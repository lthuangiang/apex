"use client";

import {
  funnelSteps,
  RESEARCH_ARTICLE_SHOWS,
  RESEARCH_DROP_REASONS,
  RESEARCH_RANGES,
  type ResearchArticle,
  type ResearchArticleTrace,
  type ResearchDropReason,
  type ResearchFunnel,
  type ResearchRange,
  type ResearchSignalContext,
} from "@drift/shared";
import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { ApiError } from "@/lib/api";
import { useMarketNames } from "@/lib/markets";

import type { PageCtx } from "../components/signal-analysis-page";
import { clock, count, monthDay } from "../format";

import { useResearchArticles, useResearchTrace, type ArticleFilters } from "./api";
import { ContextCard, ContextIcons, ContextPanel, type ContextPanelState } from "./context-panel";
import { contextYesCount } from "./context-text";
import { delay, delayLong } from "./format";
import { DOT, FunnelBands, type BandState, type FunnelBandView, type FunnelToken } from "./funnel";
import { LabelForm } from "./labels";
import type { Tr } from "./text";
import {
  BAND_COUNT,
  bandPhase,
  BANDS,
  CONTEXT_BAND,
  CONTEXT_STEP_MS,
  prefersReducedMotion,
  STEP_MS,
  traceModel,
  useStepPlayer,
  type BandKey,
  type TraceModel,
} from "./trace-player";
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

// "From headline to trade" (#292, làm lại ở #343 theo docs/mockups/signal-research/redesign-full-page.html,
// redesign-trace-live.html, redesign-trace-no-signal.html). Phễu sáng 6 tầng (tầng 4 · Context viền đứt, chỉ ghi nhận,
// không chặn), hai chế độ: tổng của 1 ngày / 7 ngày (mặc định), và trace một bài khi chọn bài ở News feed hoặc bấm Trace
// ở bảng Trades: chip chạy xuống từng tầng, khung Context cạnh phễu chạy hiệu ứng H1 / H2 / H3 theo snapshot của bài, thẻ
// từng bước hiện dần. Hẹn giờ nằm ở `useStepPlayer` (trace-player.ts), hiển thị ở FunnelBands / ContextPanel, để bài mới
// live (#345) dùng lại. prefers-reduced-motion: không chạy, hiện ngay kết quả. Mọi số từ API; thiếu thì "Not available",
// không bao giờ 0 (quy tắc 1.8).

export { CONTEXT_STEP_MS, STEP_MS };

type Show = ArticleFilters["show"];

export interface TraceRequest {
  id: string;
  /** Tăng mỗi lần bấm Trace, kể cả cùng bài (chạy lại). */
  seq: number;
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
  el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
}

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

/* ---------------------------------------------------------------- Bands */

/** Tầng ở chế độ tổng: số bài trong tầng, chú thích (rê chuột), bấm để lọc feed. Tầng Context: "records only". */
function totalBands(
  tot: Totals,
  t: Tr,
  stage: string | null,
  onBand: (i: number) => void,
): FunnelBandView[] {
  return BANDS.map((key, n) => {
    const label = t("trace.band", { n: n + 1, name: t(`trace.stages.${key}`) });
    if (key === "context")
      return { key, label, note: t("context.recordsOnly"), state: "total" as const };
    const i = STAGES.indexOf(key);
    const name = t(`trace.stages.${key}`);
    return {
      key,
      label,
      note: tot.counts[i] ?? t("na"),
      state: "total" as const,
      title: tot.notes[i] ?? undefined,
      onClick: () => {
        onBand(i);
      },
      pressed: stage === key,
      ariaLabel: t("trace.bandAria", { name }),
    };
  });
}

interface TraceBand {
  key: BandKey;
  state: BandState;
  /** Bước API của tầng (null với Context). */
  step: StepView | null;
}

/** Trạng thái 6 tầng khi trace. Chưa có dữ liệu: chỉ tầng 1 sáng ("Article arriving…"). */
function traceBands(view: TraceView | null, model: TraceModel | null, step: number): TraceBand[] {
  return BANDS.map((key, i) => {
    const n = i + 1;
    if (view === null || model === null)
      return { key, state: n === 1 && step > 0 ? "active" : "idle", step: null };
    const api = model.apiIndex(n);
    const s = api === null ? null : (view.steps[api] ?? null);
    const phase = bandPhase(n, step, model.stop);
    if (phase !== "done") return { key, state: phase, step: s };
    if (key === "context")
      return { key, state: model.reach === "recorded" ? "pass" : "skip", step: null };
    return {
      key,
      state: s?.status === "drop" ? "drop" : s?.status === "merge" ? "merge" : "pass",
      step: s,
    };
  });
}

function traceBandViews(bands: TraceBand[], model: TraceModel | null, t: Tr): FunnelBandView[] {
  const context = model?.context ?? null;
  return bands.map((b, i) => {
    const label = t("trace.band", { n: i + 1, name: t(`trace.stages.${b.key}`) });
    if (b.key === "context") {
      const lit = context !== null && (b.state === "pass" || b.state === "active");
      return {
        key: b.key,
        label,
        state: b.state,
        note:
          b.state === "pass" && context !== null
            ? t("context.yesOf", { n: contextYesCount(context) })
            : b.state === "skip" && model?.reach === "missing"
              ? t("context.notRecorded")
              : null,
        extra: lit ? <ContextIcons context={context} /> : undefined,
      };
    }
    const short = b.step?.band ?? "";
    const note =
      b.state === "drop"
        ? t("trace.dropNote", { text: short })
        : b.state === "merge"
          ? t("trace.mergeNote", { text: short })
          : b.state === "pass"
            ? short
            : null;
    return { key: b.key, label, state: b.state, note: note === "" ? null : note };
  });
}

/* ---------------------------------------------------------------- Component */

export function NewsTrace({
  ctx,
  funnel,
  range,
  onRange,
  request,
  versionId = null,
  rulesSince = null,
}: {
  ctx: PageCtx;
  funnel: ResearchFunnel | null;
  range: ResearchRange;
  onRange: (r: ResearchRange) => void;
  request: TraceRequest | null;
  /** #321: quy tắc hiện tại chạy chưa hết khoảng đã chọn → ghi rõ phễu chỉ đếm từ lúc đó. */
  rulesSince?: { v: number; at: string; sameDay: boolean } | null;
  /** #306: News bot version (bước Filter / Decide, story và lệnh của version); null = Baseline. */
  versionId?: string | null;
}) {
  const t = useTranslations("signalAnalysis.research");
  const ts = useTranslations("signalAnalysis.states");
  const [show, setShow] = useState<Show>("all");
  const [stage, setStage] = useState<(typeof STAGES)[number] | null>(null);
  const [reason, setReason] = useState<ResearchDropReason | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  const trace = useResearchTrace(sel, versionId);
  const names = useMarketNames();
  const data = (trace.data?.article.id === sel ? trace.data : undefined) ?? null;
  const view: TraceView | null =
    data === null ? null : traceView(data, ctx.tz, t, (m) => names.info(m)?.tickSize ?? null);
  const model = view === null || data === null ? null : traceModel(view, data.context);
  const stop = model?.stop ?? BAND_COUNT;
  const recorded = model?.reach === "recorded";
  // Bước 4 giữ lâu hơn chỉ khi có hiệu ứng để xem.
  const duration = useCallback(
    (n: number) => (n === CONTEXT_BAND && recorded ? CONTEXT_STEP_MS : STEP_MS),
    [recorded],
  );
  const player = useStepPlayer({ ready: sel !== null && view !== null, stop, duration });
  const { step, run } = player;

  const start = (id: string, scroll: "funnel" | "trace") => {
    setSel(id);
    player.play();
    if (scroll === "funnel") scrollToId("sr-funnel", false);
    else scrollToId("sr-trace", true);
  };
  const back = () => {
    setSel(null);
    player.reset();
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
  const tb = traceBands(view, model, step);

  let verdict: string;
  let verdictTone = "text-ink-2";
  if (!tracing) verdict = t("trace.verdict.idle");
  else if (view === null)
    verdict = trace.isError ? t("trace.verdict.error") : t("trace.verdict.arriving");
  else if (!finished)
    verdict =
      pos === 0
        ? t("trace.verdict.arriving")
        : t("trace.verdict.step", {
            n: pos,
            name: t(`trace.stages.${BANDS[pos - 1] ?? "collect"}`),
          });
  else {
    verdict = `${view.verdict}${t("trades.sep")}${view.cost}`;
    if (view.end === "traded") verdictTone = "text-pos";
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

  const bands = tracing ? traceBandViews(tb, model, t) : totalBands(tot, t, stage, onBand);
  let token: FunnelToken | null = null;
  if (tracing && view !== null) {
    const end = finished ? view.end : null;
    token = {
      pos,
      visible: step > 0,
      tone:
        end === "drop"
          ? "dropped"
          : end === "traded"
            ? "traded"
            : end === "merge"
              ? "merged"
              : "moving",
      text:
        end === "drop"
          ? t("trace.token.out", { assets: view.assets })
          : end === "traded"
            ? t("trace.token.traded", { assets: view.assets })
            : end === "merge"
              ? t("trace.token.merged", { assets: view.assets })
              : view.assets,
    };
  }

  const panelState: ContextPanelState =
    model === null
      ? "waiting"
      : model.reach === "recorded"
        ? pos >= CONTEXT_BAND
          ? "shown"
          : "waiting"
        : model.reach;
  const asset = data?.article.asset ?? data?.context?.market ?? view?.assets ?? "";

  return (
    <section
      id="sr-funnel"
      aria-labelledby="sr-fn-title"
      className="flex min-w-0 scroll-mt-4 flex-col gap-3 rounded-card bg-surface p-4 shadow-card md:gap-3.5 md:px-6 md:py-5"
    >
      <div className="flex flex-col items-start gap-3 md:flex-row md:flex-wrap md:items-center md:justify-between">
        {/* #342: "From headline to trade" + phụ đề; khoảng thời gian nằm ở nhóm nút 1 day / 7 days bên cạnh. */}
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="sr-fn-title" className="m-0 text-[17px] font-extrabold md:text-xl">
            {t("trace.title")}
          </h2>
          <p className="m-0 text-xs text-muted md:text-[13px]">
            <span className="md:hidden">{t("trace.subShort")}</span>
            <span className="max-md:hidden">{t("trace.sub")}</span>
          </p>
          {rulesSince === null ? null : (
            <p className="m-0 text-xs font-bold text-ink-2">
              {rulesSince.sameDay
                ? t("trace.rulesSince", {
                    v: rulesSince.v,
                    time: clock(rulesSince.at, ctx.tz, false),
                  })
                : t("trace.rulesSinceDay", {
                    v: rulesSince.v,
                    day: monthDay(rulesSince.at, ctx.tz),
                    time: clock(rulesSince.at, ctx.tz, false),
                  })}
            </p>
          )}
        </div>
        {tracing ? (
          <div className="flex flex-none gap-2 max-md:w-full">
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
        ) : (
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
        )}
      </div>

      {tracing ? <TraceHead article={data?.article ?? null} tz={ctx.tz} /> : null}

      {/* Lưới 3 cột: feed rộng bằng ô giải thích đầu; phễu (và khung Context khi trace) chiếm 2 cột. Điện thoại: phễu
          trước, feed sau (mockup 390). */}
      <div className="grid min-w-0 gap-3 md:grid-cols-3">
        <div className="relative min-w-0 max-md:order-2 md:min-h-[300px]">
          <div className="flex min-w-0 flex-col md:absolute md:inset-0">
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
          </div>
        </div>

        <div
          id="sr-trace"
          className="flex min-w-0 scroll-mt-4 flex-col gap-3 max-md:order-1 md:col-span-2 xl:flex-row xl:items-stretch"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-[14px] border border-border bg-surface-2 px-3 py-3.5 md:px-4">
            <div className="flex flex-1 flex-col justify-center">
              <FunnelBands bands={bands} tracing={tracing} token={token} />
            </div>
            <p
              role="status"
              className={`m-0 mt-1.5 text-center text-xs font-extrabold md:text-[13px] ${verdictTone}`}
            >
              {verdict}
            </p>
            {tracing ? null : (
              <p className="m-0 text-center text-xs text-muted">
                {t("trace.unitNote", { range: t(`trace.range.${range}`) })}
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
            <ContextPanel
              state={panelState}
              context={data?.context ?? null}
              asset={asset}
              tz={ctx.tz}
              playKey={`${sel}:${String(run)}`}
              className="xl:w-[300px] xl:flex-none"
            />
          ) : (
            <p className="m-0 text-xs leading-normal text-ink-2 md:hidden">
              {t.rich("context.mobileHint", { b: (c) => <strong>{c}</strong> })}
            </p>
          )}
        </div>
      </div>

      {tracing ? (
        <Steps
          key={`${sel}:${String(run)}`}
          bands={tb}
          context={data?.context ?? null}
          asset={asset}
          tz={ctx.tz}
          scoreExtra={labelBox(data, ctx.tz)}
        />
      ) : (
        <>
          <Explainers />
          <TotalsPanel
            funnel={funnel}
            range={range}
            reasons={tot.reasons}
            reason={reason}
            onReason={onReason}
          />
        </>
      )}
    </section>
  );
}

/** Ba ô giải thích bước 4 dưới phễu (chế độ tổng, từ 768 px; điện thoại có một dòng ngắn dưới phễu). */
function Explainers() {
  const t = useTranslations("signalAnalysis.research.page.drawer");
  const b = (c: ReactNode) => <strong className="text-ink">{c}</strong>;
  return (
    <div className="grid gap-3 max-md:hidden md:grid-cols-3">
      {(["context1", "context2", "context3"] as const).map((k) => (
        <p
          key={k}
          className="m-0 rounded-tile border border-border px-3.5 py-3 text-[13px] leading-normal text-ink-2"
        >
          {t.rich(k, { b })}
        </p>
      ))}
    </div>
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
          n: BANDS.indexOf(stage) + 1,
          name: t(`trace.stages.${stage}`),
        })
      : reason !== null
        ? t("trace.reasonFilter", { label: t(`trace.reasonLabels.${reason}`) })
        : null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
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
        // #297 / #343: desktop cao bằng khối phễu (ô lưới), cuộn trong khung; "Load more" ở cuối khung, 20 bài mỗi trang.
        <div
          data-testid="sr-feed-scroll"
          className="-mx-1 flex max-h-[420px] flex-col gap-2 overflow-y-auto overscroll-contain px-1 py-0.5 md:max-h-none md:min-h-0 md:flex-1"
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

/* ---------------------------------------------------------------- Step cards */

/** #306: hộp gắn nhãn trên thẻ Score khi bài gắn nhãn được (trace không ẩn kết quả lệnh, DEC-333). */
function labelBox(data: ResearchArticleTrace | null, tz: string): ReactNode {
  const score = data?.steps.find((x) => x.key === "score");
  if (data === null || score?.key !== "score" || score.detail?.labelable !== true) return null;
  return (
    <LabelForm
      key={`${data.article.id}:${score.detail.label?.updatedAt ?? ""}`}
      articleId={data.article.id}
      initial={score.detail.label}
      hidden={false}
      tz={tz}
    />
  );
}

function Steps({
  bands,
  context,
  asset,
  tz,
  scoreExtra = null,
}: {
  bands: TraceBand[];
  context: ResearchSignalContext | null;
  asset: string;
  tz: string;
  /** Thêm vào cuối thẻ Score (hộp gắn nhãn, #306). */
  scoreExtra?: ReactNode;
}) {
  const t = useTranslations("signalAnalysis.research");
  const visible = bands
    .map((b, i) => ({ b, n: i + 1 }))
    .filter(
      ({ b }) =>
        (b.state === "pass" || b.state === "drop" || b.state === "merge") &&
        (b.key !== "context" || context !== null),
    );
  if (visible.length === 0) return null;
  return (
    <ol
      aria-label={t("trace.steps")}
      className="m-0 grid list-none grid-cols-1 items-start gap-2 p-0 md:grid-cols-3 md:gap-2.5"
    >
      {visible.map(({ b, n }) => {
        if (b.key === "context" && context !== null)
          return (
            <li
              key={b.key}
              className="rounded-tile border-2 border-accent bg-surface p-3 motion-safe:animate-[sr-reveal_.45s_cubic-bezier(.2,.8,.2,1)_both] md:col-span-3 md:rounded-[14px] md:p-4"
            >
              <ContextCard context={context} asset={asset} tz={tz} />
            </li>
          );
        const s = b.step;
        if (s === null) return null;
        const drop = b.state === "drop";
        const merge = b.state === "merge";
        return (
          <li
            key={b.key}
            className="rounded-tile border border-border bg-surface p-3 motion-safe:animate-[sr-reveal_.45s_cubic-bezier(.2,.8,.2,1)_both] md:px-3.5"
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`inline-flex size-6 flex-none items-center justify-center rounded-full text-xs font-extrabold ${
                  drop || merge ? "bg-bg text-ink-2" : DOT[b.key]
                }`}
              >
                {n}
              </span>
              <h4 className="m-0 flex-1 text-sm font-extrabold">
                <span className="sr-only">{n}. </span>
                {t(`trace.stages.${s.key}`)}
              </h4>
              <span
                className={`flex-none rounded-full px-2 py-0.5 text-[11px] font-extrabold ${
                  drop || merge ? "bg-bg text-ink-2" : "bg-pos-bg text-pos"
                }`}
              >
                {t(`trace.status.${drop ? "drop" : merge ? "merge" : "pass"}`)}
              </span>
            </div>
            {s.summary === "" ? null : (
              <p className="m-0 mt-1.5 text-xs leading-normal text-ink-2">{s.summary}</p>
            )}
            {s.rows.length === 0 ? null : (
              <dl className="m-0 mt-2 flex flex-col gap-1 text-xs">
                {s.rows.map((r) => (
                  <div key={r.label} className="flex justify-between gap-3">
                    <dt className="text-muted">{r.label}</dt>
                    <dd className="m-0 text-right font-bold text-ink">{r.value ?? <Na />}</dd>
                  </div>
                ))}
              </dl>
            )}
            {s.key === "score" && scoreExtra !== null ? (
              <div className="mt-3">{scoreExtra}</div>
            ) : null}
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
