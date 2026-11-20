"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { ACCENT_SOFT } from "./context-panel";
import { BANDS, type BandKey } from "./trace-player";

// Phễu sáng 6 tầng (#343, mockup redesign-full-page.html, redesign-trace-live.html). Chỉ hiển thị: nhận trạng thái từng
// tầng và vị trí chip từ nơi gọi (trace của NewsTrace, hoặc bài mới live ở #345), không hẹn giờ, không đọc API. Tầng 4 ·
// Context viền đứt (chỉ ghi nhận, không chặn).

/** `total`: chế độ tổng; `pass` / `drop` / `merge`: bài đã qua tầng đó; `active`: chip đang ở đây. */
export type BandState = "total" | "pass" | "drop" | "merge" | "active" | "idle" | "skip";

export interface FunnelBandView {
  key: BandKey;
  /** "1 · Collect". */
  label: string;
  /** Chữ bên phải trong tầng (số bài ở chế độ tổng, kết quả bước khi trace). */
  note: string | null;
  state: BandState;
  /** Thêm sau nhãn (ba biểu tượng nhỏ của tầng Context). */
  extra?: ReactNode | undefined;
  /** Chú thích khi rê chuột (chế độ tổng: bao nhiêu bài ra ở tầng này, vì sao). */
  title?: string | undefined;
  /** Có thì tầng là nút (chế độ tổng: lọc feed theo tầng). */
  onClick?: (() => void) | undefined;
  pressed?: boolean | undefined;
  ariaLabel?: string | undefined;
  /** Thay `note` khi cần định dạng (tầng 4 ở chế độ tổng: từng cặp nhãn–số không ngắt dòng). */
  noteNode?: ReactNode | undefined;
  /** Câu ngắn khi tầng hẹp (container query theo chiều rộng thật của tầng, ngưỡng ở `SHORT_AT`). */
  noteShort?: ReactNode | undefined;
  /** #345: số đếm vừa đổi vì bài mới live: chữ bên phải nảy một lần khi đổi. */
  bump?: boolean | undefined;
}

export type TokenTone = "moving" | "traded" | "dropped" | "merged";

export interface FunnelToken {
  text: string;
  tone: TokenTone;
  /** Tầng chip đang đứng (0 = chưa vào phễu). */
  pos: number;
  visible: boolean;
  /** #345: bài mới live chạy nhịp nhanh hơn trace. */
  fast?: boolean | undefined;
}

/**
 * Hình học mặc định: tầng cao tối thiểu 36 px, cách 8 px (44 px một hàng). Tầng cao theo chữ (kết quả dài xuống dòng
 * trong tầng), nên vị trí chip đo từ DOM; hằng số này chỉ dùng trước lần đo đầu.
 */
export const BAND_ROW = 44;

/**
 * Ngưỡng câu ngắn theo chiều rộng thật của từng tầng (tầng là `@container`). Dưới ngưỡng: hiện `noteShort`. Chuỗi lớp viết
 * nguyên văn để Tailwind sinh ra.
 */
const SHORT_AT: Record<BandKey, readonly [long: string, short: string]> = {
  collect: ["hidden @[200px]:inline", "@[200px]:hidden"],
  normalize: ["hidden @[300px]:inline", "@[300px]:hidden"],
  score: ["hidden @[220px]:inline", "@[220px]:hidden"],
  context: ["hidden @[480px]:inline", "@[480px]:hidden"],
  filter: ["hidden @[200px]:inline", "@[200px]:hidden"],
  decide: ["hidden @[260px]:inline", "@[260px]:hidden"],
};
// Rộng theo % khung phễu: chế độ tổng / trace (desktop) và điện thoại (mockup 390).
const WIDTHS_TOTAL = [70, 62, 54, 50, 46, 38] as const;
// Trace: khung phễu hẹp hơn (có khung Context bên cạnh) nên tầng rộng hơn mockup để kết quả gọn vừa tối đa 2 dòng.
const WIDTHS_TRACE = [94, 88, 82, 78, 72, 66] as const;
const WIDTHS_MOBILE = [100, 92, 86, 80, 72, 64] as const;
/**
 * 1280–1399 px: khung 4 · Context nằm cạnh phễu nên khung phễu hẹp nhất; tầng ít thu hẹp hơn để kết quả gọn đỡ xuống
 * dòng (cả chế độ tổng lẫn trace).
 */
export const WIDTHS_NARROW = [100, 96, 92, 88, 84, 80] as const;

// Màu tầng khi đã qua / chế độ tổng (chỉ token): accent-ink → accent → accent nhạt → (Context trắng) → accent rất nhạt →
// xanh lá (Decide).
const FILL: Record<BandKey, string> = {
  collect: "bg-accent-ink text-white",
  normalize: "bg-accent text-white",
  score: "bg-[color-mix(in_srgb,var(--accent)_60%,var(--surface))] text-ink",
  context: "bg-surface text-ink",
  filter: `${ACCENT_SOFT} text-ink`,
  decide: "bg-pos text-white",
};
/** Màu chấm số trên thẻ bước (cùng màu tầng). */
export const DOT: Record<BandKey, string> = {
  ...FILL,
  context: "bg-accent-tint text-accent-ink",
};

const CLIP: CSSProperties = { clipPath: "polygon(0 0,100% 0,97% 100%,3% 100%)" };

const TOKEN: Record<TokenTone, string> = {
  moving: "border-accent bg-surface text-ink",
  traded: "border-pos-bg bg-pos text-white",
  dropped: "border-muted bg-bg text-ink-2",
  merged: "border-muted bg-bg text-ink-2",
};

function bandTone(b: FunnelBandView): string {
  const on = b.state === "total" || b.state === "pass" || b.state === "active";
  if (on) return FILL[b.key];
  if (b.state === "drop" || b.state === "merge") return "bg-bg text-ink-2";
  return "bg-bg text-muted";
}

/* ---------------------------------------------------------------- Hình học (dùng chung cho CSS và test) */

/**
 * Khi trace (từ 768 px), bên phải các tầng có một rãnh trống rộng ngần này: chip bài bị loại đỗ trong rãnh, cùng hàng với
 * tầng đã loại nó, ngoài thân phễu, nên không bao giờ đè chữ của tầng nào (#343 review).
 */
export const TOKEN_GUTTER = 104;
/** Chip trong rãnh rộng tối đa ngần này (rãnh − 8 px lề). */
export const DROP_CHIP_MAX = TOKEN_GUTTER - 8;
const BAND_H = 36;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Hình chữ nhật của 6 tầng trong khung rộng `width` px (desktop, trace), theo chiều cao TỐI THIỂU của tầng. Tầng thật cao
 * theo chữ (#345); kiểm bố cục thật ở `layout-tests/funnel.layout.ts` (Playwright).
 */
export function bandRects(width: number, tracing: boolean, narrow = false): Rect[] {
  const inner = tracing ? width - TOKEN_GUTTER : width;
  const ws = narrow ? WIDTHS_NARROW : tracing ? WIDTHS_TRACE : WIDTHS_TOTAL;
  return ws.map((p, i) => {
    const w = (inner * p) / 100;
    return { x: (inner - w) / 2, y: i * BAND_ROW, w, h: BAND_H };
  });
}

/** Hình chữ nhật của chip (cùng công thức với `Token`); `chip` = kích thước chip đo được. */
export function tokenRect(
  width: number,
  token: Pick<FunnelToken, "pos" | "tone">,
  chip: { w: number; h: number },
): Rect {
  const inner = width - TOKEN_GUTTER;
  if (token.tone === "dropped") {
    const w = Math.min(chip.w, DROP_CHIP_MAX);
    return { x: inner + 4, y: (token.pos - 1) * BAND_ROW, w, h: Math.max(chip.h, BAND_H) };
  }
  const docked = token.tone === "traded" || token.tone === "merged";
  const y = docked
    ? BANDS.length * BAND_ROW + 4
    : token.pos === 0
      ? -40
      : (token.pos - 1) * BAND_ROW + 4;
  return { x: inner / 2 - chip.w / 2, y, w: chip.w, h: chip.h };
}

export function FunnelBands({
  bands,
  tracing,
  token = null,
}: {
  bands: FunnelBandView[];
  tracing: boolean;
  token?: FunnelToken | null;
}) {
  const widths = tracing ? WIDTHS_TRACE : WIDTHS_TOTAL;
  // Tầng cao theo chữ: đo vị trí từng tầng (và hàng đỗ chip) để chip đứng đúng tầng.
  const box = useRef<HTMLDivElement>(null);
  const [tops, setTops] = useState<readonly number[]>([]);
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    const measure = () => {
      const rows = [...el.querySelectorAll<HTMLElement>("[data-band],[data-dock]")];
      // Chưa có layout (ẩn, môi trường không vẽ): giữ hình học mặc định.
      const next = rows.some((b) => b.offsetHeight === 0) ? [] : rows.map((b) => b.offsetTop);
      setTops((prev) =>
        prev.length === next.length && prev.every((v, k) => v === next[k]) ? prev : next,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    for (const b of el.children) ro.observe(b);
    return () => {
      ro.disconnect();
    };
  });
  return (
    <div
      ref={box}
      data-testid="sr-funnel-bands"
      style={tracing ? { ["--gutter" as string]: `${String(TOKEN_GUTTER)}px` } : undefined}
      className={`relative flex flex-col items-center gap-2 ${tracing ? "md:pr-[var(--gutter)]" : ""}`}
    >
      {bands.map((b) => {
        const i = BANDS.indexOf(b.key);
        const ctx = b.key === "context";
        const on = b.state === "total" || b.state === "pass" || b.state === "active";
        const style: CSSProperties = {
          ...(ctx ? {} : CLIP),
          ["--w" as string]: `${String(widths[i] ?? 38)}%`,
          ["--mw" as string]: `${String(WIDTHS_MOBILE[i] ?? 64)}%`,
          ["--nw" as string]: `${String(WIDTHS_NARROW[i] ?? 80)}%`,
        };
        const cls = `@container flex min-h-[30px] w-[var(--mw)] min-w-0 items-center justify-between gap-2 border-0 py-1 text-xs font-extrabold whitespace-nowrap transition-[background-color,color,filter] duration-300 md:min-h-9 md:w-[var(--w)] md:text-[13px] xl:w-[var(--nw)] min-[1400px]:w-[var(--w)] ${
          ctx
            ? `rounded-md border-2 border-dashed px-[3%] md:px-[4%] ${on ? "border-accent" : "border-[color-mix(in_srgb,var(--accent)_25%,var(--surface))]"}`
            : "px-[5%]"
        } ${bandTone(b)} ${
          b.state === "active" ? "motion-safe:animate-[sr-glow_1s_ease-in-out_infinite]" : ""
        } ${b.pressed === true ? "outline outline-[3px] -outline-offset-[3px] outline-ink" : ""}`;
        const long = b.noteNode ?? b.note;
        const content = (
          <>
            <span data-label="" className="flex flex-none items-center gap-2">
              <span>{b.label}</span>
              {b.extra}
            </span>
            {/* Không cắt "…", không tràn: kết quả dài xuống dòng trong tầng (tầng cao theo chữ); tầng hẹp dùng câu ngắn. */}
            {long === null ? null : (
              <span
                key={b.bump === true && typeof long === "string" ? long : undefined}
                data-note=""
                className={`min-w-0 text-right leading-[1.15] font-bold whitespace-normal [overflow-wrap:anywhere] ${b.bump === true ? "motion-safe:animate-[sr-bump_.5s_ease_both]" : ""}`}
              >
                {b.noteShort === undefined ? (
                  long
                ) : (
                  <>
                    <span className={SHORT_AT[b.key][0]}>{long}</span>
                    <span className={SHORT_AT[b.key][1]}>{b.noteShort}</span>
                  </>
                )}
              </span>
            )}
          </>
        );
        return b.onClick === undefined ? (
          <div
            key={b.key}
            data-band={b.key}
            data-state={b.state}
            title={b.title}
            style={style}
            className={cls}
          >
            {content}
          </div>
        ) : (
          <button
            key={b.key}
            type="button"
            data-band={b.key}
            data-state={b.state}
            title={b.title}
            aria-label={b.ariaLabel}
            aria-pressed={b.pressed}
            onClick={b.onClick}
            style={style}
            className={`${cls} cursor-pointer hover:brightness-110`}
          >
            {content}
          </button>
        );
      })}
      {/* Hàng trống dưới Decide khi trace: chip đã vào lệnh / gộp đỗ ở đây, không bao giờ che chữ trên tầng. */}
      {tracing ? (
        <div
          aria-hidden="true"
          data-testid="sr-token-dock"
          data-dock=""
          className="h-9 max-md:hidden"
        />
      ) : null}
      {token === null ? null : <Token token={token} tops={tops} />}
    </div>
  );
}

function Token({ token, tops }: { token: FunnelToken; tops: readonly number[] }) {
  const dropped = token.tone === "dropped";
  // Đã vào lệnh / gộp: chip xuống hàng trống dưới tầng cuối thay vì nằm trên chữ kết quả của Decide (#357).
  // Bị loại: chip đỗ trong rãnh bên phải, cùng hàng với tầng đã loại nó, không xoay, không đè tầng kế tiếp.
  const docked = token.tone === "traded" || token.tone === "merged";
  // Vị trí đo từ DOM (tầng cao theo chữ); chưa đo được thì theo hình học mặc định.
  const row = (n: number) => tops[n] ?? n * BAND_ROW;
  const top = dropped
    ? row(token.pos - 1)
    : docked
      ? row(BANDS.length) + 4
      : token.pos === 0
        ? -40
        : row(token.pos - 1) + 4;
  const style: CSSProperties = {
    top: `${String(top)}px`,
    left: dropped
      ? `calc(100% - ${String(TOKEN_GUTTER - 4)}px)`
      : `calc((100% - ${String(TOKEN_GUTTER)}px) / 2)`,
    maxWidth: dropped ? `${String(DROP_CHIP_MAX)}px` : "200px",
    opacity: token.visible ? 1 : 0,
  };
  return (
    <div
      aria-hidden="true"
      data-testid="sr-token"
      data-tone={token.tone}
      style={style}
      className={`absolute z-[2] rounded-full border-2 text-xs font-extrabold shadow-float transition-[top,left,transform,background-color,border-color,color,opacity] ${token.fast === true ? "duration-300" : "duration-700"} ease-[cubic-bezier(.65,0,.35,1)] motion-reduce:transition-none max-md:hidden ${
        dropped
          ? "flex min-h-9 items-center rounded-[14px] px-2.5 py-1 text-[11px] leading-tight break-words"
          : "-translate-x-1/2 truncate px-3 py-[5px] whitespace-nowrap"
      } ${TOKEN[token.tone]}`}
    >
      {token.text}
    </div>
  );
}
