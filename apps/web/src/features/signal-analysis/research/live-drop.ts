"use client";

import type { ResearchArticle } from "@drift/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";

import { fetchNewArticles, LIVE_REFRESH_KEYS, type VersionId } from "./api";
import { CONTEXT_BAND } from "./trace-player";

// Bài mới live (#345, docs/mockups/signal-research/redesign-live-new-article.html): bài mới tới khi đang ở trang thì rơi
// xuống phễu và chạy qua các bước tới bước nó dừng thật, khung 4 · Context chạy hiệu ứng của bài đó (hẹn giờ ở
// `useStepPlayer`, hiển thị ở FunnelBands / ContextPanel như trace). File này chỉ giữ nguồn bài và hàng đợi:
// - hỏi `GET /articles/new?since=` mỗi 15 s, CHỈ khi công tắc Live bật, tab hiển thị và phễu ở chế độ tổng (không trace);
// - mỗi bài chỉ rơi một lần (bỏ bài đã thấy theo id); hàng đợi tối đa 3 bài, phần còn lại chỉ cộng số ("+N more");
// - lần hỏi đầu sau khi dừng (tab ẩn, đang trace, Live tắt) và lúc phễu ngoài màn hình: chỉ cập nhật số, không rơi;
// - không bao giờ cắt ngang trace người dùng đang xem: bài chờ ở chip "N new articles · play".
// Số đếm và feed luôn lấy lại từ API (làm mới query), không tự cộng.

/** Nhịp hỏi bài mới (PM chốt). */
export const LIVE_POLL_MS = 15_000;
/** Số bài tối đa chờ rơi; thêm nữa thì chỉ đếm. */
export const LIVE_QUEUE_MAX = 3;
/** Mỗi bước của bài rơi (mockup: 380 ms). */
export const LIVE_STEP_MS = 380;
/** Bước 4 khi bài có snapshot: đủ cho hiệu ứng H1 / H2 / H3 (≤ 1.2 s). */
export const LIVE_CONTEXT_MS = 1300;
/** Giữ khung cuối trước khi sang bài sau. */
export const LIVE_HOLD_MS = 900;

/** Thời gian đứng ở bước `n` của bài rơi; bước 4 giữ lâu hơn chỉ khi có hiệu ứng để xem. */
export const liveDuration =
  (recorded: boolean) =>
  (n: number): number =>
    n === CONTEXT_BAND && recorded ? LIVE_CONTEXT_MS : LIVE_STEP_MS;

/* ---------------------------------------------------------------- Hàng đợi (thuần) */

export interface LiveQueue {
  /** Bài đang rơi. */
  current: ResearchArticle | null;
  /** Bài chờ rơi (≤ LIVE_QUEUE_MAX). */
  queue: ResearchArticle[];
  /** Bài tới khi hàng đợi đầy: chỉ đếm ("+N more"). */
  extra: number;
}

export const EMPTY_QUEUE: LiveQueue = { current: null, queue: [], extra: 0 };

/** Thêm bài mới (đã bỏ trùng) vào hàng đợi; quá LIVE_QUEUE_MAX thì cộng `extra`. */
export function enqueue(s: LiveQueue, items: readonly ResearchArticle[]): LiveQueue {
  const all = [...s.queue, ...items];
  return {
    ...s,
    queue: all.slice(0, LIVE_QUEUE_MAX),
    extra: s.extra + Math.max(0, all.length - LIVE_QUEUE_MAX),
  };
}

/** Lấy bài kế tiếp khi rảnh (không trace, không có bài đang rơi). Hết bài thì xoá "+N more". */
export function advance(s: LiveQueue): LiveQueue {
  if (s.current !== null) return s;
  const [next, ...rest] = s.queue;
  if (next === undefined) return s.extra === 0 ? s : { ...s, extra: 0 };
  return { ...s, current: next, queue: rest };
}

/** Người dùng mở trace giữa lúc bài đang rơi: bài đó về đầu hàng đợi (chip "N new articles · play"). */
export function interrupt(s: LiveQueue): LiveQueue {
  return s.current === null ? s : { ...s, current: null, queue: [s.current, ...s.queue] };
}

/* ---------------------------------------------------------------- Công tắc, tab, khung nhìn */

const LIVE_KEY = "drift.signalResearch.live";

function readLive(): boolean {
  try {
    return window.localStorage.getItem(LIVE_KEY) !== "off";
  } catch {
    return true;
  }
}

/**
 * Công tắc Live, nhớ theo người xem trên máy này (mặc định bật). `known` = đã đọc lựa chọn đã lưu (sau khi gắn vào DOM):
 * chưa đọc thì chưa hỏi bài mới, để người đã tắt không bị gọi API lần nào.
 */
export function useLiveSwitch(): { on: boolean; known: boolean; set: (on: boolean) => void } {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    setOn(readLive());
  }, []);
  const set = useCallback((v: boolean) => {
    setOn(v);
    try {
      window.localStorage.setItem(LIVE_KEY, v ? "on" : "off");
    } catch {
      // Không lưu được (chế độ riêng tư): chỉ giữ trong phiên này.
    }
  }, []);
  return { on: on ?? true, known: on !== null, set };
}

function subscribeVisibility(cb: () => void): () => void {
  document.addEventListener("visibilitychange", cb);
  return () => {
    document.removeEventListener("visibilitychange", cb);
  };
}

/** `document.visibilityState === "visible"` (SSR: false). */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "visible",
    () => false,
  );
}

/** Phần tử có nằm trong màn hình không. Không có IntersectionObserver (môi trường test cũ): coi như có. */
export function useInView(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const e = entries.at(-1);
      if (e !== undefined) setInView(e.isIntersecting);
    });
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [ref]);
  return inView;
}

/* ---------------------------------------------------------------- Nguồn bài */

export interface LiveArticles extends LiveQueue {
  /** Đang hỏi bài mới (Live bật, tab hiển thị, chế độ tổng). */
  listening: boolean;
  /** Bài tới live trong phiên này (badge "NEW" ở feed). */
  fresh: ReadonlySet<string>;
  /** Bài đang rơi đã xong (hoặc không tải được trace): làm mới số, sang bài sau. */
  finish: () => void;
}

/**
 * `live`: công tắc; `tracing`: người dùng đang xem trace (không hỏi, không rơi); `visible`: tab hiển thị; `inView`: phễu
 * trong màn hình (ngoài màn hình thì bài mới chỉ cập nhật số).
 */
export function useLiveArticles({
  live,
  tracing,
  visible,
  inView,
  versionId,
}: {
  live: boolean;
  tracing: boolean;
  visible: boolean;
  inView: boolean;
  versionId: VersionId;
}): LiveArticles {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveQueue>(EMPTY_QUEUE);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const since = useRef<{ version: VersionId; cursor: string | null }>({
    version: versionId,
    cursor: null,
  });
  const seen = useRef(new Set<string>());
  const inViewRef = useRef(inView);
  useEffect(() => {
    inViewRef.current = inView;
  }, [inView]);
  const listening = live && visible && !tracing;

  const refresh = useCallback(() => {
    for (const queryKey of LIVE_REFRESH_KEYS) void qc.invalidateQueries({ queryKey });
  }, [qc]);

  // Version khác: bài và con trỏ khác, làm lại từ đầu.
  useEffect(() => {
    if (since.current.version === versionId) return;
    since.current = { version: versionId, cursor: null };
    setState(EMPTY_QUEUE);
  }, [versionId]);

  useEffect(() => {
    if (!listening) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Lần hỏi đầu sau khi dừng chỉ cập nhật số: bài tới lúc không xem không rơi dồn một lúc.
    let catchUp = true;
    const tick = async () => {
      const version = since.current.version;
      try {
        const r = await fetchNewArticles(since.current.cursor, version);
        if (stopped || since.current.version !== version) return;
        const first = since.current.cursor === null;
        since.current = { version, cursor: r.since };
        const items = r.items.filter((a) => !seen.current.has(a.id));
        for (const a of items) seen.current.add(a.id);
        if (items.length > 0) {
          setFresh((f) => new Set([...f, ...items.map((a) => a.id)]));
          if (catchUp || first || !inViewRef.current) refresh();
          else setState((s) => enqueue(s, items));
        }
        catchUp = false;
      } catch {
        // Lỗi mạng / API: thử lại ở lần sau, con trỏ giữ nguyên.
      }
      if (!stopped) timer = setTimeout(() => void tick(), LIVE_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [listening, versionId, refresh]);

  // Trace mở giữa chừng: bài đang rơi về hàng đợi. Rảnh: lấy bài kế tiếp.
  useEffect(() => {
    setState((s) => (tracing ? interrupt(s) : live ? advance(s) : s));
  }, [tracing, live, state.current, state.queue.length]);

  // Live tắt: bỏ hàng đợi (feed và số đếm làm mới từ API).
  const idle = state.current === null && state.queue.length === 0 && state.extra === 0;
  useEffect(() => {
    if (live || idle) return;
    setState(EMPTY_QUEUE);
    refresh();
  }, [live, idle, refresh]);

  const finish = useCallback(() => {
    setState((s) => ({ ...s, current: null }));
    refresh();
  }, [refresh]);

  return { ...state, listening, fresh, finish };
}
