"use client";

import type { CSSProperties, ReactNode } from "react";

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
}

export type TokenTone = "moving" | "traded" | "dropped" | "merged";

export interface FunnelToken {
  text: string;
  tone: TokenTone;
  /** Tầng chip đang đứng (0 = chưa vào phễu). */
  pos: number;
  visible: boolean;
}

/** Hình học: mỗi tầng cao 36 px, cách 8 px (44 px một hàng). */
export const BAND_ROW = 44;
// Rộng theo % khung phễu: chế độ tổng / trace (desktop) và điện thoại (mockup 390).
const WIDTHS_TOTAL = [70, 62, 54, 50, 46, 38] as const;
// Trace: khung phễu hẹp hơn (có khung Context bên cạnh) nên tầng rộng hơn mockup để kết quả gọn vừa tối đa 2 dòng.
const WIDTHS_TRACE = [94, 88, 82, 78, 72, 66] as const;
const WIDTHS_MOBILE = [100, 92, 86, 80, 72, 64] as const;

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
  dropped: "border-muted bg-bg text-ink-2 rotate-[-4deg]",
  merged: "border-muted bg-bg text-ink-2",
};

function bandTone(b: FunnelBandView): string {
  const on = b.state === "total" || b.state === "pass" || b.state === "active";
  if (on) return FILL[b.key];
  if (b.state === "drop" || b.state === "merge") return "bg-bg text-ink-2";
  return "bg-bg text-muted";
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
  return (
    <div data-testid="sr-funnel-bands" className="relative flex flex-col items-center gap-2">
      {bands.map((b) => {
        const i = BANDS.indexOf(b.key);
        const ctx = b.key === "context";
        const on = b.state === "total" || b.state === "pass" || b.state === "active";
        const style: CSSProperties = {
          ...(ctx ? {} : CLIP),
          ["--w" as string]: `${String(widths[i] ?? 38)}%`,
          ["--mw" as string]: `${String(WIDTHS_MOBILE[i] ?? 64)}%`,
        };
        const cls = `flex h-[30px] w-[var(--mw)] min-w-0 items-center justify-between gap-2 border-0 text-xs font-extrabold whitespace-nowrap transition-[background-color,color,filter] duration-300 md:h-9 md:w-[var(--w)] md:text-[13px] ${
          ctx
            ? `rounded-md border-2 border-dashed px-[3%] md:px-[4%] ${on ? "border-accent" : "border-[color-mix(in_srgb,var(--accent)_25%,var(--surface))]"}`
            : "px-[5%]"
        } ${bandTone(b)} ${
          b.state === "active" ? "motion-safe:animate-[sr-glow_1s_ease-in-out_infinite]" : ""
        } ${b.pressed === true ? "outline outline-[3px] -outline-offset-[3px] outline-ink" : ""}`;
        const content = (
          <>
            <span className="flex flex-none items-center gap-2">
              <span>{b.label}</span>
              {b.extra}
            </span>
            {/* #343: không cắt "…"; kết quả dài thì xuống tối đa 2 dòng trong tầng (cao cố định). */}
            {b.note === null ? null : (
              <span className="min-w-0 text-right leading-[1.15] font-bold whitespace-normal">
                {b.note}
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
        <div aria-hidden="true" data-testid="sr-token-dock" className="h-9 max-md:hidden" />
      ) : null}
      {token === null ? null : <Token token={token} />}
    </div>
  );
}

function Token({ token }: { token: FunnelToken }) {
  const dropped = token.tone === "dropped";
  // Đã vào lệnh / gộp: chip xuống hàng trống dưới tầng cuối thay vì nằm trên chữ kết quả của Decide.
  const docked = token.tone === "traded" || token.tone === "merged";
  const top = docked
    ? BANDS.length * BAND_ROW + 4
    : token.pos === 0
      ? -40
      : (token.pos - 1) * BAND_ROW + 4;
  const style: CSSProperties = {
    top: `${String(dropped ? top + 26 : top)}px`,
    left: dropped ? "calc(50% + 40px)" : "50%",
    opacity: token.visible ? 1 : 0,
  };
  return (
    <div
      aria-hidden="true"
      data-testid="sr-token"
      style={style}
      className={`absolute z-[2] max-w-[200px] -translate-x-1/2 truncate rounded-full border-2 px-3 py-[5px] text-xs font-extrabold whitespace-nowrap shadow-float transition-[top,left,rotate,background-color,border-color,color,opacity] duration-700 ease-[cubic-bezier(.65,0,.35,1)] max-md:hidden ${TOKEN[token.tone]}`}
    >
      {token.text}
    </div>
  );
}
