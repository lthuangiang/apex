"use client";

import { useState } from "react";

import { niceTicks } from "@/lib/nice-ticks";

// Đường equity dạng SVG (không thư viện): đường nét liền = equity; kèm bảng cùng chuỗi cho trình đọc màn hình.

export function LineChart({
  points,
  label,
}: {
  points: readonly { at: number; value: number }[];
  label: string;
}) {
  if (points.length < 2) return null;
  const xs = points.map((p) => p.at);
  const ys = points.map((p) => p.value);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const W = 600;
  const H = 180;
  const sx = (x: number) => ((x - x0) / (x1 - x0 || 1)) * W;
  const sy = (y: number) => H - ((y - y0) / (y1 - y0 || 1)) * (H - 10) - 5;
  return (
    <svg
      viewBox={`0 0 ${String(W)} ${String(H)}`}
      className="h-44 w-full text-accent"
      role="img"
      aria-label={label}
    >
      <polyline
        points={points.map((p) => `${sx(p.at).toFixed(1)},${sy(p.value).toFixed(1)}`).join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

/** Thanh tỷ lệ ngang; phần short vẽ sọc (không chỉ dựa vào màu, mục 9.4). */
export function ShareBar({ value, max, short }: { value: number; max: number; short: boolean }) {
  const w = max <= 0 ? 0 : Math.max(2, (value / max) * 100);
  return (
    <div className="h-3 w-full overflow-hidden rounded-full bg-bg">
      <div
        className={`h-3 rounded-full ${short ? "bg-warn-bar" : "bg-accent"}`}
        style={{
          width: `${w.toFixed(1)}%`,
          ...(short
            ? {
                backgroundImage:
                  "repeating-linear-gradient(45deg, transparent 0 4px, var(--color-surface) 4px 8px)",
              }
            : {}),
        }}
      />
    </div>
  );
}

/**
 * Thanh tiến độ của một giới hạn / tỷ lệ (artboard Portfolio "Margin in use", Risk "Limits"). `pct` 0–100;
 * `tone` "warn" khi gần ngưỡng (cam), "muted" khi chưa đặt giới hạn (xám). `label` cho trình đọc màn hình.
 */
export function Meter({
  pct,
  tone = "normal",
  label,
  size = "sm",
}: {
  pct: number | null;
  tone?: "normal" | "warn" | "muted";
  label: string;
  size?: "sm" | "md";
}) {
  const w = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  const h = size === "md" ? "h-2" : "h-1.5";
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(w)}
      className={`${h} w-full overflow-hidden rounded-full bg-bg`}
    >
      {pct === null ? null : (
        <div
          className={`${h} rounded-full ${tone === "warn" ? "bg-warn-bar" : tone === "muted" ? "bg-border-input" : "bg-accent"}`}
          style={{ width: `${w.toFixed(1)}%` }}
        />
      )}
    </div>
  );
}

/**
 * Biểu đồ equity (artboard Main › Performance): trục Y (4 mốc), trục X (5 mốc thời gian), vùng tô dưới đường,
 * tooltip khi rê chuột / chạm. `formatY` / `formatX` do trang truyền (định dạng tiền / giờ). Có bảng cùng chuỗi
 * ở "View as table" cho trình đọc màn hình.
 */
export function EquityChart({
  points,
  label,
  formatY,
  formatX,
  formatTip,
}: {
  points: readonly { at: number; value: number }[];
  label: string;
  /** `decimals`: số chữ số thập phân chung của các vạch (niceTicks). */
  formatY: (v: number, decimals: number) => string;
  formatX: (at: number) => string;
  formatTip: (p: { at: number; value: number }) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return null;
  const xs = points.map((p) => p.at);
  const ys = points.map((p) => p.value);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  // Trục Y là vạch "đẹp" bao trọn dữ liệu (UI_REVIEW J1), không chia đều từ min / max.
  const nice = niceTicks(Math.min(...ys), Math.max(...ys));
  const [y0, y1] = [nice.ticks[0] ?? 0, nice.ticks.at(-1) ?? 1];
  const W = 640;
  const H = 200;
  const L = 56;
  const B = 24;
  const sx = (x: number) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - 8);
  const sy = (y: number) => 8 + (1 - (y - y0) / (y1 - y0 || 1)) * (H - B - 16);
  const line = points.map((p) => `${sx(p.at).toFixed(1)},${sy(p.value).toFixed(1)}`).join(" ");
  const yTicks = nice.ticks;
  const xTicks = [0, 1, 2, 3, 4].map((i) => x0 + ((x1 - x0) * i) / 4);
  const h = hover === null ? null : points[hover];
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        className="h-52 w-full touch-none text-accent"
        role="img"
        aria-label={label}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * W;
          let best = 0;
          points.forEach((p, i) => {
            if (Math.abs(sx(p.at) - x) < Math.abs(sx(points[best]?.at ?? 0) - x)) best = i;
          });
          setHover(best);
        }}
        onPointerLeave={() => {
          setHover(null);
        }}
      >
        <defs>
          <linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={L}
              x2={W - 8}
              y1={sy(v)}
              y2={sy(v)}
              className="stroke-border"
              strokeWidth="1"
            />
            <text x={L - 8} y={sy(v) + 4} textAnchor="end" className="fill-muted text-[11px]">
              {formatY(v, nice.decimals)}
            </text>
          </g>
        ))}
        {xTicks.map((x, i) => (
          <text
            key={x}
            x={sx(x)}
            y={H - 4}
            textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}
            className="fill-muted text-[11px]"
          >
            {formatX(x)}
          </text>
        ))}
        <polygon
          points={`${line} ${sx(x1).toFixed(1)},${String(H - B)} ${sx(x0).toFixed(1)},${String(H - B)}`}
          fill="url(#eq-fill)"
        />
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        {h === null || h === undefined ? null : (
          <g>
            <line
              x1={sx(h.at)}
              x2={sx(h.at)}
              y1={8}
              y2={H - B}
              className="stroke-border-input"
              strokeDasharray="3 3"
            />
            <circle
              cx={sx(h.at)}
              cy={sy(h.value)}
              r="5"
              fill="currentColor"
              className="stroke-surface"
              strokeWidth="2"
            />
          </g>
        )}
      </svg>
      {h === null || h === undefined ? null : (
        <div
          role="status"
          className="pointer-events-none absolute top-0 rounded-control bg-ink px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap text-surface tabular-nums"
          style={{
            left: `${((sx(h.at) / W) * 100).toFixed(1)}%`,
            transform: sx(h.at) > W / 2 ? "translateX(-105%)" : "translateX(5%)",
          }}
        >
          {formatTip(h)}
        </div>
      )}
    </div>
  );
}

/** Sparkline 24h (artboard Main › Watchlist): đỏ khi giảm, xanh khi tăng. */
export function Sparkline({ values, up }: { values: readonly number[]; up: boolean }) {
  if (values.length < 2) return null;
  const [y0, y1] = [Math.min(...values), Math.max(...values)];
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 72;
      const y = 26 - ((v - y0) / (y1 - y0 || 1)) * 24;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width="60"
      height="26"
      viewBox="0 0 72 28"
      fill="none"
      aria-hidden="true"
      className="flex-none"
    >
      <polyline
        points={pts}
        className={up ? "stroke-pos" : "stroke-neg"}
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
