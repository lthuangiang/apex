"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Biểu đồ SVG của Signal Analysis: vẽ đúng bề rộng khung (ResizeObserver) để chữ không co lại ở 390 px. Mỗi biểu đồ có
// role="img" + aria-label tóm tắt số chính; bảng số đi kèm nằm ngay dưới trong từng tab.

function useWidth(fallback = 600) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      const cw = e?.contentRect.width ?? 0;
      if (cw > 0) setW(cw);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);
  return { ref, w };
}

const niceStep = (span: number) => {
  const raw = span / 4;
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
};

function scale(values: number[], padZero = true) {
  let lo = Math.min(...values, padZero ? 0 : Infinity);
  let hi = Math.max(...values, padZero ? 0 : -Infinity);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = -1;
    hi = 1;
  }
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Number(t.toFixed(6)));
  return { lo, hi, ticks };
}

const tickText = (v: number) => (v < 0 ? `−${String(Math.abs(v))}` : String(v));

export interface LineSeries {
  key: string;
  values: (number | null)[];
  /** Lớp màu SVG (stroke-*). */
  stroke: string;
  dashed?: boolean;
  endLabel?: string;
}

export function LineChart({
  label,
  xLabels,
  series,
  band,
  refLine,
  unit = "bp",
}: {
  label: string;
  xLabels: readonly string[];
  series: readonly LineSeries[];
  band?: { lo: (number | null)[]; hi: (number | null)[] };
  refLine?: { value: number; label: string };
  unit?: string;
}) {
  const { ref, w } = useWidth();
  const narrow = w < 440;
  const H = narrow ? 220 : 250;
  const P = { l: 40, r: narrow ? 56 : 96, t: 16, b: 28 };
  const all = [
    ...series.flatMap((s) => s.values),
    ...(band?.lo ?? []),
    ...(band?.hi ?? []),
    ...(refLine === undefined ? [] : [refLine.value]),
  ].filter((v): v is number => v !== null);
  const { lo, hi, ticks } = scale(all);
  const n = xLabels.length;
  const x = (i: number) => P.l + (n <= 1 ? 0 : (i / (n - 1)) * (w - P.l - P.r));
  const y = (v: number) => P.t + ((hi - v) / (hi - lo)) * (H - P.t - P.b);
  const path = (vals: (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  const bandPts =
    band === undefined
      ? null
      : (() => {
          const idx = band.lo
            .map((v, i) => (v !== null && band.hi[i] !== null ? i : -1))
            .filter((i) => i >= 0);
          if (idx.length < 2) return null;
          const top = idx.map((i) => `${x(i).toFixed(1)},${y(band.hi[i] ?? 0).toFixed(1)}`);
          const bot = idx
            .map((i) => `${x(i).toFixed(1)},${y(band.lo[i] ?? 0).toFixed(1)}`)
            .reverse();
          return [...top, ...bot].join(" ");
        })();
  return (
    <div ref={ref} className="w-full">
      <svg role="img" aria-label={label} width={w} height={H} className="block">
        <rect
          x={P.l}
          y={P.t}
          width={Math.max(0, w - P.l - P.r)}
          height={H - P.t - P.b}
          className="fill-chart-bg"
        />
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={P.l}
              x2={w - P.r}
              y1={y(t)}
              y2={y(t)}
              className={t === 0 ? "stroke-ink-2" : "stroke-border"}
              strokeWidth={t === 0 ? 1.2 : 1}
            />
            <text x={P.l - 6} y={y(t) + 4} textAnchor="end" className="fill-muted text-[11px]">
              {tickText(t)}
            </text>
          </g>
        ))}
        <text x={P.l - 6} y={10} textAnchor="end" className="fill-muted text-[11px]">
          {unit}
        </text>
        {bandPts === null ? null : (
          <polygon points={bandPts} className="fill-mh-vol-1 opacity-70" />
        )}
        {refLine === undefined ? null : (
          <g>
            <line
              x1={P.l}
              x2={w - P.r}
              y1={y(refLine.value)}
              y2={y(refLine.value)}
              className="stroke-ink"
              strokeDasharray="3 3"
            />
            <text
              x={w - P.r + 4}
              y={y(refLine.value) + 4}
              className="fill-ink text-[11px] font-bold"
            >
              {refLine.label}
            </text>
          </g>
        )}
        {series.map((s) => (
          <g key={s.key}>
            <path
              d={path(s.values)}
              fill="none"
              strokeWidth={2.2}
              className={s.stroke}
              strokeDasharray={s.dashed === true ? "5 4" : undefined}
            />
            {s.values.map((v, i) =>
              v === null ? null : (
                <circle
                  key={i}
                  cx={x(i)}
                  cy={y(v)}
                  r={3.2}
                  className={`fill-surface ${s.stroke}`}
                  strokeWidth={2}
                />
              ),
            )}
            {s.endLabel === undefined
              ? null
              : (() => {
                  const lastI = s.values
                    .map((v, i) => (v === null ? -1 : i))
                    .filter((i) => i >= 0)
                    .at(-1);
                  if (lastI === undefined) return null;
                  return (
                    <text
                      x={x(lastI) + 7}
                      y={y(s.values[lastI] ?? 0) + 4}
                      className="fill-ink text-[11px] font-bold"
                    >
                      {s.endLabel}
                    </text>
                  );
                })()}
          </g>
        ))}
        {xLabels.map((l, i) => (
          <text key={l} x={x(i)} y={H - 8} textAnchor="middle" className="fill-muted text-[11px]">
            {l}
          </text>
        ))}
      </svg>
    </div>
  );
}

export interface StackRow {
  fees: number | null;
  markout: number | null;
  inventory: number | null;
  net: number | null;
  thin: boolean;
  tip: string;
}

/** Cột chồng phí / markout / tồn kho quanh $0, chấm = net cost; vạch trung bình và mốc (thay đổi đã ship / giờ UTC). */
export function StackColumns({
  label,
  rows,
  xLabel,
  avg,
  marks = [],
}: {
  label: string;
  rows: readonly StackRow[];
  xLabel: (i: number, narrow: boolean) => string;
  avg?: { value: number; label: string };
  marks?: readonly { i: number; label: string; tip: string }[];
}) {
  const { ref, w } = useWidth();
  const narrow = w < 440;
  const H = narrow ? 220 : 250;
  const P = { l: 46, r: 10, t: marks.length > 0 ? 34 : 14, b: 28 };
  const parts = (r: StackRow) => [r.fees ?? 0, r.markout ?? 0, r.inventory ?? 0];
  const vals = rows.flatMap((r) => {
    const p = parts(r);
    return [
      p.filter((v) => v > 0).reduce((a, b) => a + b, 0),
      p.filter((v) => v < 0).reduce((a, b) => a + b, 0),
      r.net ?? 0,
    ];
  });
  const { lo, hi, ticks } = scale([...vals, avg?.value ?? 0]);
  const cw = (w - P.l - P.r) / Math.max(1, rows.length);
  const bw = Math.max(3, Math.min(28, cw * 0.62));
  const y = (v: number) => P.t + ((hi - v) / (hi - lo)) * (H - P.t - P.b);
  const fills = ["fill-accent", "fill-warn-bar", "fill-mh-shock-3"];
  return (
    <div ref={ref} className="w-full">
      <svg role="img" aria-label={label} width={w} height={H} className="block">
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={P.l}
              x2={w - P.r}
              y1={y(t)}
              y2={y(t)}
              className={t === 0 ? "stroke-ink-2" : "stroke-border"}
            />
            <text x={P.l - 6} y={y(t) + 4} textAnchor="end" className="fill-muted text-[11px]">
              {t < 0 ? `−$${String(Math.abs(t))}` : `$${String(t)}`}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const cx = P.l + cw * i + cw / 2;
          let up = 0;
          let dn = 0;
          return (
            <g key={i} className={r.thin ? "opacity-45" : undefined}>
              <title>{r.tip}</title>
              <rect x={cx - cw / 2} y={P.t} width={cw} height={H - P.t - P.b} fill="transparent" />
              {parts(r).map((v, k) => {
                if (v === 0) return null;
                const a = v > 0 ? up : dn;
                const b = a + v;
                if (v > 0) up = b;
                else dn = b;
                return (
                  <rect
                    key={k}
                    x={cx - bw / 2}
                    y={y(Math.max(a, b))}
                    width={bw}
                    height={Math.max(0.5, Math.abs(y(a) - y(b)))}
                    className={fills[k]}
                  />
                );
              })}
              {r.net === null ? null : (
                <circle
                  cx={cx}
                  cy={y(r.net)}
                  r={3.4}
                  className="fill-ink stroke-surface"
                  strokeWidth={1.5}
                />
              )}
              <text x={cx} y={H - 8} textAnchor="middle" className="fill-muted text-[11px]">
                {xLabel(i, narrow)}
              </text>
            </g>
          );
        })}
        {avg === undefined ? null : (
          <g>
            <line
              x1={P.l}
              x2={w - P.r}
              y1={y(avg.value)}
              y2={y(avg.value)}
              className="stroke-ink-2"
              strokeDasharray="5 4"
            />
          </g>
        )}
        {marks.map((m, k) => {
          const cx = P.l + cw * m.i + cw / 2;
          return (
            <g key={k}>
              <title>{m.tip}</title>
              <line
                x1={cx}
                x2={cx}
                y1={P.t - 4}
                y2={H - P.b}
                className="stroke-ink-2"
                strokeDasharray="2 3"
              />
              <text
                x={cx - 4}
                y={k % 2 === 0 ? 12 : 26}
                textAnchor="end"
                className="fill-ink text-[11px] font-bold"
              >
                {m.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Cột (bp) có nhãn số, kèm chấm cho chuỗi thứ hai (what-if); nhãn trục hai dòng. */
export function BarsWithDots({
  label,
  cats,
  bars,
  dots,
}: {
  label: string;
  cats: readonly { label: string; sub: string; thin: boolean }[];
  bars: readonly (number | null)[];
  dots: readonly (number | null)[];
}) {
  const { ref, w } = useWidth();
  const narrow = w < 440;
  const H = narrow ? 230 : 262;
  const P = { l: 40, r: 8, t: 22, b: 46 };
  const { lo, hi, ticks } = scale([...bars, ...dots].filter((v): v is number => v !== null));
  const cw = (w - P.l - P.r) / Math.max(1, cats.length);
  const bw = Math.min(46, cw * 0.5);
  const y = (v: number) => P.t + ((hi - v) / (hi - lo)) * (H - P.t - P.b);
  return (
    <div ref={ref} className="w-full">
      <svg role="img" aria-label={label} width={w} height={H} className="block">
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={P.l}
              x2={w - P.r}
              y1={y(t)}
              y2={y(t)}
              className={t === 0 ? "stroke-ink-2" : "stroke-border"}
            />
            <text x={P.l - 6} y={y(t) + 4} textAnchor="end" className="fill-muted text-[11px]">
              {tickText(t)}
            </text>
          </g>
        ))}
        {cats.map((c, i) => {
          const cx = P.l + cw * i + cw / 2;
          const v = bars[i] ?? null;
          const d = dots[i] ?? null;
          return (
            <g key={c.label} className={c.thin ? "opacity-45" : undefined}>
              {v === null ? null : (
                <>
                  <rect
                    x={cx - bw / 2}
                    y={y(Math.max(0, v))}
                    width={bw}
                    height={Math.max(1, Math.abs(y(0) - y(v)))}
                    className={v >= 0 ? "fill-pos-dot" : "fill-neg"}
                  />
                  <text
                    x={cx}
                    y={v >= 0 ? y(v) - 5 : y(v) + 14}
                    textAnchor="middle"
                    className="fill-ink text-[11px] font-bold"
                  >
                    {v > 0 ? "+" : v < 0 ? "−" : ""}
                    {Math.abs(v).toFixed(1)}
                  </text>
                </>
              )}
              {d === null ? null : (
                <circle cx={cx + bw / 2 + 8} cy={y(d)} r={4.5} className="fill-warn-bar" />
              )}
              <text
                x={cx}
                y={H - 26}
                textAnchor="middle"
                className="fill-ink text-[11px] font-bold"
              >
                {c.label}
              </text>
              <text x={cx} y={H - 12} textAnchor="middle" className="fill-muted text-[11px]">
                {c.sub}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Cột nhóm theo hạng mục (spread kiếm được / giá chạy ngược / net sau phí). */
export function GroupedBars({
  label,
  cats,
  series,
}: {
  label: string;
  cats: readonly { label: string; sub: string; thin: boolean }[];
  series: readonly { key: string; values: readonly (number | null)[]; fill: string }[];
}) {
  const { ref, w } = useWidth();
  const narrow = w < 440;
  const H = narrow ? 250 : 276;
  const P = { l: 40, r: 10, t: 20, b: 48 };
  const { lo, hi, ticks } = scale(
    series.flatMap((s) => s.values).filter((v): v is number => v !== null),
  );
  const cw = (w - P.l - P.r) / Math.max(1, cats.length);
  const bw = Math.min(26, (cw * 0.7) / Math.max(1, series.length));
  const y = (v: number) => P.t + ((hi - v) / (hi - lo)) * (H - P.t - P.b);
  return (
    <div ref={ref} className="w-full">
      <svg role="img" aria-label={label} width={w} height={H} className="block">
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={P.l}
              x2={w - P.r}
              y1={y(t)}
              y2={y(t)}
              className={t === 0 ? "stroke-ink-2" : "stroke-border"}
            />
            <text x={P.l - 6} y={y(t) + 4} textAnchor="end" className="fill-muted text-[11px]">
              {tickText(t)}
            </text>
          </g>
        ))}
        {cats.map((c, i) => {
          const cx = P.l + cw * i + cw / 2;
          const x0 = cx - (bw * series.length) / 2;
          return (
            <g key={c.label} className={c.thin ? "opacity-45" : undefined}>
              {series.map((s, k) => {
                const v = s.values[i] ?? null;
                if (v === null) return null;
                return (
                  <g key={s.key}>
                    <rect
                      x={x0 + k * bw + 1}
                      y={y(Math.max(0, v))}
                      width={bw - 2}
                      height={Math.max(1, Math.abs(y(0) - y(v)))}
                      className={s.fill}
                    />
                    {narrow ? null : (
                      <text
                        x={x0 + k * bw + bw / 2}
                        y={v >= 0 ? y(v) - 4 : y(v) + 12}
                        textAnchor="middle"
                        className="fill-ink text-[11px] font-bold"
                      >
                        {v > 0 ? "+" : v < 0 ? "−" : ""}
                        {Math.abs(v).toFixed(1)}
                      </text>
                    )}
                  </g>
                );
              })}
              <text
                x={cx}
                y={H - 26}
                textAnchor="middle"
                className="fill-ink text-[11px] font-bold"
              >
                {c.label}
              </text>
              <text x={cx} y={H - 12} textAnchor="middle" className="fill-muted text-[11px]">
                {c.sub}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Giá quanh một lệnh (chi tiết): đường giá, vạch giá ngang, vùng thời gian tô màu. */
export function PriceLine({
  label,
  points,
  hlines,
  zones,
  marks,
  tickLabel,
}: {
  label: string;
  points: readonly { t: number; p: number }[];
  hlines: readonly { p: number; label: string; tone: string }[];
  zones: readonly { from: number; to: number; fill: string }[];
  marks: readonly { t: number; p: number; fill: string }[];
  tickLabel: (t: number) => string;
}) {
  const { ref, w } = useWidth(520);
  const H = 220;
  const P = { l: 70, r: 12, t: 14, b: 24 };
  if (points.length === 0) return null;
  const t0 = Math.min(...points.map((p) => p.t), ...zones.map((z) => z.from));
  const t1 = Math.max(...points.map((p) => p.t), ...zones.map((z) => z.to));
  const ps = [...points.map((p) => p.p), ...hlines.map((h) => h.p)];
  let lo = Math.min(...ps);
  let hi = Math.max(...ps);
  const pad = (hi - lo) * 0.12 || hi * 0.0005 || 1;
  lo -= pad;
  hi += pad;
  const x = (t: number) => P.l + ((t - t0) / (t1 - t0 || 1)) * (w - P.l - P.r);
  const y = (p: number) => P.t + ((hi - p) / (hi - lo)) * (H - P.t - P.b);
  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`)
    .join(" ");
  const ticks = Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * i) / 4);
  return (
    <div ref={ref} className="w-full">
      <svg role="img" aria-label={label} width={w} height={H} className="block">
        {zones.map((z, i) => (
          <rect
            key={i}
            x={x(z.from)}
            y={P.t}
            width={Math.max(1, x(z.to) - x(z.from))}
            height={H - P.t - P.b}
            className={z.fill}
          />
        ))}
        {hlines.map((h) => (
          <g key={h.label}>
            <line
              x1={P.l}
              x2={w - P.r}
              y1={y(h.p)}
              y2={y(h.p)}
              className={h.tone}
              strokeDasharray="4 3"
            />
            <text
              x={P.l - 6}
              y={y(h.p) + 4}
              textAnchor="end"
              className="fill-ink text-[11px] font-bold"
            >
              {h.label}
            </text>
          </g>
        ))}
        <path d={d} fill="none" strokeWidth={2} className="stroke-accent" />
        {marks.map((m, i) => (
          <circle key={i} cx={x(m.t)} cy={y(m.p)} r={4.5} className={m.fill} />
        ))}
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={H - 6} textAnchor="middle" className="fill-muted text-[11px]">
            {tickLabel(t)}
          </text>
        ))}
      </svg>
    </div>
  );
}

export function Legend({
  items,
}: {
  items: readonly { label: string; swatch: string; line?: boolean }[];
}): ReactNode {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <i
            aria-hidden="true"
            className={`inline-block ${it.line === true ? "h-0.5 w-4" : "size-2.5 rounded-[3px]"} ${it.swatch}`}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}
