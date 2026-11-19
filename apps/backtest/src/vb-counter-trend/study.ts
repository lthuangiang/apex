import {
  BOOTSTRAP_RESAMPLES,
  BOOTSTRAP_SEED,
  dec,
  Decimal,
  summarizeByDay,
  type DayObs,
  type DaySummary,
} from "@drift/shared";
import {
  runBacktest,
  volumeFarm,
  type Candle,
  type FeeSchedule,
  type MarketRules,
  type VbCounterTrendMode,
  type VbResearchOptions,
  type VolumeFarmConfig,
} from "@drift/strategies";

// Nghiên cứu bộ chặn ngược xu hướng của Volume Builder (#282). Hàm thuần: chạy ĐÚNG code chiến lược `volumeFarm` qua
// engine backtest (`runBacktest`, cùng mô hình khớp lệnh của tab Backtest) trên nến 1 phút đã lưu, mỗi biến thể một lần,
// bật/tắt Reverse; biến thể chọn qua `StepContext.vbResearch` (engine thật không bao giờ đặt). Snapshot tín hiệu DEC-311
// của từng lượt vào (regime, cú chạy trước khi vào) lấy từ `log.payload.signal` như engine. Tiền tính bằng Decimal; khoảng
// tin cậy là thống kê (số thực, seed cố định).

export const VARIANTS: readonly {
  key: "A" | "B" | "C" | "D";
  mode: VbCounterTrendMode;
  label: string;
}[] = [
  { key: "A", mode: "pre_and_post", label: "A current (pre + post Reverse)" },
  { key: "B", mode: "final_only", label: "B final direction only" },
  { key: "C", mode: "off", label: "C no block" },
  { key: "D", mode: "fade", label: "D fade the 3 min move" },
];

const DAY = 86_400_000;
const MIN = 60_000;
/** Khoảng trống nến lớn hơn mức này trong lúc giữ lệnh: lượt bị loại (giá nhảy qua khoảng trống không thật). */
export const GAP_MS = 2 * MIN;
/** Như tab Backtest (`BACKTEST_SLIPPAGE`): trượt giá của lệnh market. */
export const STUDY_SLIPPAGE = "0.0005";
/** Nến khởi động trước `from` (tín hiệu cần 120 nến; regime cần 15 nến 5 phút). */
export const WARMUP_MS = 3 * 60 * MIN;

export const REGIMES = ["SIDEWAY", "TREND_UP", "TREND_DOWN", "HIGH_VOLATILITY", "UNKNOWN"] as const;

/** Bucket cú chạy 3 phút trước khi vào, có dấu theo hướng lệnh (dương = giá đã chạy theo hướng lệnh = đuổi giá). */
export const MOVE_BUCKETS: readonly { key: string; lo: number; hi: number }[] = [
  { key: "≤ −8", lo: -Infinity, hi: -8 },
  { key: "−8…−3", lo: -8, hi: -3 },
  { key: "−3…−1", lo: -3, hi: -1 },
  { key: "−1…1", lo: -1, hi: 1 },
  { key: "1…3", lo: 1, hi: 3 },
  { key: "3…8", lo: 3, hi: 8 },
  { key: "≥ 8", lo: 8, hi: Infinity },
];

export function moveBucket(v: number | null): string {
  if (v === null) return "n/a";
  // Biên: ≤ −8 | (−8, −3] | (−3, −1] | (−1, 1) | [1, 3) | [3, 8) | ≥ 8.
  if (v <= -8) return "≤ −8";
  if (v <= -3) return "−8…−3";
  if (v <= -1) return "−3…−1";
  if (v < 1) return "−1…1";
  if (v < 3) return "1…3";
  if (v < 8) return "3…8";
  return "≥ 8";
}

export interface StudyTrade {
  at: number;
  exitAt: number;
  side: "long" | "short";
  regime: string;
  /** Cú chạy 3 phút trước khi vào (bp), có dấu theo hướng lệnh; null = không đo được. */
  move3m: number | null;
  balanced: boolean;
  entryNotional: Decimal;
  volume: Decimal;
  gross: Decimal;
  fees: Decimal;
  net: Decimal;
  netBp: Decimal;
  grossBp: Decimal;
}

export interface SimResult {
  trades: StudyTrade[];
  /** Lượt có khoảng trống nến > GAP_MS trong lúc giữ: loại. */
  gapExcluded: number;
  /** Lượt còn mở ở cuối dữ liệu: loại. */
  open: number;
  /**
   * Lượt bị đóng hai lần trong mô phỏng (stop gốc trên sàn VÀ lệnh thoát reduce-only của bot cùng khớp, hoặc stop đóng cả
   * phần vị thế thừa của lượt trước): engine backtest không áp reduce-only nên vị thế bị đảo. Loại, đếm riêng.
   */
  doubleClosed: number;
  /** Số lần bot đặt lệnh vào (kể cả lệnh huỷ vì không khớp). */
  entryOrders: number;
}

interface SnapshotLite {
  regime: string;
  side: "long" | "short";
  balanced: boolean;
  chg3mBps: number | null;
}

const TAG = /^vf:(\d+):(in|out|sl)/;

/** Khoảng trống (từ nến trước tới nến sau) dài hơn GAP_MS. */
export function gapsOf(candles: readonly Candle[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let i = 1; i < candles.length; i++) {
    const a = candles[i - 1];
    const b = candles[i];
    if (a !== undefined && b !== undefined && b.t - a.t > GAP_MS) out.push({ from: a.t, to: b.t });
  }
  return out;
}

export interface SimInput {
  market: string;
  candles: readonly Candle[];
  rules: MarketRules;
  config: VolumeFarmConfig;
  fees: FeeSchedule;
  research: VbResearchOptions;
  /** Chỉ tính lượt vào trong [from, to). */
  from: number;
  to: number;
}

/** Một lần mô phỏng (một biến thể, một market, Reverse bật hoặc tắt). */
export function simulate(i: SimInput): SimResult {
  const out = runBacktest({
    module: volumeFarm,
    config: i.config,
    markets: { [i.market]: { engine: "perps", candles: i.candles, rules: i.rules } },
    funding: {},
    fees: i.fees,
    slippage: STUDY_SLIPPAGE,
    intervalMs: MIN,
    capital: "1000000",
    equityPoints: 2,
    snapshotCandles: 120,
    decisionPayload: true,
    vbResearch: i.research,
  });
  const snaps = new Map<string, SnapshotLite>();
  let entryOrders = 0;
  for (const a of out.actions) {
    if (a.type !== "log") continue;
    const s = a.payload?.signal;
    if (s === undefined) continue;
    entryOrders += 1;
    snaps.set(s.order.clOrdID, {
      regime: s.regime,
      side: s.side,
      balanced: s.balanced,
      chg3mBps: s.price.chg3mBps,
    });
  }
  const gaps = gapsOf(i.candles);
  const byCycle = new Map<number, typeof out.fills>();
  for (const f of out.fills) {
    const m = TAG.exec(f.tag);
    if (m === null) continue;
    const c = Number(m[1]);
    byCycle.set(c, [...(byCycle.get(c) ?? []), f]);
  }
  const trades: StudyTrade[] = [];
  let gapExcluded = 0;
  let open = 0;
  let doubleClosed = 0;
  for (const fills of byCycle.values()) {
    const ins = fills.filter((f) => TAG.exec(f.tag)?.[2] === "in");
    const outs = fills.filter((f) => TAG.exec(f.tag)?.[2] !== "in");
    const first = ins[0];
    if (first === undefined) continue;
    const at = first.at;
    if (at < i.from || at >= i.to) continue;
    const qIn = ins.reduce((s, f) => s.add(f.quantity), new Decimal(0));
    const qOut = outs.reduce((s, f) => s.add(f.quantity), new Decimal(0));
    if (outs.length === 0 || qOut.lt(qIn.mul("0.999"))) {
      open += 1;
      continue;
    }
    const kinds = new Set(outs.map((f) => TAG.exec(f.tag)?.[2]));
    if (qOut.gt(qIn.mul("1.001")) || kinds.size > 1) {
      doubleClosed += 1;
      continue;
    }
    const exitAt = Math.max(...outs.map((f) => f.at));
    if (gaps.some((g) => g.to > at && g.from < exitAt)) {
      gapExcluded += 1;
      continue;
    }
    const long = first.side === "buy";
    const entryN = ins.reduce((s, f) => s.add(dec(f.price).mul(f.quantity)), new Decimal(0));
    const exitN = outs.reduce((s, f) => s.add(dec(f.price).mul(f.quantity)), new Decimal(0));
    const gross = long ? exitN.sub(entryN) : entryN.sub(exitN);
    const fees = fills.reduce((s, f) => s.add(f.fee), new Decimal(0));
    const net = gross.sub(fees);
    const snap = snaps.get(first.clOrdID);
    const raw = snap?.chg3mBps ?? null;
    trades.push({
      at,
      exitAt,
      side: long ? "long" : "short",
      regime: snap?.regime ?? "UNKNOWN",
      move3m: raw === null ? null : long ? raw : -raw,
      balanced: snap?.balanced ?? false,
      entryNotional: entryN,
      volume: entryN.add(exitN),
      gross,
      fees,
      net,
      netBp: net.div(entryN).mul(10_000),
      grossBp: gross.div(entryN).mul(10_000),
    });
  }
  trades.sort((a, b) => a.at - b.at);
  return { trades, gapExcluded, open, doubleClosed, entryOrders };
}

// ── Thống kê ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface GroupStats {
  n: number;
  net: DaySummary;
  grossBp: Decimal | null;
  feesBp: Decimal | null;
  volume: Decimal;
  /** Cost per $1M như trang team (DEC-318): −Σ net ÷ Σ volume (cả hai chiều) × 1M; dương = tốn, âm = lãi; không chặn 0. */
  costPerM: Decimal | null;
}

const mean = (xs: readonly Decimal[]) =>
  xs.length === 0 ? null : xs.reduce((s, x) => s.add(x), new Decimal(0)).div(xs.length);

export function groupStats(ts: readonly StudyTrade[]): GroupStats {
  const volume = ts.reduce((s, t) => s.add(t.volume), new Decimal(0));
  const net = ts.reduce((s, t) => s.add(t.net), new Decimal(0));
  return {
    n: ts.length,
    net: summarizeByDay(ts.map((t): DayObs => ({ v: t.netBp, at: t.at }))),
    grossBp: mean(ts.map((t) => t.grossBp)),
    feesBp: mean(ts.map((t) => t.fees.div(t.entryNotional).mul(10_000))),
    volume,
    costPerM: volume.isZero() ? null : net.neg().div(volume).mul(1_000_000),
  };
}

/** PRNG tất định (mulberry32), cùng thuật toán với `day-bootstrap`. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DiffStats {
  diff: Decimal | null;
  ciLow: Decimal | null;
  ciHigh: Decimal | null;
  clusters: number;
}

/**
 * Chênh trung bình bp sau phí (biến thể − vào ngẫu nhiên) với khoảng 95% bằng block bootstrap theo ngày GHÉP CẶP: mỗi lần
 * lấy mẫu lại cùng một tập ngày cho cả hai nhóm (cùng thị trường cùng ngày tương quan), rồi lấy chênh hai trung bình. < 2
 * ngày → không có khoảng.
 */
export function diffByDay(a: readonly StudyTrade[], b: readonly StudyTrade[]): DiffStats {
  const ma = mean(a.map((t) => t.netBp));
  const mb = mean(b.map((t) => t.netBp));
  const diff = ma === null || mb === null ? null : ma.sub(mb);
  const days = new Map<number, { sa: number; na: number; sb: number; nb: number }>();
  const put = (t: StudyTrade, side: "a" | "b") => {
    const k = Math.floor(t.at / DAY);
    const d = days.get(k) ?? { sa: 0, na: 0, sb: 0, nb: 0 };
    if (side === "a") {
      d.sa += t.netBp.toNumber();
      d.na += 1;
    } else {
      d.sb += t.netBp.toNumber();
      d.nb += 1;
    }
    days.set(k, d);
  };
  for (const t of a) put(t, "a");
  for (const t of b) put(t, "b");
  const blocks = [...days.values()];
  const k = blocks.length;
  if (diff === null || k < 2) return { diff, ciLow: null, ciHigh: null, clusters: k };
  const next = rng(BOOTSTRAP_SEED);
  const ds: number[] = [];
  for (let r = 0; r < BOOTSTRAP_RESAMPLES; r++) {
    let sa = 0;
    let na = 0;
    let sb = 0;
    let nb = 0;
    for (let i = 0; i < k; i++) {
      const x = blocks[Math.floor(next() * k)];
      if (x === undefined) continue;
      sa += x.sa;
      na += x.na;
      sb += x.sb;
      nb += x.nb;
    }
    if (na > 0 && nb > 0) ds.push(sa / na - sb / nb);
  }
  if (ds.length < 2) return { diff, ciLow: null, ciHigh: null, clusters: k };
  ds.sort((x, y) => x - y);
  const q = (p: number) => new Decimal((ds[Math.round(p * (ds.length - 1))] ?? 0).toPrecision(12));
  return { diff, ciLow: q(0.025), ciHigh: q(0.975), clusters: k };
}

// ── Chạy cả lưới ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface StudyMarketInput {
  market: string;
  candles: readonly Candle[];
  rules: MarketRules;
  config: VolumeFarmConfig;
  configSource: string;
  liveBots: number;
}

export interface Row {
  variant: (typeof VARIANTS)[number] | { key: "R"; mode: "off"; label: string };
  reverse: boolean;
  sim: SimResult;
  all: GroupStats;
  vsRandom: DiffStats | null;
  regimes: Record<string, GroupStats>;
  moves: Record<string, GroupStats>;
  halves: [GroupStats, GroupStats];
}

export interface MarketReport {
  market: string;
  configSource: string;
  liveBots: number;
  config: VolumeFarmConfig;
  tick: string;
  candles: number;
  hours: number;
  gaps: number;
  rows: Row[];
  random: Row;
}

const by = <K extends string>(ts: readonly StudyTrade[], key: (t: StudyTrade) => K) => {
  const m = new Map<K, StudyTrade[]>();
  for (const t of ts) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
  return m;
};

function rowOf(
  variant: Row["variant"],
  reverse: boolean,
  sim: SimResult,
  random: StudyTrade[] | null,
  mid: number,
): Row {
  const ts = sim.trades;
  const reg = by(ts, (t) => t.regime);
  const mv = by(ts, (t) => moveBucket(t.move3m));
  return {
    variant,
    reverse,
    sim,
    all: groupStats(ts),
    vsRandom: random === null ? null : diffByDay(ts, random),
    regimes: Object.fromEntries(REGIMES.map((r) => [r, groupStats(reg.get(r) ?? [])])),
    moves: Object.fromEntries(
      [...MOVE_BUCKETS.map((b) => b.key), "n/a"].map((k) => [k, groupStats(mv.get(k) ?? [])]),
    ),
    halves: [groupStats(ts.filter((t) => t.at < mid)), groupStats(ts.filter((t) => t.at >= mid))],
  };
}

export function runStudy(
  m: StudyMarketInput,
  fees: FeeSchedule,
  range: { from: number; to: number },
): MarketReport {
  const base = { market: m.market, candles: m.candles, rules: m.rules, fees, ...range };
  const mid = (range.from + range.to) / 2;
  const randomSim = simulate({
    ...base,
    config: { ...m.config, reverseSignal: false },
    research: { randomDirection: true },
  });
  const random = rowOf(
    { key: "R", mode: "off", label: "Random direction" },
    false,
    randomSim,
    null,
    mid,
  );
  const rows: Row[] = [];
  for (const reverse of [false, true])
    for (const v of VARIANTS) {
      const sim = simulate({
        ...base,
        config: { ...m.config, reverseSignal: reverse },
        research: { counterTrendMode: v.mode },
      });
      rows.push(rowOf(v, reverse, sim, randomSim.trades, mid));
    }
  const inRange = m.candles.filter((c) => c.t >= range.from && c.t < range.to).length;
  return {
    market: m.market,
    configSource: m.configSource,
    liveBots: m.liveBots,
    config: m.config,
    tick: m.rules.tickSize,
    candles: inRange,
    hours: inRange / 60,
    gaps: gapsOf(m.candles.filter((c) => c.t >= range.from && c.t < range.to)).length,
    rows,
    random,
  };
}

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const f1 = (v: Decimal | null) => (v === null ? "n/a" : v.toFixed(1));
const f0 = (v: Decimal | null) => (v === null ? "n/a" : v.toFixed(0));
const ci = (lo: Decimal | null, hi: Decimal | null) =>
  lo === null || hi === null ? "n/a" : `${lo.toFixed(1)} … ${hi.toFixed(1)}`;
const thin = (n: number) => (n < 30 ? " ⚠thin" : "");
const cell = (g: GroupStats) =>
  g.n === 0 ? "–" : `${String(g.n)} · ${f1(g.net.mean)}${g.n < 30 ? "*" : ""}`;

function name(r: Row): string {
  return r.variant.key === "R" ? "R random" : `${r.variant.key} Rev ${r.reverse ? "on" : "off"}`;
}

export function toMarkdown(
  reports: readonly MarketReport[],
  meta: {
    source: string;
    generatedAt: number;
    range: { from: number; to: number };
    notes: string[];
  },
): string {
  const L: string[] = [];
  const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
  L.push("# VB counter-trend block study (#282)");
  L.push("");
  L.push(
    `Source: ${meta.source}. Range ${iso(meta.range.from)} → ${iso(meta.range.to)} UTC. Generated ${iso(meta.generatedAt)} UTC.`,
  );
  L.push(
    "Research only: simulated with the real `volumeFarm` strategy code on stored 1-minute candles (backtest fill model). No orders, no SoDEX calls, no live change.",
  );
  L.push("");
  L.push(
    "Variants: " +
      VARIANTS.map((v) => `**${v.label}**`).join(", ") +
      ", **R random direction** (baseline).",
  );
  L.push(
    "Columns: net bp = result per trade after fees, in bp of entry notional (95% day-block bootstrap range, days = clusters); cost / $1M = −net ÷ volume (both legs) × 1M (positive = cost); vs R = net bp minus the random-direction run on the same market (paired day bootstrap). `*` / ⚠thin = fewer than 30 trades.",
  );
  for (const n of meta.notes) L.push(`- ${n}`);
  for (const r of reports) {
    L.push("");
    L.push(`## ${r.market}`);
    L.push("");
    L.push(
      `Config: ${r.configSource} (size ${r.config.orderSizeMinUsd}–${r.config.orderSizeMaxUsd} USDC, hold ${String(r.config.minHoldSecs)}–${String(r.config.maxHoldSecs)} s, ${String(r.config.leverage)}×, SL ${r.config.slMarginPct}% margin, TP ${r.config.tpUsd} USDC, early ${r.config.earlyProfitFees}× fees, cooldown ${String(r.config.cooldownSecs)} s). Live VB bots on this market: ${String(r.liveBots)}.`,
    );
    L.push(
      `Data: ${String(r.candles)} candles in range (${r.hours.toFixed(1)} h), ${String(r.gaps)} gaps > 2 min, tick ${r.tick} (inferred from prices).`,
    );
    L.push("");
    L.push(
      "| Run | Entries | Entry orders | Vol / h (USDC) | Net bp | 95% range (days) | Before fees bp | Fees bp | Cost / $1M | vs R bp | vs R range | Excl. (gap / open / double close) |",
    );
    L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const x of [...r.rows, r.random]) {
      const a = x.all;
      L.push(
        `| ${name(x)} | ${String(a.n)}${thin(a.n)} | ${String(x.sim.entryOrders)} | ${r.hours > 0 ? f0(a.volume.div(r.hours)) : "n/a"} | ${f1(a.net.mean)} | ${ci(a.net.ciLow, a.net.ciHigh)} (${String(a.net.clusters)}) | ${f1(a.grossBp)} | ${f1(a.feesBp)} | ${f0(a.costPerM)} | ${x.vsRandom === null ? "–" : f1(x.vsRandom.diff)} | ${x.vsRandom === null ? "–" : ci(x.vsRandom.ciLow, x.vsRandom.ciHigh)} | ${String(x.sim.gapExcluded)} / ${String(x.sim.open)} / ${String(x.sim.doubleClosed)} |`,
      );
    }
    L.push("");
    L.push("**By regime at entry** (trades · net bp):");
    L.push("");
    L.push(`| Run | ${REGIMES.join(" | ")} |`);
    L.push(`|---|${REGIMES.map(() => "---").join("|")}|`);
    for (const x of [...r.rows, r.random])
      L.push(
        `| ${name(x)} | ${REGIMES.map((g) => cell(x.regimes[g] ?? groupStats([]))).join(" | ")} |`,
      );
    const mk = [...MOVE_BUCKETS.map((b) => b.key), "n/a"];
    L.push("");
    L.push(
      "**By 3 min move before entry, in the trade's direction** (bp; positive = chasing, negative = fading; trades · net bp):",
    );
    L.push("");
    L.push(`| Run | ${mk.join(" | ")} |`);
    L.push(`|---|${mk.map(() => "---").join("|")}|`);
    for (const x of [...r.rows, r.random])
      L.push(`| ${name(x)} | ${mk.map((k) => cell(x.moves[k] ?? groupStats([]))).join(" | ")} |`);
    L.push("");
    L.push("**Halves of the range** (trades · net bp · cost / $1M):");
    L.push("");
    L.push("| Run | 1st half | 2nd half |");
    L.push("|---|---|---|");
    for (const x of [...r.rows, r.random])
      L.push(
        `| ${name(x)} | ${x.halves.map((h) => (h.n === 0 ? "–" : `${String(h.n)} · ${f1(h.net.mean)} · ${f0(h.costPerM)}`)).join(" | ")} |`,
      );
  }
  L.push("");
  return L.join("\n");
}
