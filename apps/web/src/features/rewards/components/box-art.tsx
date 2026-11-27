"use client";

import { useId, type CSSProperties } from "react";

// Bộ hình Blind Box tự vẽ của DeskLabs (#575, DEC-400; bản phác docs/mockups/rewards/polish, nguồn boxart.py). SVG
// isometric viewBox 120: ba mặt + nắp tách nhóm (`.bx-lid`, để popup bật nắp), mark DeskLabs trên mặt phải; box chưa
// claim (Mystery) có dấu "?". Không dùng hay vẽ lại hình của SoDEX. Màu chỉ lấy từ token `--box-*` (tokens.css).
// Dưới 56 px tự bỏ chi tiết (vân gỗ, vệt sáng, sao, bóng) để vẫn rõ ở 28 px. Vệt sáng / sao / lơ lửng chỉ chạy khi
// không bật prefers-reduced-motion (class `motion-safe:` và CSS trong globals.css).

export type BoxKind = "common" | "uncommon" | "rare" | "superrare" | "mystery";

/** Tên cấp của SoDEX → hình. Cấp lạ hoặc chưa có cấp → Mystery. */
export function boxKindOf(level: string | null | undefined): BoxKind {
  switch ((level ?? "").toLowerCase().replace(/[\s_-]/g, "")) {
    case "common":
      return "common";
    case "uncommon":
      return "uncommon";
    case "rare":
      return "rare";
    case "superrare":
      return "superrare";
    default:
      return "mystery";
  }
}

/** Kích thước dưới mức này thì dùng bản giản lược. */
export const BOX_SIMPLE_BELOW = 56;

const v = (kind: BoxKind, face: string) => `var(--box-${kind}-${face})`;
const f = (kind: BoxKind, face: string): CSSProperties => ({ fill: v(kind, face) });

function DMark({ color }: { color: string }) {
  return (
    <>
      <path
        d="M6.5 5h5.2a7 7 0 0 1 0 14H6.5z"
        style={{ fill: "none", stroke: color }}
        strokeWidth={2.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <rect x={9.6} y={9} width={4.6} height={2} rx={1} style={{ fill: color }} />
      <rect x={9.6} y={13} width={3.2} height={2} rx={1} style={{ fill: color }} opacity={0.75} />
    </>
  );
}

function Star({ x, y, s, delay }: { x: number; y: number; s: number; delay: number }) {
  return (
    <path
      className="bx-spark"
      style={{ fill: "var(--box-gold)", animationDelay: `${String(delay)}s` }}
      d={`M${String(x)} ${String(y - s)} L${String(x + s * 0.3)} ${String(y - s * 0.3)} L${String(x + s)} ${String(y)} L${String(x + s * 0.3)} ${String(y + s * 0.3)} L${String(x)} ${String(y + s)} L${String(x - s * 0.3)} ${String(y + s * 0.3)} L${String(x - s)} ${String(y)} L${String(x - s * 0.3)} ${String(y - s * 0.3)} Z`}
    />
  );
}

export function BoxArt({
  level,
  size = 64,
  faded = false,
  float = false,
  label,
  className = "",
}: {
  /** Tên cấp SoDEX trả; null / lạ = box chưa có cấp (Mystery, dấu "?"). */
  level: string | null | undefined;
  size?: number;
  /** Cấp không có box: hình mờ, giảm bão hoà. */
  faded?: boolean;
  /** Lơ lửng nhẹ (thẻ cấp có box). */
  float?: boolean;
  /** Tên cho trình đọc màn hình; bỏ trống = hình trang trí (`aria-hidden`). */
  label?: string;
  className?: string;
}) {
  const id = `bx${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const kind = boxKindOf(level);
  const small = size < BOX_SIMPLE_BELOW;
  const sw = small ? 1.2 : 1.4;
  const shineDur = kind === "rare" ? 3.2 : 2.6;
  const shiny = (kind === "rare" || kind === "superrare") && !small;
  const a11y =
    label === undefined
      ? ({ "aria-hidden": true } as const)
      : ({ role: "img", "aria-label": label } as const);
  return (
    <svg
      className={`bx bx-${kind} block overflow-visible ${float ? "bx-float" : ""} ${className}`}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      data-kind={kind}
      data-simple={small ? "true" : undefined}
      style={faded ? { opacity: 0.38, filter: "saturate(.35)" } : undefined}
      {...a11y}
    >
      {shiny ? (
        <defs>
          <linearGradient id={`${id}-shine`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" style={{ stopColor: "var(--box-shine)", stopOpacity: 0 }} />
            <stop offset=".5" style={{ stopColor: "var(--box-shine)", stopOpacity: 0.75 }} />
            <stop offset="1" style={{ stopColor: "var(--box-shine)", stopOpacity: 0 }} />
          </linearGradient>
          <clipPath id={`${id}-clip`}>
            <path d="M16 36 L60 14 L104 36 L104 84 L60 106 L16 84 Z" />
          </clipPath>
        </defs>
      ) : null}
      {small ? null : (
        <ellipse cx={60} cy={112} rx={38} ry={5} style={{ fill: "var(--box-shadow)" }} />
      )}
      <g className="bx-body">
        <path d="M16 46 L60 68 L60 106 L16 84 Z" style={f(kind, "l")} />
        <path d="M60 68 L104 46 L104 84 L60 106 Z" style={f(kind, "r")} />
        {kind === "common" && !small
          ? [0, 1, 2].map((i) => (
              <path
                key={i}
                d={`M16 ${String(56 + i * 9)} L60 ${String(78 + i * 9)}`}
                style={{ stroke: v(kind, "edge") }}
                strokeOpacity={0.28}
                strokeWidth={1}
              />
            ))
          : null}
        {kind === "superrare" ? (
          <>
            <path d="M38 57 L38 95 L44 98 L44 60 Z" style={{ fill: "var(--box-gold)" }} />
            <path
              d="M82 57 L82 95 L76 98 L76 60 Z"
              style={{ fill: "var(--box-gold)" }}
              opacity={0.95}
            />
          </>
        ) : null}
        <g transform="matrix(1,-0.5,0,1,60,68)">
          {kind === "mystery" ? (
            <text
              x={22}
              y={29}
              textAnchor="middle"
              fontSize={26}
              fontWeight={800}
              style={{ fill: v(kind, "mark"), fontFamily: "var(--font-sans)" }}
            >
              ?
            </text>
          ) : (
            <g transform="translate(10,4) scale(1.05)">
              <DMark color={v(kind, "mark")} />
            </g>
          )}
        </g>
      </g>
      <g className="bx-lid">
        <path d="M16 36 L60 58 L60 68 L16 46 Z" style={f(kind, "ll")} />
        <path d="M60 58 L104 36 L104 46 L60 68 Z" style={f(kind, "lr")} />
        <path d="M60 14 L104 36 L60 58 L16 36 Z" style={f(kind, "top")} />
        {kind === "superrare" ? (
          <>
            <path
              d="M35.5 26.2 L41.5 23.2 L85 45 L85 55 L79 58 L79 48 Z"
              style={{ fill: "var(--box-gold)" }}
            />
            <path
              d="M84.5 26.2 L78.5 23.2 L35 45 L35 55 L41 58 L41 48 Z"
              style={{ fill: "var(--box-gold)" }}
              opacity={0.9}
            />
          </>
        ) : null}
        <path
          d="M16 46 L60 68 L104 46"
          style={{ fill: "none", stroke: v(kind, "edge") }}
          strokeOpacity={0.55}
          strokeWidth={sw}
        />
      </g>
      <path
        d="M16 36 L60 14 L104 36 L104 84 L60 106 L16 84 Z"
        style={{ fill: "none", stroke: v(kind, "edge") }}
        strokeWidth={sw}
        strokeLinejoin="round"
      />
      {kind === "rare" ? (
        <path
          d="M16 36 L60 14 L104 36 M60 58 L60 106"
          style={{ fill: "none", stroke: "var(--box-shine)" }}
          strokeOpacity={0.9}
          strokeWidth={small ? 1.2 : 1.6}
        />
      ) : null}
      {kind === "superrare" ? (
        <path
          d="M16 36 L60 14 L104 36 L104 84 L60 106 L16 84 Z M60 58 L60 106 M16 36 L60 58 L104 36"
          style={{ fill: "none", stroke: "var(--box-gold)" }}
          strokeWidth={1.6}
        />
      ) : null}
      {shiny ? (
        <g className="bx-shine" clipPath={`url(#${id}-clip)`}>
          <g className="bx-shine-bar" style={{ animationDuration: `${String(shineDur)}s` }}>
            <rect
              x={-60}
              y={0}
              width={26}
              height={120}
              style={{ fill: `url(#${id}-shine)` }}
              transform="skewX(-20)"
            />
          </g>
        </g>
      ) : null}
      {kind === "superrare" && !small ? (
        <>
          <Star x={104} y={16} s={5} delay={0} />
          <Star x={14} y={22} s={3.5} delay={0.7} />
          <Star x={110} y={64} s={3} delay={1.3} />
        </>
      ) : null}
    </svg>
  );
}
