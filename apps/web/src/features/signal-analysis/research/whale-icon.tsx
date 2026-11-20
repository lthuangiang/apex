import type { CSSProperties } from "react";

// Hình cá voi dùng chung cho khung 4 · Context (hiệu ứng có kết quả và hoạt cảnh chờ, #343).

const WHALE_PATH =
  "M10 40c10-18 40-26 66-18 10 3 18 8 24 14l12-12-2 18 8 10-14-4c-10 12-30 18-50 16C24 62 6 54 10 40z";
const SPOUT_PATH = "M44 18c-2-6 0-12 4-14M44 18c0-7 4-11 9-12M44 18c2-6 7-8 12-7";

export function WhaleIcon({
  className,
  spout = false,
  flip = false,
  style,
}: {
  className?: string;
  spout?: boolean;
  /** Quay đầu sang trái (cá voi bơi đi). */
  flip?: boolean;
  style?: CSSProperties;
}) {
  return (
    <svg aria-hidden="true" viewBox="0 0 120 70" className={className} style={style}>
      {flip ? (
        <g transform="translate(120 0) scale(-1 1)">
          <path d={WHALE_PATH} />
        </g>
      ) : (
        <path d={WHALE_PATH} />
      )}
      {spout ? (
        <>
          <circle cx="34" cy="36" r="3" className="fill-surface" />
          <path
            d={SPOUT_PATH}
            className="fill-none stroke-[color-mix(in_srgb,var(--accent)_60%,var(--surface))]"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </>
      ) : null}
    </svg>
  );
}
