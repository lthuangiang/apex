"use client";

import {
  CLASSIFIER_GATE,
  GATE_MIN_CLOSED,
  MARKET_STATE_RULES,
  NEWS_CLASSIFIER,
  NEWS_CYCLE_MINUTES,
  NEWS_RULES,
} from "@drift/shared";
import { Button } from "@drift/ui";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { count } from "../format";

import { useResearchClassifiers } from "./api";
import {
  HOLD_MS,
  LIST_KEYS,
  MOVE_MS,
  STAGES,
  STEP_BOX,
  STEP_KEYS,
  VIEW_H,
  VIEW_W,
  ease,
  endOf,
  pointAt,
  stageOfStep,
  wrapStage,
  type EdgeKey,
  type ListKey,
  type NodeKey,
  type Point,
  type StepKey,
} from "./overview-flow";
import { usePrefersReducedMotion } from "./trace-player";
import { classifierShort } from "./version-text";

// Tab Overview của drawer How it works (#391, mockup docs/mockups/signal-research/how-it-works-overview.html): một vòng chạy
// Collect → Decide → Watcher → Results. Mọi con số lấy từ hằng của @drift/shared (NEWS_RULES, NEWS_CLASSIFIER,
// CLASSIFIER_GATE, GATE_MIN_CLOSED, MARKET_STATE_RULES, NEWS_CYCLE_MINUTES); số lần gọi Claude mỗi vòng và ngân sách token
// mỗi ngày chỉnh bằng env nên câu chữ không có số. Drawer (BottomSheet side) xếp khối theo cột và tự cuộn: mọi khối con có
// `shrink-0` để dải tab và sơ đồ không bị ép dẹt (lỗi của mockup v1). Reduced motion: không tự chạy, chấm nhảy thẳng tới
// chặng, nét đứt không chạy.

const b = (c: ReactNode) => <b className="text-ink">{c}</b>;
const m = (c: ReactNode) => <span className="text-muted">{c}</span>;

export function OverviewPanel() {
  const t = useTranslations("signalAnalysis.research.page.drawer.overview");
  const reduce = usePrefersReducedMotion();
  const q = useResearchClassifiers();
  const cur = q.data?.items.find((r) => r.current) ?? null;
  const v = cur === null ? null : classifierShort(cur.classifierVersion);

  const [stage, setStage] = useState(0);
  const [playing, setPlaying] = useState(!reduce);
  const [arrived, setArrived] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<ListKey>>(() => new Set<ListKey>(["score"]));
  // Bấm Play: chấm đã tới nơi, chỉ chờ thời gian đọc rồi sang chặng sau (như mockup).
  const resumed = useRef(false);
  const details = useRef(new Map<ListKey, HTMLDetailsElement>());

  useEffect(() => {
    if (reduce) setPlaying(false);
  }, [reduce]);

  const move = reduce ? 0 : MOVE_MS;
  useEffect(() => {
    if (!playing) return;
    const wait = resumed.current ? HOLD_MS : move + HOLD_MS;
    resumed.current = false;
    const id = setTimeout(() => {
      setArrived(false);
      setStage((s) => wrapStage(s + 1));
    }, wait);
    return () => {
      clearTimeout(id);
    };
  }, [stage, playing, move]);

  const go = (n: number) => {
    setArrived(false);
    setStage(wrapStage(n));
  };
  const toggle = () => {
    if (!playing) resumed.current = true;
    setPlaying(!playing);
  };
  const openStep = (k: StepKey) => {
    setPlaying(false);
    go(stageOfStep(k));
    setOpen((o) => new Set(o).add(k));
    const el = details.current.get(k);
    // jsdom (test) không có scrollIntoView.
    if (el !== undefined && "scrollIntoView" in el)
      el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
  };

  const s = STAGES[stage] ?? STAGES[0];
  if (s === undefined) return null;
  const stepIndex = (k: StepKey) => STEP_KEYS.indexOf(k) + 1;
  const title =
    s.step === null
      ? t(`diagram.${s.key === "watcher" ? "watcher" : "results"}.title`)
      : t("stageTitle", { n: stepIndex(s.step), name: t(`steps.${s.step}.name`) });

  return (
    <>
      <p className="m-0 shrink-0">{t.rich("intro", { min: NEWS_CYCLE_MINUTES, b })}</p>

      <div
        data-testid="hiw-player"
        className="flex shrink-0 flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-tile border border-border bg-surface-2 px-3.5 py-3"
      >
        <div className="flex gap-1.5">
          <Button
            variant="secondary"
            aria-label={t("player.prev")}
            className="min-w-11 px-0"
            onClick={() => {
              go(stage - 1);
            }}
          >
            <span aria-hidden="true">‹</span>
          </Button>
          <Button className="min-w-21" onClick={toggle}>
            {playing ? t("player.pause") : t("player.play")}
          </Button>
          <Button
            variant="secondary"
            aria-label={t("player.next")}
            className="min-w-11 px-0"
            onClick={() => {
              go(stage + 1);
            }}
          >
            <span aria-hidden="true">›</span>
          </Button>
        </div>
        <div aria-live="polite" data-testid="hiw-caption" className="min-w-0 flex-[1_1_260px]">
          <div className="text-xs font-extrabold text-accent-ink">{title}</div>
          <p className="m-0 mt-0.5 min-h-[3em] text-[13px] text-ink-2">
            {t(`stages.${s.key}`, { n: GATE_MIN_CLOSED })}
          </p>
        </div>
        <div aria-hidden="true" className="flex gap-1">
          {STAGES.map((x, j) => (
            <i
              key={x.key}
              className={`h-[5px] w-4 rounded-[3px] ${j === stage ? "bg-accent" : j < stage ? "bg-accent-tint" : "bg-border-input"}`}
            />
          ))}
        </div>
      </div>

      <div
        data-testid="hiw-flow"
        className="shrink-0 overflow-x-auto rounded-tile border border-border px-2 py-3"
      >
        <div className="relative min-w-[560px]">
          <Diagram
            stage={stage}
            move={move}
            arrived={arrived}
            onArrive={() => {
              setArrived(true);
            }}
            reader={v}
          />
          {STEP_KEYS.map((k) => {
            const r = STEP_BOX[k];
            return (
              <button
                key={k}
                type="button"
                data-step={k}
                aria-label={t("diagram.step", { n: stepIndex(k), name: t(`steps.${k}.name`) })}
                aria-controls={`hiw-d-${k}`}
                aria-current={s.step === k ? "step" : undefined}
                onClick={() => {
                  openStep(k);
                }}
                className="absolute cursor-pointer rounded-[10px] border-0 bg-transparent p-0"
                style={{
                  left: `${String((r.x / VIEW_W) * 100)}%`,
                  top: `${String((r.y / VIEW_H) * 100)}%`,
                  width: `${String((r.w / VIEW_W) * 100)}%`,
                  height: `${String((r.h / VIEW_H) * 100)}%`,
                }}
              />
            );
          })}
        </div>
      </div>

      <div className="grid shrink-0 gap-2">
        {LIST_KEYS.map((k, i) => (
          <details
            key={k}
            id={`hiw-d-${k}`}
            ref={(el) => {
              if (el === null) details.current.delete(k);
              else details.current.set(k, el);
            }}
            open={open.has(k)}
            onToggle={(e) => {
              const isOpen = e.currentTarget.open;
              setOpen((o) => {
                if (o.has(k) === isOpen) return o;
                const n = new Set(o);
                if (isOpen) n.add(k);
                else n.delete(k);
                return n;
              });
            }}
            className="group rounded-[12px] border border-border bg-surface open:border-accent"
          >
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-3.5 py-3 [&::-webkit-details-marker]:hidden">
              <span className="w-[22px] font-mono text-xs font-medium text-accent-ink">
                {k === "watch" ? "→" : String(i + 1).padStart(2, "0")}
              </span>
              <span className="font-extrabold text-ink">{t(`steps.${k}.name`)}</span>
              <span className="min-w-0 flex-1 text-[13px] text-muted">{t(`steps.${k}.sub`)}</span>
              <span aria-hidden="true" className="font-extrabold text-muted">
                <span className="group-open:hidden">+</span>
                <span className="hidden group-open:inline">–</span>
              </span>
            </summary>
            <div className="grid gap-2 px-3.5 pb-3.5 text-[13.5px] text-ink-2 sm:pl-12">
              <StepBody k={k} reader={v} />
            </div>
          </details>
        ))}
      </div>

      <p
        data-testid="hiw-never"
        className="m-0 shrink-0 rounded-r-[10px] border-l-[3px] border-warn-border bg-warn-bg px-3.5 py-2.5 text-[13px] text-warn"
      >
        {t.rich("never", { b: (c) => <b className="font-extrabold">{c}</b> })}
      </p>
    </>
  );
}

function StepBody({ k, reader }: { k: ListKey; reader: string | null }) {
  const t = useTranslations("signalAnalysis.research.page.drawer.overview.steps");
  const drops = (c: ReactNode) => <p className="m-0 text-muted">{c}</p>;
  switch (k) {
    case "collect":
      return (
        <>
          <p className="m-0">{t("collect.body", { min: NEWS_CYCLE_MINUTES })}</p>
          {drops(t("collect.drops"))}
        </>
      );
    case "normalize":
      return (
        <>
          <p className="m-0">{t("normalize.body")}</p>
          {drops(t("normalize.drops"))}
        </>
      );
    case "score": {
      const checks = ["stale", "late", "calls", "budget"] as const;
      const gate = { min: CLASSIFIER_GATE.minLabels, pct: CLASSIFIER_GATE.minPrecisionPct };
      return (
        <>
          <div
            data-testid="hiw-when"
            className="grid gap-1.5 rounded-[10px] border border-unknown bg-unknown-bg px-3.5 py-3"
          >
            <div className="text-xs font-extrabold text-unknown">{t("score.whenTitle")}</div>
            <p className="m-0">
              {t("score.whenIntro", { min: NEWS_CYCLE_MINUTES, n: checks.length })}
            </p>
            <ol className="m-0 grid gap-[3px] pl-5">
              {checks.map((c) => (
                <li key={c}>
                  {t.rich(`score.checks.${c}`, {
                    h: NEWS_RULES.maxArticleAgeHours,
                    min: NEWS_RULES.maxSourceDelayMinutes,
                    m,
                  })}
                </li>
              ))}
            </ol>
            <p className="m-0">
              {t("score.whenAfter", { chars: count(NEWS_CLASSIFIER.maxContentChars) })}
            </p>
          </div>
          <p className="m-0">{t.rich("score.claude", { b })}</p>
          <p className="m-0">{t.rich("score.checked", { h: NEWS_RULES.maxEventAgeHours, b })}</p>
          <p className="m-0">{t.rich("score.rules", { b })}</p>
          <p className="m-0" data-testid="hiw-reader">
            {reader === null
              ? t.rich("score.readerNa", { ...gate, b })
              : t.rich("score.reader", { ...gate, v: reader, b })}
          </p>
        </>
      );
    }
    case "context":
      return (
        <p className="m-0">
          {t.rich("context.body", {
            btcH: MARKET_STATE_RULES.btcHours,
            volH: MARKET_STATE_RULES.volHours,
            b,
          })}
        </p>
      );
    case "filter":
      return (
        <>
          <p className="m-0">
            {t("filter.body", {
              days: NEWS_RULES.storyWindowDays,
              x: NEWS_RULES.minTpCostMultiple,
            })}
          </p>
          {drops(t.rich("filter.drops", { b }))}
        </>
      );
    case "decide":
      return <p className="m-0">{t.rich("decide.body", { b })}</p>;
    case "watch":
      return (
        <>
          <p className="m-0">{t("watch.body1")}</p>
          <p className="m-0">{t.rich("watch.body2", { b })}</p>
        </>
      );
  }
}

/* ---------------------------------------------------------------- Diagram */

const EDGES: Readonly<Record<EdgeKey, { d: string; ai?: boolean; dash?: boolean }>> = {
  src: { d: "M154 56 H178" },
  ask: { d: "M420 226 H498", ai: true },
  ans: { d: "M500 254 H422", ai: true },
  ctx: { d: "M154 332 H178" },
  bot: { d: "M500 424 H422", dash: true },
  px: { d: "M154 516 H178" },
  pxw: { d: "M154 626 H178" },
  res: { d: "M420 736 H498", dash: true },
};
const SPINE = [
  "M300 92 V110",
  "M300 184 V202",
  "M300 276 V294",
  "M300 368 V386",
  "M300 460 V478",
  "M300 552 V588",
  "M300 662 V698",
];

function Diagram({
  stage,
  move,
  arrived,
  onArrive,
  reader,
}: {
  stage: number;
  move: number;
  arrived: boolean;
  onArrive: () => void;
  reader: string | null;
}) {
  const t = useTranslations("signalAnalysis.research.page.drawer.overview");
  const id = useId().replace(/:/g, "");
  const s = STAGES[stage] ?? STAGES[0];
  if (s === undefined) return null;
  const arrow = `${id}-a`;
  const arrowAi = `${id}-aa`;
  const on = (k: NodeKey) => s.node === k;
  const box = (k: NodeKey | null) =>
    k !== null && on(k)
      ? "fill-accent-tint stroke-accent stroke-[2.5]"
      : "fill-surface stroke-border-input stroke-[1.5]";
  const src = "fill-accent-tint stroke-accent stroke-[1.5]";
  const muted = "fill-muted";
  const num = (n: number) => String(n).padStart(2, "0");
  const step = (k: StepKey, i: number) => {
    const r = STEP_BOX[k];
    const active = s.step === k;
    return (
      <g key={k}>
        <rect
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          rx={10}
          className={
            active
              ? "fill-accent-tint stroke-accent stroke-[2.5]"
              : "fill-surface stroke-accent stroke-[1.5]"
          }
        />
        <text x={r.x + 14} y={r.y + 22} fontSize={11} className="fill-accent-ink font-mono">
          {num(i + 1)}
        </text>
        <text x={r.x + 38} y={r.y + 23} fontSize={14} fontWeight={800} className="fill-ink">
          {t(`steps.${k}.name`)}
        </text>
        <text x={r.x + 14} y={r.y + 42} fontSize={11.5} className={muted}>
          {t(`diagram.${k}.l1`)}
        </text>
        <text x={r.x + 14} y={r.y + 60} fontSize={10.5} className="fill-pos font-mono">
          {t(`diagram.${k}.table`)}
        </text>
      </g>
    );
  };
  const edge = (k: EdgeKey) => {
    const e = EDGES[k];
    const go = s.edges.includes(k);
    const color = e.ai === true ? "stroke-unknown" : go ? "stroke-accent" : "stroke-muted";
    return (
      <path
        key={k}
        data-edge={k}
        data-go={go || undefined}
        d={e.d}
        fill="none"
        markerEnd={`url(#${e.ai === true ? arrowAi : arrow})`}
        className={`${color} ${go ? "sr-hiw-go stroke-[2.4]" : "stroke-[1.4]"} ${e.dash === true && !go ? "[stroke-dasharray:5_4]" : ""}`}
      />
    );
  };
  return (
    <svg
      viewBox={`0 0 ${String(VIEW_W)} ${String(VIEW_H)}`}
      role="img"
      aria-label={t("diagram.label")}
      className="block h-auto w-full"
    >
      <defs>
        <marker
          id={arrow}
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={7}
          markerHeight={7}
          orient="auto-start-reverse"
        >
          <path d="M0 0L10 5L0 10z" className="fill-muted" />
        </marker>
        <marker
          id={arrowAi}
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={7}
          markerHeight={7}
          orient="auto-start-reverse"
        >
          <path d="M0 0L10 5L0 10z" className="fill-unknown" />
        </marker>
      </defs>

      {/* nguồn (trái) */}
      <rect x={4} y={20} width={150} height={72} rx={10} className={src} />
      <text x={16} y={44} fontSize={13} fontWeight={800} className="fill-ink">
        {t("diagram.soso.title")}
      </text>
      <text x={16} y={62} fontSize={11} className={muted}>
        {t("diagram.soso.l1")}
      </text>
      <text x={16} y={77} fontSize={11} className={muted}>
        {t("diagram.soso.l2", { min: NEWS_CYCLE_MINUTES })}
      </text>
      <rect x={4} y={296} width={150} height={72} rx={10} className={src} />
      <text x={16} y={320} fontSize={13} fontWeight={800} className="fill-ink">
        {t("diagram.market.title")}
      </text>
      <text x={16} y={338} fontSize={11} className={muted}>
        {t("diagram.market.l1")}
      </text>
      <text x={16} y={353} fontSize={11} className={muted}>
        {t("diagram.market.l2")}
      </text>
      <rect x={4} y={480} width={150} height={182} rx={10} className={src} />
      <text x={16} y={504} fontSize={13} fontWeight={800} className="fill-ink">
        {t("diagram.prices.title")}
      </text>
      <text x={16} y={522} fontSize={11} className={muted}>
        {t("diagram.prices.l1")}
      </text>

      {/* trục giữa */}
      {STEP_KEYS.map(step)}
      <rect x={180} y={590} width={240} height={72} rx={10} className={box("watcher")} />
      <text x={194} y={614} fontSize={14} fontWeight={800} className="fill-ink">
        {t("diagram.watcher.title")}
      </text>
      <text x={194} y={634} fontSize={11.5} className={muted}>
        {t("diagram.watcher.l1")}
      </text>
      <text x={194} y={651} fontSize={11.5} className={muted}>
        {t("diagram.watcher.l2")}
      </text>
      <rect x={180} y={700} width={240} height={72} rx={10} className={box("results")} />
      <text x={194} y={724} fontSize={14} fontWeight={800} className="fill-ink">
        {t("diagram.results.title")}
      </text>
      <text x={194} y={744} fontSize={11.5} className={muted}>
        {t("diagram.results.l1")}
      </text>
      <text x={194} y={761} fontSize={11.5} className={muted}>
        {t("diagram.results.l2")}
      </text>

      {/* cột phải */}
      <rect
        x={500}
        y={196}
        width={176}
        height={88}
        rx={10}
        className={`fill-unknown-bg stroke-unknown ${on("reader") ? "stroke-[2.5]" : "stroke-[1.5]"}`}
      />
      <text x={512} y={219} fontSize={13} fontWeight={800} className="fill-ink">
        {reader === null ? t("diagram.reader.titleNa") : t("diagram.reader.title", { v: reader })}
      </text>
      <text x={512} y={238} fontSize={11} className={muted}>
        {t("diagram.reader.l1")}
      </text>
      <text x={512} y={253} fontSize={11} className={muted}>
        {t("diagram.reader.l2", { min: NEWS_RULES.maxSourceDelayMinutes })}
      </text>
      <text x={512} y={270} fontSize={11} className={muted}>
        {t("diagram.reader.l3")}
      </text>
      <rect x={500} y={388} width={176} height={72} rx={10} className={box(null)} />
      <text x={512} y={411} fontSize={13} fontWeight={800} className="fill-ink">
        {t("diagram.versions.title")}
      </text>
      <text x={512} y={430} fontSize={11} className={muted}>
        {t("diagram.versions.l1")}
      </text>
      <text x={512} y={445} fontSize={11} className={muted}>
        {t("diagram.versions.l2")}
      </text>
      <rect x={500} y={700} width={176} height={72} rx={10} className={box(null)} />
      <text x={512} y={723} fontSize={13} fontWeight={800} className="fill-ink">
        {t("diagram.working.title")}
      </text>
      <text x={512} y={742} fontSize={11} className={muted}>
        {t("diagram.working.l1", { n: GATE_MIN_CLOSED })}
      </text>
      <text x={512} y={757} fontSize={11} className={muted}>
        {t("diagram.working.l2")}
      </text>
      <rect
        x={4}
        y={800}
        width={672}
        height={44}
        rx={10}
        className="fill-surface-2 stroke-muted stroke-[1.5] [stroke-dasharray:4_3]"
      />
      <text x={20} y={827} fontSize={12.5} className={muted}>
        {t("diagram.never")}
      </text>

      {/* cạnh */}
      {SPINE.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          markerEnd={`url(#${arrow})`}
          className="stroke-muted stroke-[1.4]"
        />
      ))}
      {(Object.keys(EDGES) as EdgeKey[]).map(edge)}
      <text x={440} y={219} fontSize={10.5} className={muted}>
        {t("diagram.sends")}
      </text>
      <text x={436} y={270} fontSize={10.5} className={muted}>
        {t("diagram.returns")}
      </text>

      {s.drop === null ? null : (
        <text
          data-testid="hiw-drop"
          x={170}
          y={s.drop.y}
          textAnchor="end"
          fontSize={10.5}
          className={`fill-warn font-mono transition-opacity duration-300 ${arrived ? "opacity-100" : "opacity-0"}`}
        >
          {t(`drops.${s.drop.key}`)}
        </text>
      )}
      <Dot key={stage} path={s.path} move={move} onArrive={onArrive} />
    </svg>
  );
}

/** Chấm chạy theo đường của chặng trong `move` ms; move = 0 (reduced motion) thì đứng ngay ở cuối đường. */
function Dot({
  path,
  move,
  onArrive,
}: {
  path: readonly Point[];
  move: number;
  onArrive: () => void;
}) {
  const [pt, setPt] = useState<Point>(() => (move === 0 ? endOf(path) : pointAt(path, 0)));
  const arrive = useRef(onArrive);
  arrive.current = onArrive;
  useEffect(() => {
    if (move === 0 || typeof requestAnimationFrame !== "function") {
      setPt(endOf(path));
      arrive.current();
      return;
    }
    let raf = 0;
    const start = performance.now();
    const frame = (now: number) => {
      const f = Math.min(1, (now - start) / move);
      setPt(pointAt(path, ease(f)));
      if (f >= 1) {
        arrive.current();
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [path, move]);
  return (
    <g data-testid="hiw-dot" data-x={pt.x} data-y={pt.y} className="pointer-events-none">
      <circle cx={pt.x} cy={pt.y} r={13} className="sr-hiw-halo fill-accent" />
      <circle cx={pt.x} cy={pt.y} r={7} className="fill-accent stroke-surface stroke-2" />
    </g>
  );
}
