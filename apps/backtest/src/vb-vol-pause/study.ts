import { Decimal } from "@drift/shared";
import {
  runBacktest,
  volumeFarm,
  type BacktestFill,
  type Candle,
  type FeeSchedule,
  type StepResult,
  type StrategyModule,
  type VolumeFarmConfig,
  type VolumeFarmState,
} from "@drift/strategies";

import {
  bookTrade,
  gapsOf,
  STUDY_SLIPPAGE,
  type StudyMarketInput,
} from "../vb-counter-trend/study";

import { balanceSplit, marketState, type SplitReport } from "./balance";
import { costSplit, largeGap, type CostSplit, type CostTrade } from "./live";

// Nghiên cứu quy tắc "tạm dừng khi biến động vọt lên" của Volume Builder (#363, việc 1). Hàm thuần, chỉ đọc dữ liệu đã nạp:
// chạy ĐÚNG code chiến lược `volumeFarm` qua engine backtest (`runBacktest`, như #282) trên nến 1 phút đã lưu. Quy tắc KHÔNG
// nằm trong chiến lược: một lớp bọc chặn sự kiện `timer` khi đang dừng NẾU bước đó sẽ mở lệnh vào mới (`vf:<n>:in`), tức là
// trả lại state cũ như thể bot không nhận nhịp đó. Lệnh đang mở, cắt lỗ và lệnh thoát giữ nguyên (mọi sự kiện khác đi thẳng).
//
// Quy tắc (không nhìn trước): biên độ nến = (cao − thấp) ÷ mở × 10 000 (bp). Nến i "vọt" khi biên độ(i) > k × trung vị biên
// độ 30 nến đã đóng ngay trước i. Ở nhịp quyết định ngay sau khi nến i đóng, bot dừng mở lệnh mới nếu một trong m nến đã
// đóng gần nhất (i − m + 1 … i) vọt, tức là chỉ mở lại sau m phút liền êm. Engine backtest quyết định mỗi phút ở lúc nến
// đóng, nên nến "đang chạy" lúc đó mới bắt đầu (biên độ ≈ 0): phần nến đang chạy của quy tắc đo riêng trên dữ liệu theo giây
// (`running.ts`). Kết quả theo bp và USDC dùng Decimal; khoảng tin cậy là block bootstrap theo ngày UTC (số thực, seed cố
// định).

const MIN = 60_000;
const DAY = 86_400_000;
/** Số nến trước dùng để lấy trung vị biên độ. */
export const MEDIAN_WINDOW = 30;
export const K_VALUES = [2, 2.5, 3] as const;
export const M_VALUES = [2, 3, 5] as const;
const ENTRY = /^vf:\d+:in(?::|$)/;
const TAG = /^vf:(\d+):(in|out|sl|xsl)/;

export const rangeBp = (c: Candle): number => {
  const o = Number(c.o);
  return o > 0 ? ((Number(c.h) - Number(c.l)) / o) * 10_000 : 0;
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** `spike[i]`: nến i vọt (biên độ > k × trung vị 30 nến đã đóng trước nó). Chưa đủ 30 nến trước → không vọt. */
export function spikes(candles: readonly Candle[], k: number): boolean[] {
  const r = candles.map(rangeBp);
  return r.map((v, i) => {
    if (i < MEDIAN_WINDOW) return false;
    const med = median(r.slice(i - MEDIAN_WINDOW, i));
    return med > 0 && v > k * med;
  });
}

/** Thời điểm mở (`t`) của các nến mà ngay sau khi nến đó đóng bot đang dừng mở lệnh mới. */
export function pausedAfter(candles: readonly Candle[], k: number, m: number): Set<number> {
  const s = spikes(candles, k);
  const out = new Set<number>();
  let last = -Infinity;
  candles.forEach((c, i) => {
    if (s[i] === true) last = i;
    if (i - last < m) out.add(c.t);
  });
  return out;
}

export interface PauseTrade {
  at: number;
  volume: Decimal;
  net: Decimal;
  netBp: Decimal;
  /** Phí (SoDEX + builder) của lượt; kết quả giá trước phí = net + fees. Dùng cho dòng hiệu chỉnh với bot thật. */
  fees: Decimal;
  /** Phần volume (USDC) khớp maker: lệnh vào maker + lần đóng đầu nếu maker. */
  makerVolume: Decimal;
  stopLoss: boolean;
  /** Lượt vào để cân khối lượng long / short (snapshot `balanced`), không theo tín hiệu. */
  balanced: boolean;
  /** Giờ mở của nến đã đóng ngay trước lúc đặt lệnh vào (nhịp quyết định); null = không rõ. */
  decidedT: number | null;
}

/** Mô hình khớp limit của backtest: "through" (mặc định, giá phải đi xuyên) hoặc "touch" (chạm là khớp). */
export type LimitFill = "through" | "touch";
export const FILL_MODELS: readonly LimitFill[] = ["through", "touch"];

export interface PauseRun {
  trades: PauseTrade[];
  /** Nhịp quyết định bị chặn vì bước đó sẽ mở lệnh vào mới. */
  blocked: number;
  gapExcluded: number;
}

/** Lệnh vào đã đặt: nhịp quyết định (giờ mở nến vừa đóng) và cờ cân long / short của snapshot. */
export interface EntryMeta {
  decidedT: number;
  balanced: boolean;
}

/**
 * Lớp bọc: đang dừng và bước `timer` sẽ đặt lệnh vào mới → bỏ bước (state cũ, không hành động). Lệnh vào được đặt thì ghi
 * `entries[clOrdID]` (chỉ đọc kết quả của bước, không đổi gì).
 */
export function pausable(
  paused: ReadonlySet<number>,
  counter: { blocked: number },
  entries = new Map<string, EntryMeta>(),
): StrategyModule<VolumeFarmConfig, VolumeFarmState> {
  return {
    ...volumeFarm,
    step: (c, s, e, ctx): StepResult<VolumeFarmState> => {
      const r = volumeFarm.step(c, s, e, ctx);
      if (e.type !== "timer") return r;
      // Timer của backtest nằm 1 ms trước giờ đóng nến; nến vừa đóng mở lúc floor((at + 1) / 1 phút) − 1 phút.
      const closedT = Math.floor((e.at + 1) / MIN) * MIN - MIN;
      const opens = r.actions.some((a) => a.type === "place" && ENTRY.test(a.order.tag));
      if (!opens) return r;
      if (paused.has(closedT)) {
        counter.blocked += 1;
        return { actions: [], state: s };
      }
      const balanced = r.actions.some(
        (a) => a.type === "log" && a.payload?.signal?.balanced === true,
      );
      for (const a of r.actions)
        if (a.type === "place" && ENTRY.test(a.order.tag))
          entries.set(a.order.clOrdID, { decidedT: closedT, balanced });
      return r;
    },
  };
}

export function simulatePause(
  m: StudyMarketInput,
  fees: FeeSchedule,
  range: { from: number; to: number },
  paused: ReadonlySet<number>,
  limitFill: LimitFill = "through",
): PauseRun {
  const counter = { blocked: 0 };
  const entries = new Map<string, EntryMeta>();
  const out = runBacktest({
    module: pausable(paused, counter, entries),
    config: m.config,
    markets: { [m.market]: { engine: "perps", candles: m.candles, rules: m.rules } },
    funding: {},
    fees,
    slippage: STUDY_SLIPPAGE,
    intervalMs: MIN,
    capital: "1000000",
    equityPoints: 2,
    snapshotCandles: 120,
    decisionPayload: true,
    limitFill,
  });
  const gaps = gapsOf(m.candles);
  const byCycle = new Map<number, BacktestFill[]>();
  for (const f of out.fills) {
    const x = TAG.exec(f.tag);
    if (x === null) continue;
    const c = Number(x[1]);
    byCycle.set(c, [...(byCycle.get(c) ?? []), f]);
  }
  const trades: PauseTrade[] = [];
  let gapExcluded = 0;
  for (const fills of byCycle.values()) {
    const first = fills.find((f) => TAG.exec(f.tag)?.[2] === "in");
    if (first === undefined || first.at < range.from || first.at >= range.to) continue;
    const b = bookTrade(fills);
    if (b === null) continue;
    if (gaps.some((g) => g.to > b.at && g.from < b.exitAt)) {
      gapExcluded += 1;
      continue;
    }
    const net = b.gross.sub(b.fees);
    // Lần đóng đầu tiên là stop gốc (`vf:<n>:sl` hoặc stop dời `xsl`) → dính cắt lỗ.
    const firstExit = fills
      .filter((f) => TAG.exec(f.tag)?.[2] !== "in")
      .sort((a, b2) => a.at - b2.at)[0];
    const kind = firstExit === undefined ? null : TAG.exec(firstExit.tag)?.[2];
    const meta = entries.get(first.clOrdID);
    trades.push({
      at: b.at,
      volume: b.entryNotional.add(b.exitNotional),
      net,
      netBp: net.div(b.entryNotional).mul(10_000),
      fees: b.fees,
      makerVolume: fills
        .filter((f) => TAG.exec(f.tag)?.[2] === "in" && f.maker)
        .reduce((s, f) => s.add(new Decimal(f.price).mul(f.quantity)), new Decimal(0))
        .add(firstExit?.maker === true ? b.exitNotional : 0),
      stopLoss: kind === "sl" || kind === "xsl",
      balanced: meta?.balanced ?? false,
      decidedT: meta?.decidedT ?? null,
    });
  }
  trades.sort((a, b) => a.at - b.at);
  return { trades, blocked: counter.blocked, gapExcluded };
}

// ── Thống kê theo ngày ───────────────────────────────────────────────────────────────────────────────────────────────

interface Day {
  net: number;
  vol: number;
  n: number;
  sl: number;
}

const dayKey = (t: number) => Math.floor(t / DAY);

function byDay(ts: readonly PauseTrade[]): Map<number, Day> {
  const m = new Map<number, Day>();
  for (const t of ts) {
    const k = dayKey(t.at);
    const d = m.get(k) ?? { net: 0, vol: 0, n: 0, sl: 0 };
    d.net += t.net.toNumber();
    d.vol += t.volume.toNumber();
    d.n += 1;
    d.sl += t.stopLoss ? 1 : 0;
    m.set(k, d);
  }
  return m;
}

/** PRNG nhỏ, seed cố định (kết quả lặp lại được). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const B = 2000;
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))] ?? NaN;
};

export interface Ci {
  v: number | null;
  lo: number | null;
  hi: number | null;
}

/**
 * Block bootstrap theo ngày GHÉP CẶP: lấy mẫu lại cùng tập ngày (có lặp) cho ô và baseline. Trả về cost / $1M của ô, volume
 * / ngày của ô, kết quả sau phí / ngày của ô, và chênh (ô − baseline) của cost / $1M và volume / ngày, mỗi số kèm khoảng 95%.
 * Ngày không có lệnh ở một bên vẫn là một ngày (volume 0) nếu nằm trong tập ngày có dữ liệu.
 */
export function pairedDayStats(
  cell: readonly PauseTrade[],
  base: readonly PauseTrade[],
  days: readonly number[],
): {
  costPerM: Ci;
  volPerDay: Ci;
  netPerDay: Ci;
  dCostPerM: Ci;
  dVolPerDay: Ci;
} {
  const a = byDay(cell);
  const b = byDay(base);
  const zero: Day = { net: 0, vol: 0, n: 0, sl: 0 };
  const calc = (idx: readonly number[]) => {
    let an = 0;
    let av = 0;
    let bn = 0;
    let bv = 0;
    for (const k of idx) {
      const x = a.get(k) ?? zero;
      const y = b.get(k) ?? zero;
      an += x.net;
      av += x.vol;
      bn += y.net;
      bv += y.vol;
    }
    const n = idx.length;
    const ca = av > 0 ? (-an / av) * 1e6 : NaN;
    const cb = bv > 0 ? (-bn / bv) * 1e6 : NaN;
    return { ca, va: av / n, na: an / n, dc: ca - cb, dv: (av - bv) / n };
  };
  const point = calc(days);
  if (days.length < 2) {
    const one = (v: number): Ci => ({ v: Number.isFinite(v) ? v : null, lo: null, hi: null });
    return {
      costPerM: one(point.ca),
      volPerDay: one(point.va),
      netPerDay: one(point.na),
      dCostPerM: one(point.dc),
      dVolPerDay: one(point.dv),
    };
  }
  const r = rng(363);
  const s = {
    ca: [] as number[],
    va: [] as number[],
    na: [] as number[],
    dc: [] as number[],
    dv: [] as number[],
  };
  for (let i = 0; i < B; i += 1) {
    const idx = days.map(() => days[Math.floor(r() * days.length)] ?? 0);
    const x = calc(idx);
    for (const key of ["ca", "va", "na", "dc", "dv"] as const)
      if (Number.isFinite(x[key])) s[key].push(x[key]);
  }
  const ci = (v: number, xs: number[]): Ci => ({
    v: Number.isFinite(v) ? v : null,
    lo: xs.length === 0 ? null : pct(xs, 0.025),
    hi: xs.length === 0 ? null : pct(xs, 0.975),
  });
  return {
    costPerM: ci(point.ca, s.ca),
    volPerDay: ci(point.va, s.va),
    netPerDay: ci(point.na, s.na),
    dCostPerM: ci(point.dc, s.dc),
    dVolPerDay: ci(point.dv, s.dv),
  };
}

/** Ngày UTC có đủ dữ liệu (≥ 90% số phút có nến) trong [from, to): đơn vị của volume / ngày và của bootstrap. */
export function coveredDays(
  candles: readonly Candle[],
  range: { from: number; to: number },
): number[] {
  const count = new Map<number, number>();
  for (const c of candles) {
    if (c.t < range.from || c.t >= range.to) continue;
    count.set(dayKey(c.t), (count.get(dayKey(c.t)) ?? 0) + 1);
  }
  return [...count.entries()]
    .filter(([, n]) => n >= 0.9 * 1440)
    .map(([k]) => k)
    .sort((x, y) => x - y);
}

export interface CellRow {
  label: string;
  k: number | null;
  m: number | null;
  trades: number;
  blocked: number;
  stopLosses: number;
  gapExcluded: number;
  stats: ReturnType<typeof pairedDayStats>;
}

/** Quy tắc phần 1 dùng cho phần 2 ("sau khi áp quy tắc"): ô có Δ cost tốt nhất trên ETH ở lượt chạy đầu (local). */
export const PART2_RULE = { k: 2.5, m: 3 } as const;

export interface MarketPauseReport {
  market: string;
  fill: LimitFill;
  configSource: string;
  days: number[];
  rows: CellRow[];
  /** Lượt baseline trong ngày đủ dữ liệu (cho dòng hiệu chỉnh). */
  baseTrades: PauseTrade[];
  /** Lượt đã đóng của bot Volume Builder tiền thật cùng market, cùng kỳ; null = không đọc. */
  live: CostTrade[] | null;
  /** Phần 2: lượt cân vs lượt tín hiệu theo trạng thái thị trường, baseline và sau quy tắc `PART2_RULE`. */
  split: { baseline: SplitReport; withRule: SplitReport };
}

const splitInput = (ts: readonly PauseTrade[]) =>
  ts.map((t) => ({
    at: t.at,
    netBp: t.netBp.toNumber(),
    net: t.net.toNumber(),
    volume: t.volume.toNumber(),
    balanced: t.balanced,
    decidedT: t.decidedT,
  }));

/** Baseline (không quy tắc) + lưới k × m với một mô hình khớp, chỉ tính lượt vào trong ngày đủ dữ liệu. */
export function runPauseStudy(
  m: StudyMarketInput,
  fees: FeeSchedule,
  range: { from: number; to: number },
  progress: (what: string) => void = () => undefined,
  fill: LimitFill = "through",
): MarketPauseReport {
  const days = coveredDays(m.candles, range);
  const inDays = (ts: PauseTrade[]) => ts.filter((t) => days.includes(dayKey(t.at)));
  progress(`${m.market} (${fill}): baseline`);
  const base = simulatePause(m, fees, range, new Set(), fill);
  const baseTrades = inDays(base.trades);
  const row = (label: string, k: number | null, mm: number | null, r: PauseRun): CellRow => {
    const ts = inDays(r.trades);
    return {
      label,
      k,
      m: mm,
      trades: ts.length,
      blocked: r.blocked,
      stopLosses: ts.filter((t) => t.stopLoss).length,
      gapExcluded: r.gapExcluded,
      stats: pairedDayStats(ts, baseTrades, days),
    };
  };
  const rows: CellRow[] = [row("baseline (no rule)", null, null, base)];
  let ruleTrades: PauseTrade[] = [];
  for (const k of K_VALUES)
    for (const mm of M_VALUES) {
      progress(`${m.market} (${fill}): k=${String(k)} m=${String(mm)}`);
      const r = simulatePause(m, fees, range, pausedAfter(m.candles, k, mm), fill);
      if (k === PART2_RULE.k && mm === PART2_RULE.m) ruleTrades = inDays(r.trades);
      rows.push(row(`k ${String(k)} · m ${String(mm)}`, k, mm, r));
    }
  const state = marketState(m.candles);
  return {
    market: m.market,
    fill,
    configSource: m.configSource,
    days,
    rows,
    baseTrades,
    live: null,
    split: {
      baseline: balanceSplit(splitInput(baseTrades), state, days),
      withRule: balanceSplit(splitInput(ruleTrades), state, days),
    },
  };
}

const f0 = (v: number | null) => (v === null ? "n/a" : Math.round(v).toLocaleString("en-US"));
const f1 = (v: number | null) => (v === null ? "n/a" : v.toFixed(1));
const f2 = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));
const ci0 = (c: Ci) => `${f0(c.v)} [${f0(c.lo)}, ${f0(c.hi)}]`;
const ci1 = (c: Ci) => `${f1(c.v)} [${f1(c.lo)}, ${f1(c.hi)}]`;
const ci2 = (c: Ci) => `${f2(c.v)} [${f2(c.lo)}, ${f2(c.hi)}]`;
const fm = (v: Decimal | null) => (v === null ? "Not available" : f0(v.toNumber()));
/** Chiều của Δ theo khoảng 95%: chỉ dùng chiều, không dùng độ lớn. */
const dir = (c: Ci) =>
  c.lo === null || c.hi === null ? "n/a" : c.hi < 0 ? "lower" : c.lo > 0 ? "higher" : "unclear";

const FILL_LABEL: Record<LimitFill, string> = {
  through: "through (default: price must trade through the limit)",
  touch: "touch (limit fills when price touches it)",
};

/**
 * Hiệu chỉnh: baseline backtest của từng mô hình khớp so với bot thật cùng kỳ (cả kỳ, và chỉ những ngày bot thật có lượt
 * đóng), tách phí / phần giá / tỷ lệ maker. Không có lượt thật → "Not available". Mô hình gần thật hơn đáng tin hơn.
 */
export function calibrationLines(rs: readonly MarketPauseReport[]): string[] {
  const first = rs[0];
  if (first === undefined) return [];
  const live = first.live === null ? null : costSplit(first.live);
  const liveDays = new Set((first.live ?? []).map((t) => dayKey(t.at)));
  const row = (label: string, c: CostSplit | null) =>
    `| ${label} | ${c === null ? "Not available" : String(c.trades)} | ${fm(c?.costPerM ?? null)} | ${fm(c?.feesPerM ?? null)} | ${fm(c?.pricePerM ?? null)} | ${c?.makerPct == null ? "Not available" : `${c.makerPct.toFixed(0)}%`} |`;
  const out = [
    `### Calibration vs live Volume Builder bots (${first.market})`,
    "",
    "| Source | Trades | Cost / $1M | Fees / $1M | Price part / $1M | Maker share of volume |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  const refs: { fill: LimitFill; cost: Decimal | null }[] = [];
  for (const r of rs) {
    const bt = costSplit(r.baseTrades);
    const same = costSplit(r.baseTrades.filter((t) => liveDays.has(dayKey(t.at))));
    const sameOk = liveDays.size > 0 && same.trades > 0;
    out.push(
      row(`Backtest baseline (${r.fill}), all covered days`, bt),
      row(
        `Backtest baseline (${r.fill}), days with live trades (${String(liveDays.size)})`,
        sameOk ? same : null,
      ),
    );
    refs.push({ fill: r.fill, cost: sameOk ? same.costPerM : bt.costPerM });
  }
  out.push(
    row(
      "Live bots (fills, Signal Analysis formula)",
      live !== null && live.trades > 0 ? live : null,
    ),
    "",
  );
  if (live === null || live.trades === 0) {
    out.push("Live cost: Not available (no closed live trades in this range).");
    return out;
  }
  for (const x of refs)
    out.push(
      largeGap(x.cost, live.costPerM)
        ? `- **Large gap (${x.fill}):** backtest ${fm(x.cost)} vs live ${fm(live.costPerM)} USDC / $1M. Absolute backtest costs are not reliable; read only the direction of Δ vs baseline.`
        : `- ${x.fill}: backtest ${fm(x.cost)} vs live ${fm(live.costPerM)} USDC / $1M, within the gap limit.`,
    );
  const known = refs.filter((x) => x.cost !== null);
  const closest = known.sort(
    (a, b) =>
      (a.cost
        ?.sub(live.costPerM ?? 0)
        .abs()
        .toNumber() ?? Infinity) -
      (b.cost
        ?.sub(live.costPerM ?? 0)
        .abs()
        .toNumber() ?? Infinity),
  )[0];
  if (closest !== undefined && rs.length > 1)
    out.push(`- Closest to live: **${closest.fill}**; weigh its Δ more.`);
  return out;
}

function splitLines(r: MarketPauseReport): string[] {
  const table = (title: string, x: SplitReport) => [
    `${title} (unclassified trades: ${String(x.unclassified)})`,
    "",
    "| Group | Trades | Mean result after fees (bp) [95%] | Win rate | Cost / $1M |",
    "|---|---:|---:|---:|---:|",
    ...x.rows.map(
      (g) =>
        `| ${g.group} | ${String(g.n)} | ${ci1(g.meanBp)} | ${g.winPct === null ? "n/a" : `${g.winPct.toFixed(0)}%`} | ${f0(g.costPerM)} |`,
    ),
    "",
    `Balance − signal, calm: ${ci1(x.diffCalm)} bp (${dir(x.diffCalm)}). Balance − signal, strong move: ${ci1(x.diffStrong)} bp (${dir(x.diffStrong)}).`,
    "",
  ];
  return [
    ...table("Baseline", r.split.baseline),
    ...table(`With rule k ${String(PART2_RULE.k)} · m ${String(PART2_RULE.m)}`, r.split.withRule),
  ];
}

export function pauseMarkdown(
  reports: readonly MarketPauseReport[],
  meta: { source: string; range: { from: number; to: number }; notes: readonly string[] },
): string {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const lines: string[] = [
    "# Volume Builder: pause on volatility spikes (#363)",
    "",
    `Source: ${meta.source}. Range ${iso(meta.range.from)} → ${iso(meta.range.to)} (UTC). Past simulation, not a forecast.`,
    "",
    "**Read only the direction of Δ and its 95% interval, not the size.** The default fill model is pessimistic (see the calibration line of each market).",
    "",
  ];
  const markets = [...new Set(reports.map((r) => r.market))];
  for (const mk of markets) {
    const rs = reports.filter((r) => r.market === mk);
    const r0 = rs[0];
    if (r0 === undefined) continue;
    lines.push(
      `## ${mk}`,
      "",
      `Config: ${r0.configSource}. Days with ≥ 90% of minutes: **${String(r0.days.length)}** (${r0.days.map((d) => iso(d * DAY)).join(", ")}).`,
      "",
      ...calibrationLines(rs),
      "",
    );
    if (rs.length > 1) {
      lines.push(
        "### Part 1: Δ vs baseline, fill models side by side",
        "",
        `| Cell | ${rs.map((r) => `Δ cost / $1M (${r.fill})`).join(" | ")} | ${rs.map((r) => `Δ volume / day (${r.fill})`).join(" | ")} |`,
        `|---|${rs.map(() => "---:").join("|")}|${rs.map(() => "---:").join("|")}|`,
      );
      r0.rows.forEach((x, i) => {
        if (x.k === null) return;
        const cells = rs.map((r) => r.rows[i]?.stats);
        lines.push(
          `| ${x.label} | ${cells.map((s) => (s === undefined ? "n/a" : `${ci0(s.dCostPerM)} ${dir(s.dCostPerM)}`)).join(" | ")} | ${cells.map((s) => (s === undefined ? "n/a" : `${ci0(s.dVolPerDay)} ${dir(s.dVolPerDay)}`)).join(" | ")} |`,
        );
      });
      lines.push("");
    }
    for (const r of rs) {
      lines.push(
        `### Part 1, fill model: ${FILL_LABEL[r.fill]}`,
        "",
        "| Cell | Trades | Volume / day (USDC) | Δ volume / day | Result after fees / day (USDC) | Cost / $1M (USDC) | Δ cost / $1M vs baseline | Entries blocked | Stop-loss hits |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
      );
      for (const x of r.rows)
        lines.push(
          `| ${x.label} | ${String(x.trades)} | ${ci0(x.stats.volPerDay)} | ${x.k === null ? "—" : ci0(x.stats.dVolPerDay)} | ${ci2(x.stats.netPerDay)} | ${ci0(x.stats.costPerM)} | ${x.k === null ? "—" : ci0(x.stats.dCostPerM)} | ${String(x.blocked)} | ${String(x.stopLosses)} |`,
        );
      lines.push(
        "",
        `### Part 2, fill model: ${r.fill}: balancing vs signal entries by market state`,
        "",
        ...splitLines(r),
      );
    }
  }
  lines.push("## Notes", "", ...meta.notes.map((n) => `- ${n}`), "");
  return lines.join("\n");
}
