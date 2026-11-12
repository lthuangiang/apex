"use client";

import {
  type BotDetail,
  VOLUME_PERIODS,
  volumeAnalyticsSchema,
  type VolumeAnalytics,
  type VolumePeriod,
} from "@drift/shared";
import { Skeleton } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  CircleDollarSign,
  Gauge,
  Layers,
  Percent,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { api } from "@/lib/api";
import { formatAmount } from "@/lib/format";

import { VolumeShare } from "./volume-share";

// Bảng Volume của Volume Builder (DEC-128): KPI · biểu đồ · cơ cấu volume · cơ cấu chi phí · chất lượng khớp lệnh.
// Mọi số đến từ fill / lệnh / Decisions thật của bot; không có số nào ước tính.

const num = (v: string | null | undefined) => (v == null ? 0 : Number(v) || 0);
const money = (v: number | string, dp?: number) =>
  formatAmount(dp === undefined ? String(v) : Number(v).toFixed(dp), null)?.text ?? String(v);
const signed = (x: number, dp?: number) =>
  `${x > 0 ? "+" : x < 0 ? "−" : ""}${money(Math.abs(x), dp)}`;

type ChartTab = "volume" | "maker" | "fees" | "pnl";

export function VolumeDashboard({
  botId,
  botName,
  market,
  vf,
}: {
  botId: string;
  botName: string;
  market: string;
  vf: NonNullable<BotDetail["volumeFarm"]>;
}) {
  const t = useTranslations("agent.vd");
  const strategyName = useTranslations("createBot.strategies")("volume_farm.name");
  const [period, setPeriod] = useState<VolumePeriod>("session");
  const q = useQuery({
    queryKey: ["volume-analytics", botId, period],
    queryFn: () =>
      api("GET", `/api/v1/bots/${botId}/volume-analytics?period=${period}`, volumeAnalyticsSchema),
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  });
  const a = q.data;

  return (
    <section
      aria-labelledby="vd-title"
      className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-10 items-center justify-center rounded-[12px] bg-accent-tint text-accent"
          >
            <BarChart3 size={20} strokeWidth={2.4} />
          </span>
          <div className="flex flex-col">
            <h2 id="vd-title" className="m-0 text-lg font-extrabold">
              {t("title")}
            </h2>
            <span className="text-xs text-muted">{t("subtitle")}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodTabs value={period} onChange={setPeriod} />
          {/* Share dùng đúng kỳ đang chọn và đúng số của các thẻ bên dưới (DEC-151). */}
          {a === undefined || a.totals.trades === 0 ? null : (
            <VolumeShare
              data={{
                botName,
                market,
                strategyName,
                ...shareNumbers(a),
                period: t("sharePeriod", { p: t(`tab.${period}`) }),
              }}
            />
          )}
        </div>
      </header>

      {a === undefined ? (
        <div className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-tile" />
          ))}
        </div>
      ) : (
        <Body a={a} vf={vf} period={period} />
      )}
    </section>
  );
}

/** Số cho ảnh Share: cùng công thức với các thẻ KPI (Body), theo kỳ đang chọn. */
function shareNumbers(a: VolumeAnalytics) {
  const volume = Number(a.totals.volume);
  const net = Number(a.totals.net);
  return {
    volume: volume.toFixed(2),
    net: net.toFixed(4),
    costPerMillion: volume > 0 ? ((Math.max(0, -net) / volume) * 1_000_000).toFixed(2) : null,
    trades: a.totals.trades,
    makerSharePct: volume > 0 ? ((Number(a.totals.maker) / volume) * 100).toFixed(1) : null,
  };
}

function PeriodTabs({
  value,
  onChange,
}: {
  value: VolumePeriod;
  onChange: (p: VolumePeriod) => void;
}) {
  const t = useTranslations("agent.vd");
  return (
    <div
      role="tablist"
      aria-label={t("periodLabel")}
      className="flex gap-1 rounded-[14px] bg-surface-2 p-1"
    >
      {VOLUME_PERIODS.map((p) => (
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
          {t(`tab.${p}`)}
        </button>
      ))}
    </div>
  );
}

function Body({
  a,
  vf,
  period,
}: {
  a: VolumeAnalytics;
  vf: NonNullable<BotDetail["volumeFarm"]>;
  period: VolumePeriod;
}) {
  const t = useTranslations("agent.vd");
  const tot = a.totals;
  const volume = num(tot.volume);
  const net = num(tot.net);
  const fees = num(tot.fees);
  const builder = num(tot.builderFees);
  const sodex = Math.max(0, fees - builder);
  const funding = period === "session" ? num(vf.session.funding) : 0;
  const pricePnl = net + fees + funding;
  const cpm = volume > 0 ? (Math.max(0, -net) / volume) * 1_000_000 : null;
  const makerPct = volume > 0 ? (num(tot.maker) / volume) * 100 : null;
  const target = period === "session" && vf.volumeTarget !== null ? num(vf.volumeTarget) : null;
  const targetPct = target !== null && target > 0 ? (volume / target) * 100 : null;
  const hours = Math.max(1 / 60, (Date.parse(a.to) - Date.parse(a.from)) / 3_600_000);

  const vol = a.series.map((x) => num(x.volume));
  const cumVol = cumulative(vol);
  const makerShareSeries = a.series.map((x) =>
    num(x.volume) > 0 ? num(x.maker) / num(x.volume) : NaN,
  );
  const cumNet = cumulative(a.series.map((x) => num(x.net)));
  const cumFees = cumulative(a.series.map((x) => num(x.fees)));
  const per1m = (v: number) =>
    volume > 0 ? `${money((Math.abs(v) / volume) * 1_000_000, 2)} / $1M` : "—";

  return (
    <>
      {/* KPI */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
        <Kpi
          icon={<BarChart3 size={18} strokeWidth={2.4} />}
          tone="accent"
          label={t("kpiVolume")}
          value={money(volume, 2)}
          unit="USDC"
          badge={targetPct === null ? null : `${targetPct.toFixed(1)}%`}
          sub={target === null ? t("kpiVolumeSub") : t("kpiTarget", { target: money(target) })}
          spark={cumVol}
          sparkTone="accent"
        />
        <Kpi
          icon={<CircleDollarSign size={18} strokeWidth={2.4} />}
          tone="pos"
          label={t("kpiCpm")}
          value={cpm === null ? "—" : `$${money(cpm, 2)}`}
          sub={t("kpiCpmSub")}
          spark={cumFees}
          sparkTone="pos"
        />
        <Kpi
          icon={<TrendingUp size={18} strokeWidth={2.4} />}
          tone={net < 0 ? "neg" : "pos"}
          label={t("kpiNet")}
          value={signed(net, 4)}
          unit="USDC"
          valueTone={net < 0 ? "neg" : "pos"}
          sub={t("kpiNetSub", { trades: tot.trades })}
          spark={cumNet}
          sparkTone={net < 0 ? "neg" : "pos"}
        />
        <Kpi
          icon={<Percent size={18} strokeWidth={2.4} />}
          tone="violet"
          label={t("kpiMaker")}
          value={makerPct === null ? "—" : `${makerPct.toFixed(1)}%`}
          sub={t("kpiMakerSub")}
          spark={makerShareSeries}
          sparkTone="violet"
        />
      </div>

      {/* Biểu đồ + cơ cấu volume */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <ChartCard
          a={a}
          cumVol={cumVol}
          cumFees={cumFees}
          cumNet={cumNet}
          target={target}
          targetPct={targetPct}
        />
        <BreakdownCard volume={volume} buy={num(tot.buy)} maker={num(tot.maker)} />
      </div>

      {/* Chi phí + chất lượng khớp */}
      <div className="grid gap-3 xl:grid-cols-2">
        <Panel icon={<Layers size={18} strokeWidth={2.4} />} title={t("costTitle")}>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-tile bg-border sm:grid-cols-4">
            <Cell label={t("sodexFee")} value={signed(-sodex, 4)} sub={per1m(sodex)} />
            <Cell label={t("builderFee")} value={signed(-builder, 4)} sub={per1m(builder)} />
            <Cell
              label={t("funding")}
              value={period === "session" ? signed(-funding, 4) : "—"}
              sub={period === "session" ? per1m(funding) : t("fundingSessionOnly")}
            />
            <Cell
              label={t("pricePnl")}
              value={signed(pricePnl, 4)}
              tone={pricePnl < 0 ? "neg" : pricePnl > 0 ? "pos" : undefined}
              sub={per1m(pricePnl)}
            />
          </div>
        </Panel>
        <Panel icon={<ShieldCheck size={18} strokeWidth={2.4} />} title={t("execTitle")}>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-tile bg-border sm:grid-cols-4">
            <Cell
              label={t("winRate")}
              value={tot.trades === 0 ? "—" : `${((tot.wins / tot.trades) * 100).toFixed(1)}%`}
              sub={t("winRateSub", { wins: tot.wins, trades: tot.trades })}
            />
            <Cell
              label={t("fillRatio")}
              value={
                tot.ordersPlaced === 0
                  ? "—"
                  : `${((tot.ordersFilled / tot.ordersPlaced) * 100).toFixed(0)}%`
              }
              sub={t("fillRatioSub", { filled: tot.ordersFilled, placed: tot.ordersPlaced })}
            />
            <Cell label={t("rejected")} value={String(tot.ordersRejected)} sub={t("rejectedSub")} />
            <Cell
              label={t("tradesPerHour")}
              value={(tot.trades / hours).toFixed(1)}
              sub={t("tradesPerHourSub")}
            />
          </div>
        </Panel>
      </div>

      {/* Footer */}
      <footer className="flex flex-wrap items-center justify-between gap-3 rounded-tile bg-surface-2 px-4 py-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Gauge aria-hidden="true" size={16} className="text-accent" />
          <strong className="font-bold">{t("footerNet")}</strong>
          <span className={`font-extrabold tabular-nums ${net < 0 ? "text-neg-ink" : "text-pos"}`}>
            {signed(net, 4)} USDC
          </span>
          <span className="text-xs text-muted">· {t("footerNote")}</span>
        </div>
        <a
          href="#fills-title"
          className="rounded-control bg-surface px-3.5 py-2 text-[13px] font-bold text-accent-ink no-underline ring-1 ring-border"
        >
          {t("viewFills")}
        </a>
      </footer>
    </>
  );
}

function cumulative(xs: number[]): number[] {
  let s = 0;
  return xs.map((x) => (s += x));
}

const TONE: Record<string, { chip: string; stroke: string; fill: string; text: string }> = {
  accent: {
    chip: "bg-accent-tint text-accent",
    stroke: "#2e62e8",
    fill: "#2e62e8",
    text: "text-ink",
  },
  pos: { chip: "bg-pos-bg text-pos", stroke: "#16a05a", fill: "#16a05a", text: "text-pos" },
  neg: { chip: "bg-neg-bg text-neg", stroke: "#c2312f", fill: "#c2312f", text: "text-neg-ink" },
  violet: {
    chip: "bg-unknown-bg text-unknown",
    stroke: "#7c5cd6",
    fill: "#7c5cd6",
    text: "text-ink",
  },
};

function Kpi({
  icon,
  tone,
  label,
  value,
  unit,
  badge,
  sub,
  spark,
  sparkTone,
  valueTone,
}: {
  icon: ReactNode;
  tone: keyof typeof TONE;
  label: string;
  value: string;
  unit?: string;
  badge?: string | null;
  sub: string;
  spark: number[];
  sparkTone: keyof typeof TONE;
  valueTone?: "pos" | "neg";
}) {
  const tn = TONE[tone] ?? TONE.accent;
  return (
    <div className="relative flex min-h-[118px] min-w-0 flex-col gap-1.5 overflow-hidden rounded-tile border border-border bg-surface p-3.5 shadow-[0_1px_2px_rgba(20,26,51,0.04)] sm:p-4">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className={`flex size-8 items-center justify-center rounded-full ${tn?.chip ?? ""}`}
        >
          {icon}
        </span>
        <span className="min-w-0 text-[12px] leading-tight font-semibold text-ink-2 sm:text-[13px]">
          {label}
        </span>
      </div>
      <strong
        className={`relative z-[1] text-[21px] leading-tight font-extrabold tracking-tight tabular-nums sm:text-[26px] ${
          valueTone === "neg" ? "text-neg-ink" : valueTone === "pos" ? "text-pos" : "text-ink"
        }`}
      >
        {value}
        {unit === undefined ? null : (
          <span className="ml-1 text-xs font-semibold text-muted">{unit}</span>
        )}
      </strong>
      <span className="relative z-[1] flex flex-wrap items-center gap-1.5 text-xs text-muted">
        {sub}
        {badge == null ? null : (
          <span className="rounded-full bg-pos-bg px-2 py-0.5 text-[11px] font-bold text-pos tabular-nums">
            {badge}
          </span>
        )}
      </span>
      <Sparkline values={spark} color={(TONE[sparkTone] ?? TONE.accent)?.stroke ?? "#2e62e8"} />
    </div>
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const id = useId();
  const pts = values.map((v, i) => [i, v] as const).filter(([, v]) => Number.isFinite(v));
  if (pts.length < 2) return null;
  const ys = pts.map(([, v]) => v);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const W = 120;
  const H = 40;
  const n = values.length - 1 || 1;
  const xy: [number, number][] = pts.map(([i, v]) => [
    (i / n) * W,
    H - 4 - (max === min ? 0.5 : (v - min) / (max - min)) * (H - 8),
  ]);
  const line = xy
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${(xy.at(-1)?.[0] ?? W).toFixed(1)},${String(H)} L${(xy[0]?.[0] ?? 0).toFixed(1)},${String(H)} Z`;
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${String(W)} ${String(H)}`}
      preserveAspectRatio="none"
      className="pointer-events-none -mx-3.5 -mb-3.5 mt-auto block h-9 w-[calc(100%+1.75rem)] sm:-mx-4 sm:-mb-4 sm:w-[calc(100%+2rem)]"
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Panel({
  icon,
  title,
  children,
  right,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-tile border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="m-0 flex items-center gap-2 text-[15px] font-extrabold">
          <span aria-hidden="true" className="text-accent">
            {icon}
          </span>
          {title}
        </h3>
        {right}
      </div>
      {children}
    </div>
  );
}

function Cell({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "pos" | "neg" | undefined;
}) {
  return (
    <div className="flex flex-col items-center gap-0.5 bg-surface px-2 py-3 text-center tabular-nums">
      <span className="text-xs text-muted">{label}</span>
      <strong
        className={`text-[17px] font-extrabold ${tone === "neg" ? "text-neg-ink" : tone === "pos" ? "text-pos" : "text-ink"}`}
      >
        {value}
      </strong>
      <span className="text-[11px] text-muted">{sub}</span>
    </div>
  );
}

function ChartCard({
  a,
  cumVol,
  cumFees,
  cumNet,
  target,
  targetPct,
}: {
  a: VolumeAnalytics;
  cumVol: number[];
  cumFees: number[];
  cumNet: number[];
  target: number | null;
  targetPct: number | null;
}) {
  const t = useTranslations("agent.vd");
  const [tab, setTab] = useState<ChartTab>("volume");
  const tabs: ChartTab[] = ["volume", "maker", "fees", "pnl"];
  const times = a.series.map((x) => Date.parse(x.t) + a.bucketMs);
  const spanDays = (Date.parse(a.to) - Date.parse(a.from)) / 86_400_000;
  const fmtT = (ms: number) =>
    new Date(ms).toLocaleString(
      "en-US",
      spanDays > 1.5
        ? { month: "short", day: "numeric" }
        : { hour: "2-digit", minute: "2-digit", hour12: false },
    );

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-tile border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="tablist"
          aria-label={t("chartLabel")}
          className="flex max-w-full gap-1 overflow-x-auto rounded-[14px] bg-surface-2 p-1"
        >
          {tabs.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={k === tab}
              onClick={() => {
                setTab(k);
              }}
              className={`min-h-8 shrink-0 rounded-[10px] px-2.5 text-[13px] font-bold whitespace-nowrap transition-colors sm:px-3 ${
                k === tab ? "bg-accent text-white shadow-accent" : "text-ink-2 hover:text-ink"
              }`}
            >
              {t(`chart.${k}`)}
            </button>
          ))}
        </div>
        {tab === "volume" && targetPct !== null ? (
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold tabular-nums ${
              targetPct >= 100 ? "bg-pos-bg text-pos" : "bg-accent-tint text-accent-ink"
            }`}
          >
            {targetPct >= 100
              ? t("targetReached", { pct: (targetPct - 100).toFixed(1) })
              : t("targetProgress", { pct: targetPct.toFixed(1) })}
          </span>
        ) : null}
      </div>
      {tab === "maker" ? (
        <Bars
          maker={a.series.map((x) => num(x.maker))}
          total={a.series.map((x) => num(x.volume))}
          times={times}
          fmtT={fmtT}
          legend={[t("legend.maker"), t("legend.taker")]}
        />
      ) : (
        <Line
          values={tab === "volume" ? cumVol : tab === "fees" ? cumFees : cumNet}
          times={times}
          fmtT={fmtT}
          color={
            tab === "pnl"
              ? (cumNet.at(-1) ?? 0) < 0
                ? "#c2312f"
                : "#16a05a"
              : tab === "fees"
                ? "#e08a2e"
                : "#2e62e8"
          }
          target={tab === "volume" ? target : null}
          zero={tab === "pnl"}
          legend={t(`legend.${tab}`)}
          targetLabel={target === null ? null : t("legend.target", { target: money(target) })}
          dp={tab === "volume" ? 2 : 4}
        />
      )}
    </div>
  );
}

const CH = 220;

// Đo bề rộng thật của khung biểu đồ để 1 đơn vị SVG = 1 px: chữ trục giữ đúng 11 px ở mọi kích thước màn hình
// (viewBox cố định rồi co giãn làm chữ phóng to gấp đôi trên màn rộng).
function useChartWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw !== undefined && cw > 0) setW(Math.max(280, Math.round(cw)));
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);
  return [ref, w] as const;
}
const PAD = { l: 44, r: 12, t: 14, b: 26 };

function ticks(min: number, max: number, n = 4): number[] {
  if (max === min) return [min];
  const step = (max - min) / n;
  return Array.from({ length: n + 1 }, (_, i) => min + step * i);
}

function Line({
  values,
  times,
  fmtT,
  color,
  target,
  zero,
  legend,
  targetLabel,
  dp,
}: {
  values: number[];
  times: number[];
  fmtT: (ms: number) => string;
  color: string;
  target: number | null;
  zero: boolean;
  legend: string;
  targetLabel: string | null;
  dp: number;
}) {
  const id = useId();
  const [ref, cw] = useChartWidth();
  const all = [...values, ...(target === null ? [] : [target]), ...(zero ? [0] : [0])];
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (max === min) max = min + 1;
  const padY = (max - min) * 0.08;
  max += padY;
  if (min < 0) min -= padY;
  const n = Math.max(1, values.length - 1);
  const x = (i: number) => PAD.l + (i / n) * (cw - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - min) / (max - min)) * (CH - PAD.t - PAD.b);
  const line = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
  const base = y(Math.max(min, 0));
  const area = `${line} L${x(values.length - 1).toFixed(1)},${base.toFixed(1)} L${x(0).toFixed(1)},${base.toFixed(1)} Z`;
  const lastV = values.at(-1) ?? 0;
  const lx = x(values.length - 1);
  const ly = y(lastV);
  const xt = [0, Math.round(n / 4), Math.round(n / 2), Math.round((3 * n) / 4), n];
  return (
    <div ref={ref} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap gap-4 text-xs text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: color }} />
          {legend}
        </span>
        {targetLabel === null ? null : (
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded bg-accent/50" />
            {targetLabel}
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${String(cw)} ${String(CH)}`}
        width={cw}
        height={CH}
        className="block max-w-full"
        role="img"
        aria-label={legend}
      >
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks(min, max).map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={cw - PAD.r} y1={y(v)} y2={y(v)} stroke="#e3e7f5" strokeWidth="1" />
            <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#5f6684">
              {money(v, Math.abs(max) < 1 ? 3 : 0)}
            </text>
          </g>
        ))}
        {xt.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={CH - 6}
            textAnchor={i === 0 ? "start" : i === n ? "end" : "middle"}
            fontSize="11"
            fill="#5f6684"
          >
            {times[i] === undefined ? "" : fmtT(times[i] ?? 0)}
          </text>
        ))}
        {target === null ? null : (
          <line
            x1={PAD.l}
            x2={cw - PAD.r}
            y1={y(target)}
            y2={y(target)}
            stroke="#2e62e8"
            strokeOpacity="0.5"
            strokeDasharray="6 5"
            strokeWidth="1.5"
          />
        )}
        <path d={area} fill={`url(#${id})`} />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="2.4"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={lx} cy={ly} r="5" fill="#fff" stroke={color} strokeWidth="2.5" />
        <g
          transform={`translate(${Math.min(lx, cw - PAD.r - 70).toFixed(1)},${Math.max(ly - 34, 2).toFixed(1)})`}
        >
          <rect x="-36" y="0" width="72" height="22" rx="7" fill={color} />
          <text x="0" y="15" textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff">
            {money(lastV, dp)}
          </text>
        </g>
      </svg>
    </div>
  );
}

function Bars({
  maker,
  total,
  times,
  fmtT,
  legend,
}: {
  maker: number[];
  total: number[];
  times: number[];
  fmtT: (ms: number) => string;
  legend: [string, string];
}) {
  const [ref, cw] = useChartWidth();
  const max = Math.max(1e-9, ...total);
  const n = total.length;
  const slot = (cw - PAD.l - PAD.r) / Math.max(1, n);
  const bw = Math.max(2, slot * 0.62);
  const y = (v: number) => PAD.t + (1 - v / max) * (CH - PAD.t - PAD.b);
  const xt = [0, Math.round((n - 1) / 2), n - 1];
  return (
    <div ref={ref} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap gap-4 text-xs text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-pos-dot" />
          {legend[0]}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-warn-bar" />
          {legend[1]}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${String(cw)} ${String(CH)}`}
        width={cw}
        height={CH}
        className="block max-w-full"
        role="img"
        aria-label={legend.join(" / ")}
      >
        {ticks(0, max).map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={cw - PAD.r} y1={y(v)} y2={y(v)} stroke="#e3e7f5" strokeWidth="1" />
            <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#5f6684">
              {money(v, 0)}
            </text>
          </g>
        ))}
        {total.map((tv, i) => {
          const x = PAD.l + i * slot + (slot - bw) / 2;
          const m = maker[i] ?? 0;
          const tk = Math.max(0, tv - m);
          return (
            <g key={i}>
              <rect
                x={x}
                y={y(m)}
                width={bw}
                height={Math.max(0, y(0) - y(m))}
                rx="2"
                fill="#16a05a"
              />
              <rect
                x={x}
                y={y(m + tk)}
                width={bw}
                height={Math.max(0, y(m) - y(m + tk))}
                rx="2"
                fill="#e08a2e"
              />
            </g>
          );
        })}
        {xt.map((i) => (
          <text
            key={i}
            x={PAD.l + i * slot + slot / 2}
            y={CH - 6}
            textAnchor="middle"
            fontSize="11"
            fill="#5f6684"
          >
            {times[i] === undefined ? "" : fmtT(times[i] ?? 0)}
          </text>
        ))}
      </svg>
    </div>
  );
}

function BreakdownCard({ volume, buy, maker }: { volume: number; buy: number; maker: number }) {
  const t = useTranslations("agent.vd");
  const sell = Math.max(0, volume - buy);
  const taker = Math.max(0, volume - maker);
  const pct = (v: number) => (volume > 0 ? `${((v / volume) * 100).toFixed(1)}%` : "—");
  const R = 64;
  const C = 2 * Math.PI * R;
  const r2 = 46;
  const C2 = 2 * Math.PI * r2;
  const buyFrac = volume > 0 ? buy / volume : 0;
  const makerFrac = volume > 0 ? maker / volume : 0;
  const rows: [string, string, number][] = [
    ["#2e62e8", t("legend.buy"), buy],
    ["#7c5cd6", t("legend.sell"), sell],
    ["#16a05a", t("legend.maker"), maker],
    ["#e08a2e", t("legend.taker"), taker],
  ];
  return (
    <div className="flex flex-col gap-3 rounded-tile border border-border bg-surface p-4">
      <h3 className="m-0 text-[15px] font-extrabold">{t("breakdownTitle")}</h3>
      <div className="flex flex-wrap items-center justify-center gap-5">
        <svg viewBox="0 0 160 160" className="size-[150px] -rotate-90" aria-hidden="true">
          <circle cx="80" cy="80" r={R} fill="none" stroke="#7c5cd6" strokeWidth="14" />
          <circle
            cx="80"
            cy="80"
            r={R}
            fill="none"
            stroke="#2e62e8"
            strokeWidth="14"
            strokeDasharray={`${String(buyFrac * C)} ${String(C)}`}
            strokeLinecap="butt"
          />
          <circle
            cx="80"
            cy="80"
            r={r2}
            fill="none"
            stroke="#e08a2e"
            strokeOpacity="0.85"
            strokeWidth="10"
          />
          <circle
            cx="80"
            cy="80"
            r={r2}
            fill="none"
            stroke="#16a05a"
            strokeWidth="10"
            strokeDasharray={`${String(makerFrac * C2)} ${String(C2)}`}
          />
          <g className="rotate-90" style={{ transformOrigin: "80px 80px" }}>
            <text x="80" y="78" textAnchor="middle" fontSize="15" fontWeight="800" fill="#141a33">
              {money(volume, volume >= 1000 ? 0 : 2)}
            </text>
            <text x="80" y="95" textAnchor="middle" fontSize="10" fontWeight="600" fill="#5f6684">
              USDC
            </text>
          </g>
        </svg>
        <dl className="m-0 flex min-w-[170px] flex-1 flex-col gap-2 text-sm tabular-nums">
          {rows.map(([c, label, v], i) => (
            <div
              key={label}
              className={`flex items-center justify-between gap-3 ${i === 2 ? "mt-1 border-t border-border pt-3" : ""}`}
            >
              <dt className="flex items-center gap-2 text-ink-2">
                <span className="size-2 rounded-full" style={{ background: c }} />
                {label}
              </dt>
              <dd className="m-0 font-semibold">
                {money(v, 2)} <span className="text-xs text-muted">({pct(v)})</span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
