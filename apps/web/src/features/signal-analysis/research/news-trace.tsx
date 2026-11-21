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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ApiError } from "@/lib/api";
import { useMarketNames } from "@/lib/markets";

import type { PageCtx } from "../components/signal-analysis-page";
import { clock, count, monthDay } from "../format";

import { useResearchArticles, useResearchTrace, type ArticleFilters } from "./api";
import {
  ACCENT_SOFT,
  ContextCard,
  ContextIcons,
  ContextPanel,
  type ContextPanelState,
} from "./context-panel";
import { contextYesCount } from "./context-text";
import { delay } from "./format";
import { DOT, FunnelBands, type BandState, type FunnelBandView, type FunnelToken } from "./funnel";
import { LabelForm } from "./labels";
import { LatencyCard, LatencyTimeline } from "./latency";
import {
  LIVE_HOLD_MS,
  liveDuration,
  useDocumentVisible,
  useInView,
  useLiveArticles,
  useLiveSwitch,
} from "./live-drop";
import { MarketAtDecision } from "./market-state";
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
import { useCanOpenTraders } from "./wallet-links";

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
  /**
   * #358: tầng 4 · Context, số tín hiệu có H1 / H2 / H3 = yes (đã định dạng); null khi API chưa có snapshot live trong
   * khoảng ("records only").
   */
  context: { h1: string; h2: string; h3: string } | null;
  /** Câu ngắn của số trong tầng khi tầng hẹp (null = dùng câu thường). */
  countsShort: (string | null)[];
  /** Tầng Decide: số Long / Short (đã định dạng), để mỗi cặp nhãn–số không ngắt dòng. */
  decide: { long: string; short: string } | null;
}

function totals(f: ResearchFunnel | null, t: Tr): Totals {
  if (f === null)
    return {
      counts: STAGES.map(() => null),
      notes: STAGES.map(() => null),
      reasons: [],
      context: null,
      countsShort: STAGES.map(() => null),
      decide: null,
    };
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
      t.markup("trace.counts.decide", { long: count(f.long), short: count(f.short), p: (x) => x }),
    ],
    decide: { long: count(f.long), short: count(f.short) },
    countsShort: [
      t("trace.countsShort.collect", { n: count(steps[0]?.in ?? 0) }),
      t("trace.countsShort.normalize", { n: count(passed(1)) }),
      null,
      null,
      null,
    ],
    notes: [
      t("trace.notes.collect"),
      noteAt(1),
      noteAt(2),
      noteAt(3),
      t("trace.notes.decide", { size: count(Number(f.sizeUsdc)) }),
    ],
    reasons,
    context:
      f.context === null
        ? null
        : {
            h1: count(f.context.h1Yes),
            h2: count(f.context.h2Yes),
            h3: count(f.context.h3Yes),
          },
  };
}

/* ---------------------------------------------------------------- Bands */

/** Một cặp nhãn–số trong tầng: không ngắt dòng giữa nhãn và số. */
const pair = (chunk: ReactNode) => (
  <span data-pair="" className="whitespace-nowrap">
    {chunk}
  </span>
);

/**
 * Tầng ở chế độ tổng: số bài trong tầng, chú thích (rê chuột), bấm để lọc feed. Tầng Context: số tín hiệu có H1 / H2 / H3
 * = yes (#358), chưa có thì "records only".
 */
function totalBands(
  tot: Totals,
  t: Tr,
  stage: string | null,
  onBand: (i: number) => void,
  bump = false,
): FunnelBandView[] {
  return BANDS.map((key, n) => {
    const label = t("trace.band", { n: n + 1, name: t(`trace.stages.${key}`) });
    if (key === "context") {
      const c = tot.context;
      if (c === null)
        return { key, label, note: t("context.recordsOnly"), state: "total" as const };
      // #345: không ngắt dòng giữa nhãn và số (mỗi cặp nowrap); tầng hẹp dùng câu ngắn (FunnelBands, SHORT_AT).
      return {
        key,
        label,
        note: null,
        noteNode: t.rich("context.funnelCounts", { ...c, p: pair }),
        noteShort: t.rich("context.funnelCountsShort", { ...c, p: pair }),
        title: t.markup("context.funnelCounts", { ...c, p: (x) => x }),
        state: "total" as const,
      };
    }
    const i = STAGES.indexOf(key);
    const name = t(`trace.stages.${key}`);
    return {
      key,
      label,
      note: tot.counts[i] ?? t("na"),
      noteShort: tot.countsShort[i] ?? undefined,
      // Decide: "Long N" / "Short N" không bao giờ tách nhãn khỏi số.
      ...(key === "decide" && tot.decide !== null
        ? {
            noteNode: t.rich("trace.counts.decide", { ...tot.decide, p: pair }),
            // Câu ngắn "L 1 · S 0" luôn trên một dòng (tầng hẹp).
            noteShort: (
              <span data-nowrap="" className="whitespace-nowrap">
                {t.rich("trace.countsShort.decide", { ...tot.decide, p: pair })}
              </span>
            ),
          }
        : {}),
      state: "total" as const,
      title: tot.notes[i] ?? undefined,
      onClick: () => {
        onBand(i);
      },
      pressed: stage === key,
      ariaLabel: t("trace.bandAria", { name }),
      bump,
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
    // Chỉ kết quả gọn: tầng xám + chip "Out · …" đỗ cạnh tầng đã nói bài bị loại (bỏ tiền tố "Dropped ·" để vừa 2 dòng
    // khi khung Context nằm cạnh phễu từ 1280 px); tầng gộp đã ghi "Merged".
    const note = b.state === "drop" || b.state === "merge" || b.state === "pass" ? short : null;
    return { key: b.key, label, state: b.state, note: note === "" ? null : note };
  });
}

/** Chip chạy trong phễu (trace và bài mới live). */
function tokenOf(view: TraceView, step: number, stop: number, t: Tr): FunnelToken {
  const end = step > stop ? view.end : null;
  return {
    pos: Math.min(step, stop),
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

/** Khung 4 · Context theo vị trí chip. */
function panelStateOf(model: TraceModel | null, pos: number): ContextPanelState {
  if (model === null) return "waiting";
  if (model.reach !== "recorded") return model.reach;
  return pos >= CONTEXT_BAND ? "shown" : "waiting";
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
  cycleMinutes = null,
}: {
  ctx: PageCtx;
  funnel: ResearchFunnel | null;
  /** #394: chu kỳ hỏi SoSoValue (phút) từ API tổng kết; null = không biết. */
  cycleMinutes?: number | null;
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

  // #345: bài mới live. Chỉ hỏi khi Live bật, tab hiển thị và không trace; phễu ngoài màn hình thì chỉ cập nhật số.
  const { on: live, known: liveKnown, set: setLive } = useLiveSwitch();
  const visible = useDocumentVisible();
  const funnelRef = useRef<HTMLDivElement>(null);
  const inView = useInView(funnelRef);
  const feed = useLiveArticles({
    live: live && liveKnown,
    tracing: sel !== null,
    visible,
    inView,
    versionId,
  });
  const liveId = sel === null ? (feed.current?.id ?? null) : null;
  const liveTrace = useResearchTrace(liveId, versionId);
  const liveData = (liveTrace.data?.article.id === liveId ? liveTrace.data : undefined) ?? null;
  const liveView: TraceView | null =
    liveData === null
      ? null
      : traceView(liveData, ctx.tz, t, (m) => names.info(m)?.tickSize ?? null);
  const liveModel =
    liveView === null || liveData === null ? null : traceModel(liveView, liveData.context);
  const liveRecorded = liveModel?.reach === "recorded";
  const liveDur = useMemo(() => liveDuration(liveRecorded), [liveRecorded]);
  const livePlayer = useStepPlayer({
    ready: liveView !== null,
    stop: liveModel?.stop ?? BAND_COUNT,
    duration: liveDur,
  });
  const [playedId, setPlayedId] = useState<string | null>(null);
  const { play: livePlay } = livePlayer;
  useEffect(() => {
    if (liveId === null) return;
    setPlayedId(liveId);
    livePlay();
  }, [liveId, livePlay]);
  const liveOn = liveId !== null && playedId === liveId && liveModel !== null && liveView !== null;
  const liveDone = liveOn && livePlayer.step > liveModel.stop;
  const { finish } = feed;
  useEffect(() => {
    if (!liveDone) return;
    // Reduced motion: khung cuối hiện ngay, giữ đủ nhịp một bài (~2.5 s) rồi sang bài sau.
    const id = setTimeout(finish, prefersReducedMotion() ? 2500 : LIVE_HOLD_MS);
    return () => {
      clearTimeout(id);
    };
  }, [liveDone, finish]);
  // Không tải được trace của bài mới: bỏ qua bài đó (số đếm vẫn làm mới).
  const liveError = liveId !== null && liveTrace.isError;
  useEffect(() => {
    if (liveError) finish();
  }, [liveError, finish]);

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
  if (!tracing && liveOn) verdict = liveVerdict(liveView, liveModel, livePlayer.step, feed, t);
  else if (!tracing) verdict = t("trace.verdict.idle");
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

  const bump = feed.fresh.size > 0;
  const bands = tracing
    ? traceBandViews(tb, model, t)
    : liveOn
      ? // #345: bài mới live rơi xuống: tầng như trace (khung Context cạnh phễu làm phễu hẹp lại, số đếm dài không vừa);
        // số đếm của chế độ tổng làm mới từ API khi bài rơi xong.
        traceBandViews(traceBands(liveView, liveModel, livePlayer.step), liveModel, t)
      : totalBands(tot, t, stage, onBand, bump);
  let token: FunnelToken | null = null;
  if (tracing && view !== null) token = tokenOf(view, step, stop, t);
  else if (liveOn) token = { ...tokenOf(liveView, livePlayer.step, liveModel.stop, t), fast: true };

  const panelState = panelStateOf(model, pos);
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
          <div className="flex flex-wrap items-center gap-3">
            <LiveSwitch on={live} onChange={setLive} />
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
              fresh={feed.fresh}
              pending={tracing ? feed.queue.length : 0}
              onPlayPending={back}
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
          ref={funnelRef}
          className="flex min-w-0 scroll-mt-4 flex-col gap-3 max-md:order-1 md:col-span-2 xl:flex-row xl:items-stretch"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-[14px] border border-border bg-surface-2 px-3 py-3.5 md:px-4">
            <div className="flex flex-1 flex-col justify-center">
              <FunnelBands bands={bands} tracing={tracing || liveOn} token={token} />
            </div>
            <p
              role="status"
              className={`m-0 mt-1.5 text-center text-xs font-extrabold md:text-[13px] ${verdictTone}`}
            >
              {verdict}
            </p>
            {/* #345: tóm tắt đợt bài mới gần nhất (chỉ signal rơi; bài bị loại trước Score chỉ vào số đếm). */}
            {tracing || feed.batch === null ? null : (
              <p
                aria-live="polite"
                data-testid="sr-live-batch"
                className="m-0 text-center text-xs font-bold text-ink-2"
              >
                {t("live.batch", {
                  n: feed.batch.n,
                  s: feed.batch.signals,
                  d: feed.batch.dropped,
                })}
              </p>
            )}
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
              className="xl:w-[240px] xl:flex-none min-[1400px]:w-[300px]"
            />
          ) : liveOn ? (
            <ContextPanel
              state={panelStateOf(liveModel, Math.min(livePlayer.step, liveModel.stop))}
              context={liveData?.context ?? null}
              asset={liveData?.article.asset ?? liveData?.context?.market ?? liveView.assets}
              tz={ctx.tz}
              playKey={`live:${liveId}:${String(livePlayer.run)}`}
              className="xl:w-[240px] xl:flex-none min-[1400px]:w-[300px]"
            />
          ) : (
            // #343: khung 4 · Context luôn hiện (cạnh phễu từ 1280 px), chế độ tổng chạy hoạt cảnh chờ.
            <ContextPanel
              state="idle"
              context={null}
              asset=""
              tz={ctx.tz}
              playKey="idle"
              className="xl:w-[240px] xl:flex-none min-[1400px]:w-[300px]"
            />
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
          collectExtra={
            data === null ? null : (
              <LatencyTimeline
                article={data.article}
                latency={data.latency}
                cycleMinutes={cycleMinutes}
                tz={ctx.tz}
              />
            )
          }
        />
      ) : (
        <>
          <TotalsPanel
            funnel={funnel}
            cycleMinutes={cycleMinutes}
            versionId={versionId}
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

/** #345: công tắc "Live" (nhớ theo người xem). Tắt: không hỏi bài mới, không có hiệu ứng rơi. */
function LiveSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const t = useTranslations("signalAnalysis.research.live");
  return (
    <span className="flex min-h-11 items-center gap-2 text-[13px] font-extrabold">
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${on ? "bg-pos motion-safe:animate-[sr-glow_1.6s_ease-in-out_infinite]" : "bg-muted"}`}
      />
      <span aria-hidden="true">{t("label")}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={t("switchAria")}
        onClick={() => {
          onChange(!on);
        }}
        className={`flex h-[26px] w-11 cursor-pointer rounded-full border-0 p-[3px] ${
          on ? "justify-end bg-accent" : `justify-start ${ACCENT_SOFT}`
        }`}
      >
        <span className="block size-5 rounded-full bg-surface" />
      </button>
    </span>
  );
}

/** Dòng trạng thái khi bài mới live đang rơi (mockup): bước đang ở, rồi bước dừng / Decide, cộng số bài chờ. */
function liveVerdict(
  view: TraceView,
  model: TraceModel,
  step: number,
  q: { queue: readonly unknown[]; extra: number; current: ResearchArticle | null },
  t: Tr,
): string {
  const pos = Math.max(Math.min(step, model.stop), 1);
  const name = (n: number) => t(`trace.stages.${BANDS[n - 1] ?? "collect"}`);
  let head: string;
  if (step <= model.stop) head = t("live.step", { n: pos, name: name(pos) });
  else if (view.end === "traded") {
    const side = q.current?.side ?? null;
    head = t("live.reached", {
      side: side === null ? t("na") : t(`sides.${side}`),
      asset: view.assets,
    });
  } else head = t("live.stopped", { name: name(model.stop) });
  return `${head}${q.queue.length > 0 ? t("live.waiting", { n: q.queue.length }) : ""}${
    q.extra > 0 ? t("live.more", { n: q.extra }) : ""
  }`;
}

/* ---------------------------------------------------------------- News feed */

function Feed({
  ctx,
  filters,
  sel,
  fresh,
  pending,
  onPlayPending,
  onShow,
  onClear,
  onPick,
  versionId,
}: {
  ctx: PageCtx;
  filters: ArticleFilters;
  versionId: string | null;
  sel: string | null;
  /** #345: bài tới live trong phiên (badge "NEW"). */
  fresh: ReadonlySet<string>;
  /** #345: số bài mới chờ trong lúc xem trace (chip "N new articles · play"; 0 = ẩn). */
  pending: number;
  onPlayPending: () => void;
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
      {pending === 0 ? null : (
        <button
          type="button"
          onClick={onPlayPending}
          className="min-h-10 flex-none cursor-pointer rounded-full border border-accent bg-accent-tint px-3 text-[13px] font-extrabold text-accent-ink"
        >
          {t("live.pending", { n: pending })}
        </button>
      )}
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
                  fresh={fresh.has(a.id)}
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
  fresh = false,
  selected,
  onPick,
}: {
  a: ResearchArticle;
  tz: string;
  /** #345: bài tới live: badge "NEW", trượt vào một lần. */
  fresh?: boolean;
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
      } ${fresh ? "motion-safe:animate-[sr-newrow_.6s_cubic-bezier(.2,.8,.2,1)_both]" : ""}`}
    >
      <span className="flex justify-between gap-2 text-xs text-muted">
        <span>
          {t("trace.seen", { time: clock(a.publishedAt, tz, false), d: delay(a.delaySecs) })}
          {fresh ? (
            <span className="ml-2 font-extrabold text-accent-ink">{t("live.new")}</span>
          ) : null}
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
  collectExtra = null,
}: {
  bands: TraceBand[];
  context: ResearchSignalContext | null;
  asset: string;
  tz: string;
  /** Thêm vào cuối thẻ Score (hộp gắn nhãn, #306). */
  scoreExtra?: ReactNode;
  /** #375: dòng thời gian độ trễ ở cuối thẻ Collect. */
  collectExtra?: ReactNode;
}) {
  const t = useTranslations("signalAnalysis.research");
  const canOpenTraders = useCanOpenTraders();
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
              <ContextCard
                context={context}
                asset={asset}
                tz={tz}
                canOpenTraders={canOpenTraders}
              />
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
                    <dd title={r.title} className="m-0 text-right font-bold text-ink">
                      {r.value ?? <Na />}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {s.key === "collect" && collectExtra !== null ? collectExtra : null}
            {/* #376: trạng thái thị trường lúc quyết định (chỉ ghi lại, không đổi quyết định). */}
            {s.key === "decide" && context !== null ? (
              <MarketAtDecision state={context.marketState} market={context.market} />
            ) : null}
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

/**
 * Chi phí Claude để hiện (#343): null ("Not available") khi không có dữ liệu, hoặc mọi bài gọi Claude đều không biết chi
 * phí; không bài nào gọi Claude → "0" (số thật).
 */
export function claudeCostShown(cc: ResearchFunnel["claudeCost"] | null): string | null {
  if (cc === null) return null;
  if (cc.articles > 0 && cc.unknown === cc.articles) return null;
  return cc.usd;
}

function TotalsPanel({
  funnel: f,
  cycleMinutes,
  versionId,
  range,
  reasons,
  reason,
  onReason,
}: {
  funnel: ResearchFunnel | null;
  cycleMinutes: number | null;
  versionId: string | null;
  range: ResearchRange;
  reasons: { reason: ResearchDropReason; n: number }[];
  reason: ResearchDropReason | null;
  onReason: (r: ResearchDropReason) => void;
}) {
  const t = useTranslations("signalAnalysis.research");
  const card = "rounded-[14px] border border-border px-4 py-3.5";
  // #343: chi phí trong đúng cửa sổ của phễu (24 giờ / 7 ngày), cùng tập bài với "articles read". Mọi bài gọi Claude
  // đều không biết chi phí → "Not available"; có bài không biết → cộng bài biết và ghi số bài thiếu.
  const cc = f?.claudeCost ?? null;
  const cost = claudeCostShown(cc);
  const read = f?.articlesRead ?? null;
  return (
    <div className="flex flex-wrap gap-3">
      {/* #375: "Where the time goes" thay ô "Delay, news out → collected" (median từng chặng, chặng chậm nhất). */}
      <LatencyCard
        range={range}
        versionId={versionId}
        cycleMinutes={cycleMinutes}
        className="flex-[2_1_320px]"
      />
      <div className={`flex-[1_1_180px] ${card}`}>
        <div className="text-xs text-muted">{t("trace.cost")}</div>
        <div className="text-[22px] font-extrabold">
          {cost === null ? (
            <Na />
          ) : (
            t("trace.costIn", {
              usd: Number(cost).toFixed(2),
              window: t(`trace.costWindow.${range}`),
            })
          )}
        </div>
        {cc !== null && cost !== null && cc.unknown > 0 ? (
          <Sub>{t("trace.costUnknown", { n: cc.unknown })}</Sub>
        ) : null}
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
