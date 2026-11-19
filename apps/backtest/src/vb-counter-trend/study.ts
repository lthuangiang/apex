import {
  dec,
  Decimal,
  diffByDayBootstrap,
  summarizeByDay,
  type DayDiff,
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
// của từng lượt vào (regime, cú chạy trước khi vào, lượt cân long / short) lấy từ `log.payload.signal` như engine. Tiền
// tính bằng Decimal; khoảng tin cậy là thống kê (số thực, seed cố định, helper chung `@drift/shared` stats).
//
// Hai baseline ngẫu nhiên (review #283 M2), mỗi cái chạy `seeds` đồng xu khác nhau rồi gộp lượt:
// - "own random" của từng biến thể: biến thể quyết định vào hay không như thường, nếu vào thì hướng = đồng xu → cùng kiểu
//   thời điểm vào, chênh (biến thể − own random) chỉ đo hiệu ứng CHỌN HƯỚNG;
// - R "random, no gates": hướng = đồng xu, bỏ tín hiệu, cân long / short, Reverse và mọi cổng → tham chiếu volume.

export type VariantKey = "A" | "B" | "B′" | "C" | "D";

export const VARIANTS: readonly { key: VariantKey; mode: VbCounterTrendMode; label: string }[] = [
  { key: "A", mode: "pre_and_post", label: "A current (pre + post Reverse)" },
  { key: "B", mode: "final_only", label: "B final direction only" },
  {
    key: "B′",
    mode: "final_unless_balanced",
    label: "B′ final direction only, balancing entries exempt",
  },
  { key: "C", mode: "off", label: "C no block" },
  { key: "D", mode: "fade", label: "D fade the ~4 min move" },
];

/** Số đồng xu (muối) mặc định cho mỗi baseline ngẫu nhiên. */
export const DEFAULT_SEEDS = 5;

const MIN = 60_000;
/** Khoảng trống nến lớn hơn mức này trong lúc giữ lệnh: lượt bị loại (giá nhảy qua khoảng trống không thật). */
export const GAP_MS = 2 * MIN;
/** Như tab Backtest (`BACKTEST_SLIPPAGE`): trượt giá của lệnh market. */
export const STUDY_SLIPPAGE = "0.0005";
/** Nến khởi động trước `from` (tín hiệu cần 120 nến; regime cần 15 nến 5 phút). */
export const WARMUP_MS = 3 * 60 * MIN;
/** Dưới ngần này ngày (cụm) thì khoảng bootstrap theo ngày thường hẹp hơn thật. */
export const FEW_CLUSTERS = 20;

export const REGIMES = ["SIDEWAY", "TREND_UP", "TREND_DOWN", "HIGH_VOLATILITY", "UNKNOWN"] as const;

/**
 * Bucket cú chạy trước khi vào, có dấu theo hướng lệnh (dương = giá đã chạy theo hướng lệnh = đuổi giá). Cú chạy là
 * `chg3mBps` của snapshot: giá lúc quyết định so với close của nến đã đóng ≤ lúc đó − 3 phút; timer của backtest ở 1 ms
 * trước giờ đóng nến nên đây là close(t) so với close 4 nến trước (≈ 4 phút).
 */
export const MOVE_BUCKETS = ["≤ −8", "−8…−3", "−3…−1", "−1…1", "1…3", "3…8", "≥ 8"] as const;

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
  /** Cú chạy ≈ 4 phút trước khi vào (bp), có dấu theo hướng lệnh; null = không đo được. */
  move3m: number | null;
  /** Lượt bị buộc hướng vì cân long / short (DEC-80). */
  balanced: boolean;
  /**
   * Lượt dính "đóng hai lần" của engine backtest (không áp reduce-only, #284): stop gốc và lệnh thoát cùng khớp, hoặc vị
   * thế thừa của lượt trước lẫn vào. Lượt vẫn được tính, chốt ở lần đóng ĐẦU TIÊN với đúng khối lượng vào.
   */
  doubleClosed: boolean;
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
  /** Số lần chạy gộp lại (baseline ngẫu nhiên: số seed); volume / giờ chia cho số này. */
  runs: number;
  /** Lượt có khoảng trống nến > GAP_MS trong lúc giữ: loại. */
  gapExcluded: number;
  /** Lượt còn mở ở cuối dữ liệu: loại. */
  open: number;
  /** Số lần bot đặt lệnh vào (kể cả lệnh huỷ vì không khớp). */
  entryOrders: number;
}

interface SnapshotLite {
  regime: string;
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

export interface SimFill {
  at: number;
  tag: string;
  side: "buy" | "sell";
  price: string;
  quantity: string;
  fee: string;
}

export interface BookedTrade {
  at: number;
  exitAt: number;
  long: boolean;
  entryNotional: Decimal;
  exitNotional: Decimal;
  gross: Decimal;
  fees: Decimal;
  doubleClosed: boolean;
}

/**
 * Chốt một lượt từ các fill của nó (theo thứ tự thời gian). Lượt chốt ở lần đóng ĐẦU TIÊN (fill `out` hoặc `sl` đầu
 * tiên), với đúng khối lượng vào `qIn`: trong engine đúng (reduce-only), lần đóng đầu đã đóng hết vị thế của lượt, nên
 * phần khớp thêm (đóng hai lần) và vị thế bị đảo thừa ra bị bỏ, không lan sang lượt sau. Phí của lần đóng tính theo tỉ lệ
 * khối lượng đã chốt. Chưa có fill đóng → null (lượt còn mở).
 */
export function bookTrade(fills: readonly SimFill[]): BookedTrade | null {
  const ins = fills.filter((f) => TAG.exec(f.tag)?.[2] === "in");
  const outs = fills.filter((f) => TAG.exec(f.tag)?.[2] !== "in");
  const first = ins[0];
  const close = outs[0];
  if (first === undefined || close === undefined) return null;
  const qIn = ins.reduce((s, f) => s.add(f.quantity), new Decimal(0));
  const qOut = outs.reduce((s, f) => s.add(f.quantity), new Decimal(0));
  const long = first.side === "buy";
  const entryN = ins.reduce((s, f) => s.add(dec(f.price).mul(f.quantity)), new Decimal(0));
  const exitN = dec(close.price).mul(qIn);
  const closeFee = dec(close.fee).mul(qIn).div(close.quantity);
  const fees = ins.reduce((s, f) => s.add(f.fee), new Decimal(0)).add(closeFee);
  // Sạch = đúng một fill đóng, cùng khối lượng (± 0.1%) với lệnh vào.
  const clean = outs.length === 1 && qOut.sub(qIn).abs().lte(qIn.mul("0.001"));
  return {
    at: first.at,
    exitAt: close.at,
    long,
    entryNotional: entryN,
    exitNotional: exitN,
    gross: long ? exitN.sub(entryN) : entryN.sub(exitN),
    fees,
    doubleClosed: !clean,
  };
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

/** Một lần mô phỏng (một biến thể, một market, Reverse bật hoặc tắt, một seed). */
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
      balanced: s.balanced,
      chg3mBps: s.price.chg3mBps,
    });
  }
  const gaps = gapsOf(i.candles);
  const byCycle = new Map<number, { fills: SimFill[]; entryId: string | null }>();
  for (const f of out.fills) {
    const m = TAG.exec(f.tag);
    if (m === null) continue;
    const c = Number(m[1]);
    const g = byCycle.get(c) ?? { fills: [], entryId: null };
    g.fills.push(f);
    if (m[2] === "in" && g.entryId === null) g.entryId = f.clOrdID;
    byCycle.set(c, g);
  }
  const trades: StudyTrade[] = [];
  let gapExcluded = 0;
  let open = 0;
  for (const { fills, entryId } of byCycle.values()) {
    const firstIn = fills.find((f) => TAG.exec(f.tag)?.[2] === "in");
    if (firstIn === undefined || firstIn.at < i.from || firstIn.at >= i.to) continue;
    const b = bookTrade(fills);
    if (b === null) {
      open += 1;
      continue;
    }
    if (gaps.some((g) => g.to > b.at && g.from < b.exitAt)) {
      gapExcluded += 1;
      continue;
    }
    const net = b.gross.sub(b.fees);
    const snap = entryId === null ? undefined : snaps.get(entryId);
    const raw = snap?.chg3mBps ?? null;
    trades.push({
      at: b.at,
      exitAt: b.exitAt,
      side: b.long ? "long" : "short",
      regime: snap?.regime ?? "UNKNOWN",
      move3m: raw === null ? null : b.long ? raw : -raw,
      balanced: snap?.balanced ?? false,
      doubleClosed: b.doubleClosed,
      entryNotional: b.entryNotional,
      volume: b.entryNotional.add(b.exitNotional),
      gross: b.gross,
      fees: b.fees,
      net,
      netBp: net.div(b.entryNotional).mul(10_000),
      grossBp: b.gross.div(b.entryNotional).mul(10_000),
    });
  }
  trades.sort((a, b) => a.at - b.at);
  return { trades, runs: 1, gapExcluded, open, entryOrders };
}

/** Chạy một baseline ngẫu nhiên với `seeds` muối khác nhau, gộp lượt của mọi seed. */
export function simulateSeeds(i: SimInput, seeds: number): SimResult {
  const runs = Array.from({ length: seeds }, (_, k) =>
    simulate({ ...i, research: { ...i.research, randomSalt: String(k) } }),
  );
  return {
    trades: runs.flatMap((r) => r.trades).sort((a, b) => a.at - b.at),
    runs: seeds,
    gapExcluded: runs.reduce((s, r) => s + r.gapExcluded, 0),
    open: runs.reduce((s, r) => s + r.open, 0),
    entryOrders: runs.reduce((s, r) => s + r.entryOrders, 0),
  };
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
const obs = (ts: readonly StudyTrade[]) => ts.map((t): DayObs => ({ v: t.netBp, at: t.at }));

export function groupStats(ts: readonly StudyTrade[]): GroupStats {
  const volume = ts.reduce((s, t) => s.add(t.volume), new Decimal(0));
  const net = ts.reduce((s, t) => s.add(t.net), new Decimal(0));
  return {
    n: ts.length,
    net: summarizeByDay(obs(ts)),
    grossBp: mean(ts.map((t) => t.grossBp)),
    feesBp: mean(ts.map((t) => t.fees.div(t.entryNotional).mul(10_000))),
    volume,
    costPerM: volume.isZero() ? null : net.neg().div(volume).mul(1_000_000),
  };
}

/** Chênh bp sau phí mỗi lượt (a − b), khoảng 95% bootstrap ngày ghép cặp (helper chung của `@drift/shared`). */
export function diffByDay(a: readonly StudyTrade[], b: readonly StudyTrade[]): DayDiff {
  return diffByDayBootstrap(obs(a), obs(b));
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

export interface Cell {
  s: GroupStats;
  /** So với baseline ngẫu nhiên riêng của biến thể trong cùng nhóm; null = hàng R. */
  d: DayDiff | null;
}

export interface Row {
  key: VariantKey | "R";
  label: string;
  reverse: boolean;
  sim: SimResult;
  all: GroupStats;
  /** Độ nhạy: bỏ hẳn các lượt dính đóng hai lần. */
  exclDouble: GroupStats;
  doubleClosed: number;
  /** Baseline ngẫu nhiên riêng (cùng cổng, hướng = đồng xu); null ở hàng R. */
  own: SimResult | null;
  ownAll: GroupStats | null;
  vsOwn: DayDiff | null;
  vsR: DayDiff | null;
  regimes: Record<string, Cell>;
  moves: Record<string, Cell>;
  entryType: { signal: Cell; balanced: Cell };
  halves: [Cell, Cell];
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
  seeds: number;
  rows: Row[];
  random: Row;
}

function cellsBy(
  ts: readonly StudyTrade[],
  base: readonly StudyTrade[] | null,
  keys: readonly string[],
  key: (t: StudyTrade) => string,
): Record<string, Cell> {
  const pick = (xs: readonly StudyTrade[], k: string) => xs.filter((t) => key(t) === k);
  return Object.fromEntries(
    keys.map((k) => {
      const mine = pick(ts, k);
      return [k, { s: groupStats(mine), d: base === null ? null : diffByDay(mine, pick(base, k)) }];
    }),
  );
}

export function rowOf(
  head: { key: VariantKey | "R"; label: string; reverse: boolean },
  sim: SimResult,
  own: SimResult | null,
  random: SimResult | null,
  mid: number,
): Row {
  const ts = sim.trades;
  const base = own?.trades ?? null;
  const half = cellsBy(ts, base, ["1", "2"], (t) => (t.at < mid ? "1" : "2"));
  const type = cellsBy(ts, base, ["signal", "balanced"], (t) =>
    t.balanced ? "balanced" : "signal",
  );
  const cell = (r: Record<string, Cell>, k: string): Cell => r[k] ?? { s: groupStats([]), d: null };
  return {
    ...head,
    sim,
    all: groupStats(ts),
    exclDouble: groupStats(ts.filter((t) => !t.doubleClosed)),
    doubleClosed: ts.filter((t) => t.doubleClosed).length,
    own,
    ownAll: own === null ? null : groupStats(own.trades),
    vsOwn: own === null ? null : diffByDay(ts, own.trades),
    vsR: random === null ? null : diffByDay(ts, random.trades),
    regimes: cellsBy(ts, base, REGIMES, (t) => t.regime),
    moves: cellsBy(ts, base, [...MOVE_BUCKETS, "n/a"], (t) => moveBucket(t.move3m)),
    entryType: { signal: cell(type, "signal"), balanced: cell(type, "balanced") },
    halves: [cell(half, "1"), cell(half, "2")],
  };
}

export function runStudy(
  m: StudyMarketInput,
  fees: FeeSchedule,
  range: { from: number; to: number },
  seeds = DEFAULT_SEEDS,
  progress: (what: string) => void = () => undefined,
): MarketReport {
  const base = { market: m.market, candles: m.candles, rules: m.rules, fees, ...range };
  const mid = (range.from + range.to) / 2;
  progress(`${m.market} R`);
  const randomSim = simulateSeeds(
    { ...base, config: { ...m.config, reverseSignal: false }, research: { randomDirection: true } },
    seeds,
  );
  const random = rowOf(
    { key: "R", label: "Random direction, no gates", reverse: false },
    randomSim,
    null,
    null,
    mid,
  );
  const rows: Row[] = [];
  for (const reverse of [false, true])
    for (const v of VARIANTS) {
      progress(`${m.market} ${v.key} Reverse ${reverse ? "on" : "off"}`);
      const input = { ...base, config: { ...m.config, reverseSignal: reverse } };
      const sim = simulate({ ...input, research: { counterTrendMode: v.mode } });
      const own = simulateSeeds(
        { ...input, research: { counterTrendMode: v.mode, randomAfterGates: true } },
        seeds,
      );
      rows.push(rowOf({ key: v.key, label: v.label, reverse }, sim, own, randomSim, mid));
    }
  const inRange = m.candles.filter((c) => c.t >= range.from && c.t < range.to);
  return {
    market: m.market,
    configSource: m.configSource,
    liveBots: m.liveBots,
    config: m.config,
    tick: m.rules.tickSize,
    candles: inRange.length,
    hours: inRange.length / 60,
    gaps: gapsOf(inRange).length,
    seeds,
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
const star = (n: number) => (n < 30 ? "*" : "");
/** "n · net bp (Δ vs own random)". */
const cellText = (c: Cell) =>
  c.s.n === 0
    ? "–"
    : `${String(c.s.n)} · ${f1(c.s.net.mean)}${c.d === null ? "" : ` (${f1(c.d.diff)})`}${star(c.s.n)}`;

function name(r: Row): string {
  return r.key === "R" ? "R random, no gates" : `${r.key} Rev ${r.reverse ? "on" : "off"}`;
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
  const days = Math.ceil((meta.range.to - meta.range.from) / 86_400_000);
  L.push("# VB counter-trend block study (#282)");
  L.push("");
  L.push(
    `Source: ${meta.source}. Range ${iso(meta.range.from)} → ${iso(meta.range.to)} UTC. Generated ${iso(meta.generatedAt)} UTC.`,
  );
  L.push(
    "Research only: simulated with the real `volumeFarm` strategy code on stored 1-minute candles (backtest fill model). No orders, no SoDEX calls, no live change.",
  );
  L.push("");
  L.push(`Variants: ${VARIANTS.map((v) => `**${v.label}**`).join(", ")}.`);
  L.push("");
  L.push("Baselines (each pooled over several coin seeds, see the market header):");
  L.push(
    "- **Own random** (per variant): the variant decides WHEN to enter exactly as usual (signal, DEC-80 balancing, Reverse, its own gate), then the direction is a coin flip. Δ own = variant − own random isolates the direction effect at the variant's own timing.",
  );
  L.push(
    "- **R random, no gates**: coin-flip direction with no signal, no balancing, no Reverse and no counter-trend gate. Volume reference; Δ R mixes timing and direction.",
  );
  L.push("");
  L.push(
    "Net bp = result per trade after fees, in bp of entry notional. Ranges are 95% day-block bootstrap (paired by day for differences); the number in brackets is the count of day clusters. Cost / $1M = −net ÷ volume (both legs) × 1M, positive = cost. `*` / ⚠thin = fewer than 30 trades.",
  );
  if (days + 1 < FEW_CLUSTERS)
    L.push(
      `- ⚠ **Few clusters:** this range gives at most ${String(days + 1)} day clusters. A percentile bootstrap over so few clusters tends to give ranges that are too narrow; read them as optimistic.`,
    );
  L.push(
    "- Move before entry = the snapshot's `chg3mBps`: price at the decision vs the close of the last candle closed at least 3 min earlier. In the backtest the decision sits 1 ms before a candle close, so it is the close 4 candles back (**~4 min**). D fades the same move.",
  );
  L.push(
    "- Double close: the backtest engine does not apply reduce-only yet (#284), so the exchange stop and the bot's exit can both fill and flip the position. Such trades are booked at their FIRST close with the entry quantity; the flipped leftover is dropped and never reaches the next cycle. Their share is in the table; `Net excl. double` drops them entirely (sensitivity).",
  );
  for (const n of meta.notes) L.push(`- ${n}`);
  for (const r of reports) {
    const all = [...r.rows, r.random];
    const perH = (x: Row) => (r.hours > 0 ? f0(x.all.volume.div(r.hours).div(x.sim.runs)) : "n/a");
    L.push("");
    L.push(`## ${r.market}`);
    L.push("");
    L.push(
      `Config: ${r.configSource} (size ${r.config.orderSizeMinUsd}–${r.config.orderSizeMaxUsd} USDC, hold ${String(r.config.minHoldSecs)}–${String(r.config.maxHoldSecs)} s, ${String(r.config.leverage)}×, SL ${r.config.slMarginPct}% margin, TP ${r.config.tpUsd} USDC, early ${r.config.earlyProfitFees}× fees, cooldown ${String(r.config.cooldownSecs)} s). Live VB bots on this market: ${String(r.liveBots)}.`,
    );
    L.push(
      `Data: ${String(r.candles)} candles in range (${r.hours.toFixed(1)} h), ${String(r.gaps)} gaps > 2 min, tick ${r.tick} (inferred from prices). Random baselines: ${String(r.seeds)} seeds each, pooled (R row counts are totals over seeds; volume / h is per run).`,
    );
    L.push("");
    L.push("**Result per variant**");
    L.push("");
    L.push(
      "| Run | Entries | Entry orders | Vol / h (USDC) | Net bp | 95% range (days) | Before fees bp | Fees bp | Cost / $1M | Double close | Net excl. double | Excl. (gap / open) |",
    );
    L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const x of all) {
      const a = x.all;
      const rate = a.n === 0 ? "n/a" : `${((x.doubleClosed / a.n) * 100).toFixed(1)}%`;
      L.push(
        `| ${name(x)} | ${String(a.n)}${thin(a.n)} | ${String(x.sim.entryOrders)} | ${perH(x)} | ${f1(a.net.mean)} | ${ci(a.net.ciLow, a.net.ciHigh)} (${String(a.net.clusters)}) | ${f1(a.grossBp)} | ${f1(a.feesBp)} | ${f0(a.costPerM)} | ${String(x.doubleClosed)} (${rate}) | ${f1(x.exclDouble.net.mean)} · ${f0(x.exclDouble.costPerM)} | ${String(x.sim.gapExcluded)} / ${String(x.sim.open)} |`,
      );
    }
    L.push("");
    L.push("**Versus random** (bp per trade after fees)");
    L.push("");
    L.push(
      "| Run | Net bp | Own random bp | Own random vol / h | Δ own | Δ own range | Δ R | Δ R range |",
    );
    L.push("|---|---|---|---|---|---|---|---|");
    for (const x of r.rows) {
      const own = x.own;
      const ownVol =
        own === null || x.ownAll === null || r.hours === 0
          ? "n/a"
          : f0(x.ownAll.volume.div(r.hours).div(own.runs));
      L.push(
        `| ${name(x)} | ${f1(x.all.net.mean)} | ${f1(x.ownAll?.net.mean ?? null)} | ${ownVol} | ${f1(x.vsOwn?.diff ?? null)} | ${x.vsOwn === null ? "–" : ci(x.vsOwn.ciLow, x.vsOwn.ciHigh)} | ${f1(x.vsR?.diff ?? null)} | ${x.vsR === null ? "–" : ci(x.vsR.ciLow, x.vsR.ciHigh)} |`,
      );
    }
    const table = (
      title: string,
      keys: readonly string[],
      pick: (x: Row) => Record<string, Cell>,
    ) => {
      L.push("");
      L.push(title);
      L.push("");
      L.push(`| Run | ${keys.join(" | ")} |`);
      L.push(`|---|${keys.map(() => "---").join("|")}|`);
      for (const x of all)
        L.push(
          `| ${name(x)} | ${keys.map((k) => cellText(pick(x)[k] ?? { s: groupStats([]), d: null })).join(" | ")} |`,
        );
    };
    table(
      "**By regime at entry** (trades · net bp (Δ vs own random in the same regime)):",
      REGIMES,
      (x) => x.regimes,
    );
    table(
      "**By ~4 min move before entry, in the trade's direction** (bp; positive = chasing, negative = fading; trades · net bp (Δ vs own random in the same bucket)):",
      [...MOVE_BUCKETS, "n/a"],
      (x) => x.moves,
    );
    table(
      "**Signal entries vs DEC-80 balancing entries** (trades · net bp (Δ vs own random of the same type)):",
      ["signal", "balanced"],
      (x) => ({ signal: x.entryType.signal, balanced: x.entryType.balanced }),
    );
    L.push("");
    L.push("**Halves of the range** (trades · net bp (Δ vs own random) · cost / $1M):");
    L.push("");
    L.push("| Run | 1st half | 2nd half |");
    L.push("|---|---|---|");
    for (const x of all)
      L.push(
        `| ${name(x)} | ${x.halves.map((h) => (h.s.n === 0 ? "–" : `${cellText(h)} · ${f0(h.s.costPerM)}`)).join(" | ")} |`,
      );
  }
  L.push("");
  return L.join("\n");
}
