"use client";

import type { ResearchSignalContext } from "@drift/shared";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type { TraceView } from "./trace-text";

// Bộ điều khiển hiệu ứng của phễu 6 bước (#343), tách khỏi phần hiển thị để bài mới live (#345) dùng lại: hook chỉ giữ
// "đang ở bước nào" và hẹn giờ; component (FunnelBands, ContextPanel) chỉ vẽ theo bước đó. Mọi hàm ở đây không đọc API.
//
// Quy ước bước: 0 = bài đang tới; n (1..6) = chip đang ở tầng n; > `stop` = đã tới kết luận. Reduced motion: nhảy thẳng
// tới kết luận (khung cuối), không hẹn giờ.

/** Thời gian mỗi bước (thiết kế: 950 ms). */
export const STEP_MS = 950;
/** Bước 4 · Context giữ lâu hơn để hiệu ứng H1 / H2 / H3 (≤ 1.2 s) chạy xong (mockup trace-live: 1800 ms). */
export const CONTEXT_STEP_MS = 1800;
/** Số tầng: Collect, Normalize, Score, Context, Filter, Decide. */
export const BAND_COUNT = 6;
/** Tầng Context (đánh số từ 1). */
export const CONTEXT_BAND = 4;
/** Bước "đã xong" (sau tầng cuối). */
export const DONE = BAND_COUNT + 1;

export type BandKey = "collect" | "normalize" | "score" | "context" | "filter" | "decide";
export const BANDS: readonly BandKey[] = [
  "collect",
  "normalize",
  "score",
  "context",
  "filter",
  "decide",
] as const;

/** Thời gian chip đứng ở bước `n` trước khi sang bước sau. */
export const stepDuration = (n: number): number => (n === CONTEXT_BAND ? CONTEXT_STEP_MS : STEP_MS);

/* ---------------------------------------------------------------- Reduced motion */

const QUERY = "(prefers-reduced-motion: reduce)";

function mql(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY)
    : null;
}

/** Đọc một lần (lúc bấm). */
export function prefersReducedMotion(): boolean {
  return mql()?.matches ?? false;
}

function subscribe(cb: () => void): () => void {
  const m = mql();
  if (m === null || typeof m.addEventListener !== "function") return () => undefined;
  m.addEventListener("change", cb);
  return () => {
    m.removeEventListener("change", cb);
  };
}

/** Theo dõi prefers-reduced-motion (SSR: false). */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}

/* ---------------------------------------------------------------- Player */

export interface StepPlayer {
  /** Bước hiện tại (xem quy ước ở đầu file). */
  step: number;
  /** Tăng mỗi lần chạy / chạy lại: dùng làm `key` để hiệu ứng CSS chạy lại (Replay). */
  run: number;
  /** Chạy từ đầu (reduced motion: hiện ngay kết quả). */
  play: () => void;
  /** Về trạng thái nghỉ (đã xong, không hẹn giờ). */
  reset: () => void;
}

/**
 * Hẹn giờ từng bước tới `stop` (tầng cuối bài tới), rồi dừng ở kết luận. `ready` = đã có dữ liệu (chưa có thì đứng ở
 * bước 0 "Article arriving…"). `duration(n)` = thời gian đứng ở bước n.
 */
export function useStepPlayer({
  ready,
  stop,
  duration = stepDuration,
}: {
  ready: boolean;
  stop: number;
  duration?: (n: number) => number;
}): StepPlayer {
  const [step, setStep] = useState(DONE);
  const [run, setRun] = useState(0);
  useEffect(() => {
    if (!ready || step > stop) return;
    const id = setTimeout(() => {
      setStep((s) => s + 1);
    }, duration(step));
    return () => {
      clearTimeout(id);
    };
  }, [ready, step, stop, run, duration]);
  const play = useCallback(() => {
    setRun((r) => r + 1);
    setStep(prefersReducedMotion() ? DONE : 0);
  }, []);
  const reset = useCallback(() => {
    setStep(DONE);
  }, []);
  return { step, run, play, reset };
}

/* ---------------------------------------------------------------- Mô hình 6 tầng từ trace API */

/**
 * - `recorded`: có snapshot (bài qua Score).
 * - `notReached`: bài dừng trước bước 4.
 * - `missing`: bài qua bước 4 nhưng không có snapshot (bài trước khi có bước này).
 */
export type ContextReach = "recorded" | "notReached" | "missing";

export interface TraceModel {
  /** Tầng cuối bài tới (1..6). */
  stop: number;
  context: ResearchSignalContext | null;
  reach: ContextReach;
  /** Tầng hiển thị (1..6) → chỉ số bước API (0..4); Context không có bước API (null). */
  apiIndex: (band: number) => number | null;
}

/**
 * API giữ 5 bước (collect → decide) và trả thẻ Context riêng (#349); phễu mới chèn Context làm tầng 4. Bài dừng ở Score
 * không tới Context, trừ khi đã có snapshot (snapshot chụp ngay sau Score).
 */
export function traceModel(view: TraceView, context: ResearchSignalContext | null): TraceModel {
  const apiStop = view.stop;
  const score = view.steps[2];
  let stop: number;
  if (apiStop >= 4) stop = apiStop + 1;
  else if (apiStop === 3 && context !== null && score?.status === "pass") stop = CONTEXT_BAND;
  else stop = apiStop;
  const reach: ContextReach =
    context !== null ? "recorded" : stop > CONTEXT_BAND ? "missing" : "notReached";
  return {
    stop,
    context,
    reach,
    apiIndex: (band) => (band < CONTEXT_BAND ? band - 1 : band === CONTEXT_BAND ? null : band - 2),
  };
}

export type BandPhase = "idle" | "active" | "done" | "skip";

/** Tầng `band` (1..6) đang ở đâu khi chip ở `step`. */
export function bandPhase(band: number, step: number, stop: number): BandPhase {
  const pos = Math.min(step, stop);
  if (band > stop) return step > stop ? "skip" : "idle";
  if (band < pos) return "done";
  if (band === pos) return step > band ? "done" : "active";
  return "idle";
}
