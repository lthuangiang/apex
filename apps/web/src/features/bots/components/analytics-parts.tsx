"use client";

import {
  ANALYTICS_PERIODS,
  tradeDetailSchema,
  type AnalyticsPeriod,
  type AnalyticsTrade,
} from "@drift/shared";
import { BottomSheet } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { api } from "@/lib/api";

// Phần dùng chung của Strategy Analytics (DEC-141): định dạng số, bộ chọn kỳ, biểu đồ SVG nhỏ (vẽ theo bề rộng thật để
// chữ không phóng to), và bảng chi tiết một lượt (Trade Detail).

export const usd = (v: number, dp = 4) =>
  `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: Math.abs(v) >= 1 ? 2 : dp,
    maximumFractionDigits: Math.abs(v) >= 1 ? 2 : dp,
  })}`;
export const pctText = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);
export const tone = (v: number) => (v > 0 ? "text-pos" : v < 0 ? "text-neg-ink" : "text-ink");
export function holdText(secs: number): string {
  if (secs < 60) return `${String(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s === 0 ? `${String(m)}m` : `${String(m)}m ${String(s)}s`;
}
export const timeText = (ms: number) =>
  new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

export function PeriodTabs({
  value,
  onChange,
}: {
  value: AnalyticsPeriod;
  onChange: (p: AnalyticsPeriod) => void;
}) {
  const t = useTranslations("agent.sa");
  return (
    <div
      role="tablist"
      aria-label={t("periodLabel")}
      className="flex gap-1 rounded-[14px] bg-surface-2 p-1"
    >
      {ANALYTICS_PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          role="tab"
          aria-selected={p === value}
          onClick={() => {
            onChange(p);
          }}
          className={`min-h-9 rounded-[10px] px-3 text-[13px] font-bold whitespace-nowrap transition-colors ${
            p === value ? "bg-ink text-surface" : "text-ink-2 hover:text-ink"
          }`}
        >
          {t(`period.${p}`)}
        </button>
      ))}
    </div>
  );
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const ro = new ResizeObserver((e) => {
      const cw = e[0]?.contentRect.width;
      if (cw !== undefined && cw > 0) setW(Math.max(240, Math.round(cw)));
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);
  return [ref, w] as const;
}

/** Đường giá trị theo thời gian (đường lãi ròng cộng dồn), tô vùng dưới, vạch 0. */
export function AreaLine({
  points,
  height = 180,
  label,
}: {
  points: readonly { t: number; v: number }[];
  height?: number;
  label: string;
}) {
  const [ref, w] = useWidth();
  const id = useId();
  if (points.length < 2)
    return (
      <div
        ref={ref}
        className="flex items-center justify-center text-sm text-muted"
        style={{ height }}
      >
        —
      </div>
    );
  const P = { l: 52, r: 10, t: 10, b: 22 };
  const vs = points.map((p) => p.v);
  let min = Math.min(0, ...vs);
  let max = Math.max(0, ...vs);
  if (max === min) max = min + 1;
  const pad = (max - min) * 0.08;
  min -= pad;
  max += pad;
  const t0 = points[0]?.t ?? 0;
  const t1 = points.at(-1)?.t ?? 1;
  const x = (t: number) => P.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - P.l - P.r);
  const y = (v: number) => P.t + (1 - (v - min) / (max - min)) * (height - P.t - P.b);
  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join(" ");
  const last = points.at(-1)?.v ?? 0;
  const color = last >= 0 ? "#16a05a" : "#c2312f";
  const area = `${line} L${x(t1).toFixed(1)},${y(0).toFixed(1)} L${x(t0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const ticks = [max - pad, (max + min) / 2, min + pad];
  const d = (ms: number) =>
    new Date(ms).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  return (
    <div ref={ref} className="min-w-0">
      <svg width={w} height={height} className="block max-w-full" role="img" aria-label={label}>
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={P.l} x2={w - P.r} y1={y(v)} y2={y(v)} stroke="#e3e7f5" />
            <text x={P.l - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#5f6684">
              {usd(v)}
            </text>
          </g>
        ))}
        <line x1={P.l} x2={w - P.r} y1={y(0)} y2={y(0)} stroke="#9aa1bd" strokeDasharray="4 4" />
        <path d={area} fill={`url(#${id})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" />
        <text x={P.l} y={height - 4} fontSize="11" fill="#5f6684">
          {d(t0)}
        </text>
        <text x={w - P.r} y={height - 4} fontSize="11" fill="#5f6684" textAnchor="end">
          {d(t1)}
        </text>
      </svg>
    </div>
  );
}

/** Cột theo nhóm (khoảng giữ lệnh); cột được chọn tô xanh lá, bấm được. */
export function GroupBars({
  items,
  height = 180,
  label,
  format,
  selected,
  onPick,
}: {
  items: readonly { key: string; label: string; value: number | null; sub?: string }[];
  height?: number;
  label: string;
  format: (v: number) => string;
  selected?: string | null;
  onPick?: (key: string) => void;
}) {
  const [ref, w] = useWidth();
  const vals = items.map((i) => i.value ?? 0);
  const max = Math.max(0, ...vals);
  const min = Math.min(0, ...vals);
  const span = max - min || 1;
  const P = { t: 22, b: 34 };
  const slot = w / Math.max(1, items.length);
  const bw = Math.min(64, slot * 0.6);
  const y = (v: number) => P.t + ((max - v) / span) * (height - P.t - P.b);
  return (
    <div ref={ref} className="min-w-0">
      <svg width={w} height={height} className="block max-w-full" role="img" aria-label={label}>
        <line x1={0} x2={w} y1={y(0)} y2={y(0)} stroke="#e3e7f5" />
        {items.map((it, i) => {
          const v = it.value;
          const cx = slot * i + slot / 2;
          const on = selected === it.key;
          const top = v === null ? y(0) : Math.min(y(v), y(0));
          const h = v === null ? 0 : Math.max(2, Math.abs(y(v) - y(0)));
          const fill = on ? "#16a05a" : v !== null && v < 0 ? "#f2a19b" : "#9db6f5";
          return (
            <g
              key={it.key}
              onClick={
                onPick === undefined
                  ? undefined
                  : () => {
                      onPick(it.key);
                    }
              }
              style={{ cursor: onPick === undefined ? "default" : "pointer" }}
            >
              <rect x={cx - bw / 2} y={top} width={bw} height={h} rx="6" fill={fill} />
              <text
                x={cx}
                y={top - 6}
                textAnchor="middle"
                fontSize="12"
                fontWeight="700"
                fill="#141a33"
              >
                {v === null ? "—" : format(v)}
              </text>
              <text x={cx} y={height - 16} textAnchor="middle" fontSize="12" fill="#3b4262">
                {it.label}
              </text>
              {it.sub === undefined ? null : (
                <text x={cx} y={height - 3} textAnchor="middle" fontSize="10" fill="#5f6684">
                  {it.sub}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted">{label}</span>
      <strong className={`text-lg font-extrabold tabular-nums ${valueClass ?? ""}`}>{value}</strong>
      {sub === undefined ? null : <span className="text-[11px] text-muted">{sub}</span>}
    </div>
  );
}

/** Giá quanh lượt: đường giá đóng nến 1 phút, vạch giá vào / ra, vùng thời gian giữ lệnh. */
function PriceChart({
  candles,
  trade,
}: {
  candles: readonly { t: number; h: number; l: number; c: number }[];
  trade: AnalyticsTrade;
}) {
  const t = useTranslations("agent.sa.detail");
  const [ref, w] = useWidth();
  if (candles.length < 2) return <p className="m-0 text-sm text-muted">{t("noCandles")}</p>;
  const H = 200;
  const P = { l: 64, r: 10, t: 10, b: 20 };
  const lo = Math.min(...candles.map((k) => k.l), trade.entry, trade.exit);
  const hi = Math.max(...candles.map((k) => k.h), trade.entry, trade.exit);
  const span = hi - lo || 1;
  const t0 = candles[0]?.t ?? 0;
  const t1 = (candles.at(-1)?.t ?? 1) + 60_000;
  const x = (ms: number) => P.l + ((ms - t0) / (t1 - t0)) * (w - P.l - P.r);
  const y = (v: number) => P.t + ((hi - v) / span) * (H - P.t - P.b);
  const path = candles
    .map((k, i) => `${i === 0 ? "M" : "L"}${x(k.t + 30_000).toFixed(1)},${y(k.c).toFixed(1)}`)
    .join(" ");
  const hl = candles.map((k) => (
    <line
      key={k.t}
      x1={x(k.t + 30_000)}
      x2={x(k.t + 30_000)}
      y1={y(k.h)}
      y2={y(k.l)}
      stroke="#c9d3f2"
      strokeWidth="3"
    />
  ));
  return (
    <div ref={ref} className="min-w-0">
      <svg width={w} height={H} className="block max-w-full" role="img" aria-label={t("chart")}>
        <rect
          x={x(trade.openedAt)}
          y={P.t}
          width={Math.max(2, x(trade.closedAt) - x(trade.openedAt))}
          height={H - P.t - P.b}
          fill="#e6ecfe"
        />
        {hl}
        <path d={path} fill="none" stroke="#2e62e8" strokeWidth="1.8" />
        {[
          { v: trade.entry, c: "#141a33", l: t("entryAt", { p: trade.entry }) },
          {
            v: trade.exit,
            c: trade.net >= 0 ? "#16a05a" : "#c2312f",
            l: t("exitAt", { p: trade.exit }),
          },
        ].map((m) => (
          <g key={m.l}>
            <line
              x1={P.l}
              x2={w - P.r}
              y1={y(m.v)}
              y2={y(m.v)}
              stroke={m.c}
              strokeDasharray="5 4"
            />
            <text
              x={P.l - 6}
              y={y(m.v) + 4}
              textAnchor="end"
              fontSize="11"
              fontWeight="700"
              fill={m.c}
            >
              {m.v.toLocaleString("en-US")}
            </text>
          </g>
        ))}
        <circle cx={x(trade.openedAt)} cy={y(trade.entry)} r="5" fill="#141a33" />
        <circle
          cx={x(trade.closedAt)}
          cy={y(trade.exit)}
          r="5"
          fill={trade.net >= 0 ? "#16a05a" : "#c2312f"}
        />
      </svg>
    </div>
  );
}

/** Chi tiết một lượt (DEC-141): giá vào / ra, dòng thời gian lệnh, MFE / MAE, PnL, điều kiện lúc vào, version. */
export function TradeDetailSheet({
  botId,
  tradeKey,
  onClose,
}: {
  botId: string;
  tradeKey: string | null;
  onClose: () => void;
}) {
  const t = useTranslations("agent.sa.detail");
  const te = useTranslations("agent.sa.exit");
  const q = useQuery({
    queryKey: ["trade-detail", botId, tradeKey],
    queryFn: () =>
      api("GET", `/api/v1/bots/${botId}/analytics/trades/${tradeKey ?? ""}`, tradeDetailSchema),
    enabled: tradeKey !== null,
  });
  const d = q.data;
  const tr = d?.trade;
  interface Row {
    at: number;
    text: string;
    tone?: string | undefined;
  }
  const timeline: Row[] =
    d === undefined
      ? []
      : [
          ...(d.enter === null
            ? []
            : [{ at: d.enter.at, text: `${d.enter.decision}: ${d.enter.why}` }]),
          ...d.orders.map((o) => ({
            at: o.at,
            text: t("orderLine", {
              tag: o.tag,
              side: o.side,
              type: o.type,
              price: o.price === null ? "market" : Number(o.price).toLocaleString("en-US"),
              status: o.status + (o.rejectCode === null ? "" : ` (${o.rejectCode})`),
            }),
            tone: o.status === "rejected" ? "text-neg-ink" : undefined,
          })),
          ...d.fills.map((f) => ({
            at: f.at,
            text: t("fillLine", {
              side: f.side,
              price: f.price,
              size: f.size,
              fee: f.fee.toFixed(4),
              liq: f.maker ? "maker" : "taker",
            }),
            tone: "text-pos",
          })),
          ...(d.closed === null
            ? []
            : [{ at: d.closed.at, text: `${d.closed.decision}: ${d.closed.why}` }]),
        ].sort((a, b) => a.at - b.at);
  return (
    <BottomSheet
      open={tradeKey !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={
        tr === undefined ? t("title") : t("titleOf", { side: tr.side, time: timeText(tr.openedAt) })
      }
      description={t("description")}
    >
      {d === undefined || tr === undefined ? (
        <p className="m-0 text-sm text-muted">{q.isError ? t("error") : t("loading")}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label={t("entry")}
              value={tr.entry.toLocaleString("en-US")}
              sub={timeText(tr.openedAt)}
            />
            <Stat
              label={t("exit")}
              value={tr.exit.toLocaleString("en-US")}
              sub={timeText(tr.closedAt)}
            />
            <Stat label={t("hold")} value={holdText(tr.holdSecs)} sub={te(tr.exitReason)} />
            <Stat
              label={t("net")}
              value={usd(tr.net)}
              valueClass={tone(tr.net)}
              sub={t("netSub", { notional: tr.notional.toFixed(2) })}
            />
          </div>
          <PriceChart candles={d.candles} trade={tr} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t("gross")} value={usd(tr.gross)} valueClass={tone(tr.gross)} />
            <Stat label={t("fees")} value={usd(-tr.fees)} valueClass="text-neg-ink" />
            <Stat
              label={t("mfe")}
              value={tr.mfePct === null ? "—" : `${tr.mfePct.toFixed(3)}%`}
              sub={t("mfeSub")}
            />
            <Stat
              label={t("mae")}
              value={tr.maePct === null ? "—" : `${tr.maePct.toFixed(3)}%`}
              sub={t("maeSub")}
            />
          </div>
          {d.enter === null ? null : (
            <div className="rounded-[12px] bg-surface-2 px-3 py-2 text-sm">
              <strong className="text-xs text-muted">{t("condition")}</strong>
              <p className="m-0 text-ink-2">{d.enter.why}</p>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <h3 className="m-0 text-sm font-extrabold">{t("timeline")}</h3>
            <ol className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
              {timeline.map((r, i) => (
                <li
                  key={`${String(r.at)}-${String(i)}`}
                  className="grid grid-cols-[150px_minmax(0,1fr)] gap-2"
                >
                  <span className="text-muted tabular-nums">{timeText(r.at)}</span>
                  <span className={r.tone ?? "text-ink-2"}>{r.text}</span>
                </li>
              ))}
            </ol>
          </div>
          {d.config === null ? null : (
            <details className="rounded-[12px] border border-border px-3 py-2">
              <summary className="cursor-pointer text-sm font-bold">
                {t("version", { v: d.config.version })}
              </summary>
              <pre className="m-0 mt-2 overflow-x-auto text-xs text-ink-2">
                {JSON.stringify(d.config.config, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </BottomSheet>
  );
}
