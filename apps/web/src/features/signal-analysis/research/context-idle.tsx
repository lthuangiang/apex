"use client";

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import { WhaleIcon } from "./whale-icon";

// Hoạt cảnh CHỜ của khung 4 · Context (#343, yêu cầu người dùng, PM chốt): khi chưa có kết quả thật (chế độ tổng, bài
// không tới bước 4, chip chưa tới bước 4) khung vẫn chuyển động cho đỡ chán, nhưng không bao giờ trông như một kết quả:
// không tag số, không badge Yes / No, màu nhạt hơn, đường giá không phải giá thật (không trục, không số).
// - Chỉ CSS keyframes trên transform / opacity, không re-render React mỗi frame.
// - Dừng (animation-play-state) khi tab ẩn hoặc khung ra khỏi màn hình (`useMotionPause`).
// - prefers-reduced-motion: chỉ có lớp `motion-safe:` nên đứng yên hoàn toàn.
// - Cả khối aria-hidden; câu chờ nằm ngoài, ở ContextPanel.
// - Điện thoại: chỉ cá voi + ticker (bập bênh ẩn dưới 768 px).

/**
 * true khi nên dừng hoạt cảnh: tab ẩn, hoặc phần tử ra khỏi màn hình. Không có IntersectionObserver (SSR, môi trường
 * cũ) thì chỉ theo tab.
 */
export function useMotionPause(ref: RefObject<HTMLElement | null>): boolean {
  const [hidden, setHidden] = useState(false);
  const [offscreen, setOffscreen] = useState(false);
  useEffect(() => {
    const onVis = () => {
      setHidden(document.visibilityState === "hidden");
    };
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e !== undefined) setOffscreen(!e.isIntersecting);
    });
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [ref]);
  return hidden || offscreen;
}

/** Chu kỳ nhả bong bóng ngẫu nhiên 8–15 s (chọn một lần khi gắn khung). */
const bubbleEvery = () => 8 + Math.random() * 7;

const IDLE_WATER = "bg-[color-mix(in_srgb,var(--accent)_8%,var(--surface))]";
const IDLE_FLOOR = "bg-[color-mix(in_srgb,var(--accent)_14%,var(--surface))]";
const IDLE_FILL = "fill-[color-mix(in_srgb,var(--accent)_30%,var(--surface))]";
const IDLE_STROKE = "stroke-[color-mix(in_srgb,var(--accent)_30%,var(--surface))]";

function Bubble({
  left,
  top,
  every,
  delay,
}: {
  left: string;
  top: number;
  every: number;
  delay: number;
}) {
  return (
    <span
      style={{
        left,
        top,
        animationDuration: `${String(every)}s`,
        animationDelay: `${String(delay)}s`,
      }}
      className={`absolute size-1.5 rounded-full border border-[color-mix(in_srgb,var(--accent)_35%,var(--surface))] opacity-0 motion-safe:animate-[sr-idle-bubble_10s_ease-out_infinite]`}
    />
  );
}

/** Cá voi bơi qua lại, thỉnh thoảng nhả bong bóng. */
export function IdleWhales() {
  const [every] = useState(() => [bubbleEvery(), bubbleEvery()] as const);
  return (
    <div
      data-testid="sr-idle-h1"
      className={`relative h-[70px] overflow-hidden rounded-[10px] ${IDLE_WATER}`}
    >
      <div className={`absolute inset-x-0 bottom-0 h-[22px] ${IDLE_FLOOR}`} />
      <div className="absolute left-[12%] top-[26px] motion-safe:animate-[sr-idle-swim_22s_ease-in-out_infinite]">
        <WhaleIcon className={`h-6 w-10 ${IDLE_FILL}`} />
        <Bubble left="8px" top={-6} every={every[0]} delay={2} />
      </div>
      <div className="absolute left-[58%] top-[44px] motion-safe:animate-[sr-idle-swim2_28s_ease-in-out_infinite]">
        <WhaleIcon flip className={`h-4 w-7 ${IDLE_FILL}`} />
        <Bubble left="20px" top={-6} every={every[1]} delay={5} />
      </div>
    </div>
  );
}

/** Người hai bên bước vào / bước ra; bập bênh lắc nhẹ quanh vị trí cân bằng, không nghiêng hẳn bên nào. */
export function IdleSeesaw() {
  const person = (i: number, side: "l" | "r") => {
    const style: CSSProperties = {
      animationDelay: `${String(i * 1.3 + (side === "r" ? 0.7 : 0))}s`,
    };
    return (
      <span
        key={`${side}${String(i)}`}
        style={style}
        className="h-3 w-2 rounded-t-[4px] rounded-b-[1px] bg-[color-mix(in_srgb,var(--ink-2)_30%,var(--surface))] motion-safe:animate-[sr-idle-step_6s_ease-in-out_infinite]"
      />
    );
  };
  return (
    <div
      data-testid="sr-idle-h2"
      className="relative h-14 overflow-hidden rounded-[10px] border border-border bg-surface-2 max-md:hidden"
    >
      <div className="absolute bottom-2 left-1/2 -ml-2 size-0 border-x-8 border-b-[14px] border-x-transparent border-b-[color-mix(in_srgb,var(--ink-2)_35%,var(--surface))]" />
      <div className="absolute bottom-[22px] left-1/2 -ml-20 h-1 w-40 origin-bottom rounded-sm bg-[color-mix(in_srgb,var(--ink)_30%,var(--surface))] motion-safe:animate-[sr-idle-rock_5s_ease-in-out_infinite_alternate]">
        <div className="absolute bottom-1 left-0.5 flex gap-0.5">
          {[0, 1, 2].map((i) => person(i, "l"))}
        </div>
        <div className="absolute bottom-1 right-0.5 flex gap-0.5">
          {[0, 1, 2].map((i) => person(i, "r"))}
        </div>
      </div>
    </div>
  );
}

// Đường trang trí lặp lại (không phải giá thật): hai chu kỳ giống nhau nối liền để chạy ticker không giật.
const WAVE =
  "M0 30 L20 27 L40 31 L60 26 L80 29 L100 25 L120 30 L140 27 L160 32 L180 28 L200 30 L220 27 L240 31 L260 26 L280 29 L300 25 L320 30 L340 27 L360 32 L380 28 L400 30";

/** Đường trang trí chạy đều sang phải kiểu ticker, dao động nhỏ; không trục, không số. */
export function IdleTicker() {
  return (
    <div
      data-testid="sr-idle-h3"
      className="relative h-14 overflow-hidden rounded-[10px] border border-border bg-surface-2"
    >
      <svg
        width="200%"
        height="56"
        viewBox="0 0 400 56"
        preserveAspectRatio="none"
        className="absolute inset-y-0 left-0 motion-safe:animate-[sr-idle-ticker_12s_linear_infinite]"
      >
        <path
          d={WAVE}
          className={`fill-none ${IDLE_STROKE}`}
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

/** Cả ba khung chờ; `paused` dừng mọi keyframe (tab ẩn / ngoài màn hình). */
export function IdleScenes({ paused }: { paused: boolean }) {
  return (
    <div
      aria-hidden="true"
      data-testid="sr-idle"
      data-paused={paused ? "" : undefined}
      className={`flex flex-col gap-2 ${paused ? "[&_*]:[animation-play-state:paused]" : ""}`}
    >
      <IdleWhales />
      <IdleSeesaw />
      <IdleTicker />
    </div>
  );
}

export function useIdlePauseRef() {
  const ref = useRef<HTMLDivElement | null>(null);
  const paused = useMotionPause(ref);
  return { ref, paused };
}
