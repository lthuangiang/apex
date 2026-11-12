import type { Candle } from "../backtest/run";

import type { VolumeFarmConfig } from "./schema";

// Review sau khi chạy của Volume Builder (DEC-131). Không backtest toàn phần (backtest 1 phút đã cho 304 USDC mỗi 1M
// khi thực tế là 222): giữ nguyên các lệnh vào thật của bot (giờ, chiều, giá, khối lượng) và chỉ chạy lại lối thoát
// trên nến 1 phút với từng bộ tham số. So sánh luôn giữa các bộ cùng mô phỏng, không so mô phỏng với thực tế.
// Chống overfit: chọn trên 70% lượt đầu, phải tốt hơn bộ hiện tại cả ở 30% lượt sau, rồi bootstrap theo cặp; chỉ đề
// xuất khi cận trên khoảng tin cậy 95% của mức chênh dưới 0.

export interface ReviewFill {
  /** Tag của lệnh: `vf:<lượt>:in:<n>`, `vf:<lượt>:out:<n>` hoặc `vf:<lượt>:sl`. */
  tag: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  /** Đã gồm builder fee. */
  fee: number;
  builderFee: number;
  isMaker: boolean;
  at: number;
}

export interface ReviewTrade {
  /** Số lượt trong tag `vf:<lượt>:…` (có thể lặp lại giữa các lần chạy; khoá duy nhất là `t0`). */
  cycle: number;
  t0: number;
  t1: number;
  long: boolean;
  qty: number;
  entry: number;
  exit: number;
  notional: number;
  volume: number;
  gross: number;
  fees: number;
  builderFees: number;
  allMaker: boolean;
  /** Volume của các fill maker (Strategy Analytics, DEC-141). */
  makerVolume: number;
  /** Lượt đóng bởi stop loss gốc trên SoDEX (tag `:sl`). */
  exitByStop: boolean;
}

/** Tham số được thử. SL theo % margin (DEC-126), early profit theo bội số phí khứ hồi (DEC-130). */
export interface ReviewParams {
  earlyProfitFees: number;
  earlyExitSecs: number;
  minHoldSecs: number;
  maxHoldSecs: number;
  slMarginPct: number;
}

export interface ReviewScore {
  costPerMillion: number;
  winRatePct: number;
}

export type ReviewResult =
  | { status: "insufficient"; trades: number; minTrades: number }
  | {
      status: "done";
      trades: number;
      from: number;
      to: number;
      volume: number;
      actual: {
        costPerMillion: number;
        feesPerMillion: number;
        builderPerMillion: number;
        pricePerMillion: number;
        winRatePct: number;
      };
      current: { params: ReviewParams } & ReviewScore;
      best: {
        params: ReviewParams;
        deltaPerMillion: number;
        ciLow: number;
        ciHigh: number;
        inSample: number;
        outOfSample: number;
        currentInSample: number;
        currentOutOfSample: number;
      } & ReviewScore;
      /** = `suggestion === "strong"` (giữ cho kết quả đã lưu trước khi có `suggestion`). */
      recommended: boolean;
      /**
       * `strong`: tốt hơn ở cả hai phần dữ liệu và khoảng tin cậy 95% của mức chênh dưới 0 (DEC-142).
       * `weak`: chỉ còn ở kết quả lưu trước DEC-142 (đề xuất chưa chắc, DEC-134). `none`: không bộ nào thắng chắc chắn.
       */
      suggestion: "strong" | "weak" | "none";
      tested: number;
      takerShare: {
        trades: number;
        takerCostPerMillion: number | null;
        makerCostPerMillion: number | null;
      };
    };

/**
 * Chỉ cần 1 lượt để chạy (DEC-134): ít dữ liệu thì vẫn đề xuất nhưng ở mức `weak`, kèm cảnh báo. Đề xuất `strong` cần
 * `REVIEW_STRONG_TRADES` lượt (DEC-134, không còn dùng để quyết định từ DEC-142); dưới `REVIEW_SOLID_TRADES` UI ghi mẫu nhỏ.
 */
export const REVIEW_MIN_TRADES = 1;
export const REVIEW_STRONG_TRADES = 50;
export const REVIEW_SOLID_TRADES = 200;
/** Ít hơn ngần này lượt thì không chia 70 / 30 (phần sau quá ít để kiểm). */
const SPLIT_MIN_TRADES = 20;
/** Lượt khớp lẻ vài USDC (khớp một phần) không đại diện cho lối thoát. */
const MIN_NOTIONAL = 5;
const SPLIT = 0.7;
const BOOT = 1000;
/** Số phút tối đa mô phỏng sau khi vào lệnh (giữ lâu nhất 600 s, dư cho phút lẻ). */
const HORIZON_MIN = 15;

export const REVIEW_GRID = {
  earlyProfitFees: [1.5, 2, 3, 5, 20],
  earlyExitSecs: [10, 60, 120],
  hold: [
    [120, 180],
    [180, 300],
    [300, 600],
  ] as [number, number][],
  /** Bội số của SL hiện tại (% margin), kẹp trong 1–90%. */
  slScale: [0.5, 1, 2],
} as const;

const TAG = /^vf:(\d+):(in|out|sl)/;

/** Ghép fill thành lượt: các fill vào của một lượt, rồi fill ra (bot hoặc stop trên SoDEX) tới khi hết vị thế. */
export function buildTrades(fills: readonly ReviewFill[]): ReviewTrade[] {
  const sorted = [...fills].sort((a, b) => a.at - b.at);
  const out: ReviewTrade[] = [];
  interface Open {
    cycle: number;
    ins: ReviewFill[];
    outs: ReviewFill[];
  }
  let cur = null as Open | null;
  const close = () => {
    if (cur === null || cur.ins.length === 0 || cur.outs.length === 0) return;
    const qIn = sum(cur.ins, (f) => f.size);
    const qOut = sum(cur.outs, (f) => f.size);
    if (qOut < qIn * 0.999) return;
    const first = cur.ins[0];
    const last = cur.outs.at(-1);
    if (first === undefined || last === undefined) return;
    const entry = sum(cur.ins, (f) => f.price * f.size) / qIn;
    const exit = sum(cur.outs, (f) => f.price * f.size) / qOut;
    const long = first.side === "buy";
    const all = [...cur.ins, ...cur.outs];
    out.push({
      cycle: cur.cycle,
      t0: first.at,
      t1: last.at,
      long,
      qty: qIn,
      entry,
      exit,
      notional: qIn * entry,
      volume: qIn * entry + qOut * exit,
      gross: (long ? exit - entry : entry - exit) * qIn,
      fees: sum(all, (f) => f.fee),
      builderFees: sum(all, (f) => f.builderFee),
      allMaker: all.every((f) => f.isMaker),
      makerVolume: sum(
        all.filter((f) => f.isMaker),
        (f) => f.price * f.size,
      ),
      exitByStop: cur.outs.some((f) => f.tag.endsWith(":sl")),
    });
  };
  for (const f of sorted) {
    const m = TAG.exec(f.tag);
    if (m === null) continue;
    const cycle = Number(m[1]);
    const kind = m[2];
    if (kind === "in" && (cur?.cycle !== cycle || cur.outs.length > 0)) {
      close();
      cur = { cycle, ins: [], outs: [] };
    }
    if (cur === null) continue;
    if (kind === "in") cur.ins.push(f);
    else cur.outs.push(f);
  }
  close();
  return out;
}

function sum<T>(xs: readonly T[], f: (x: T) => number): number {
  let s = 0;
  for (const x of xs) s += f(x);
  return s;
}

/** Số ngẫu nhiên xác định theo seed (mulberry32): cùng dữ liệu luôn cho cùng kết quả. */
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

/** Thời gian giữ của lượt trong [min, max], cố định theo lượt để các bộ tham số so cùng một mẫu. */
function holdOf(t: ReviewTrade, lo: number, hi: number): number {
  const h = Math.abs(Math.sin(t.t0 / 1000) * 10_000) % 1;
  return lo + (hi - lo) * h;
}

/** Lý do lượt thoát trong replay: stop loss (lệnh SL gốc trên SoDEX), TP, early profit, hết giờ giữ, hết nến. */
export type ReplayExit = "sl" | "tp" | "early" | "hold" | "end";

interface Sim {
  /** Lãi giá (tỷ lệ của notional) và phí (tỷ lệ của notional, hai chiều). */
  gross: number;
  fee: number;
  exit: ReplayExit;
}

/**
 * Lối thoát trên nến 1 phút từ đúng giá / giờ vào thật, theo thứ tự của `exitReason`: SL (market, phí taker; xét
 * trước trong cùng phút cho bảo thủ) → TP → early profit (sau `earlyExitSecs`) → hết thời gian giữ (giá đóng nến).
 */
function simulate(
  t: ReviewTrade,
  p: ReviewParams,
  c: { tpUsd: number; leverage: number },
  candles: ReadonlyMap<number, Candle>,
  fee: { maker: number; taker: number },
): Sim {
  const rt = 2 * fee.maker;
  const sl = p.slMarginPct / 100 / c.leverage;
  const tp = Math.max(c.tpUsd / t.notional, 1.5 * rt);
  const early = p.earlyProfitFees * rt;
  const hold = holdOf(t, p.minHoldSecs, p.maxHoldSecs);
  const m0 = Math.floor(t.t0 / 60_000);
  let lastClose = t.entry;
  for (let k = 1; k <= HORIZON_MIN; k += 1) {
    const m = (m0 + k) * 60_000;
    const k1 = candles.get(m);
    if (k1 === undefined) continue;
    const h = Number(k1.h);
    const l = Number(k1.l);
    const close = Number(k1.c);
    lastClose = close;
    const fav = t.long ? (h - t.entry) / t.entry : (t.entry - l) / t.entry;
    const adv = t.long ? (t.entry - l) / t.entry : (h - t.entry) / t.entry;
    const elapsed = (m + 60_000 - t.t0) / 1000;
    if (adv >= sl) return { gross: -sl, fee: fee.maker + fee.taker, exit: "sl" };
    if (fav >= tp) return { gross: tp, fee: rt, exit: "tp" };
    if (elapsed >= p.earlyExitSecs && fav >= early) return { gross: early, fee: rt, exit: "early" };
    if (elapsed >= hold)
      return { gross: ((close - t.entry) / t.entry) * (t.long ? 1 : -1), fee: rt, exit: "hold" };
  }
  return { gross: ((lastClose - t.entry) / t.entry) * (t.long ? 1 : -1), fee: rt, exit: "end" };
}

/** Lãi / lỗ của từng lượt theo USDC: [phí − lãi giá, volume]. */
type Row = readonly [cost: number, volume: number, win: boolean];

function rows(
  trades: readonly ReviewTrade[],
  p: ReviewParams,
  c: { tpUsd: number; leverage: number },
  candles: ReadonlyMap<number, Candle>,
  fee: { maker: number; taker: number },
): Row[] {
  return trades.map((t) => {
    const s = simulate(t, p, c, candles, fee);
    return [(s.fee - s.gross) * t.notional, 2 * t.notional, s.gross > 0] as const;
  });
}

function cpm(rs: readonly Row[], idx?: readonly number[]): number {
  let cost = 0;
  let vol = 0;
  if (idx === undefined)
    for (const r of rs) {
      cost += r[0];
      vol += r[1];
    }
  else
    for (const i of idx) {
      const r = rs[i];
      if (r === undefined) continue;
      cost += r[0];
      vol += r[1];
    }
  return vol === 0 ? 0 : (cost / vol) * 1e6;
}

const win = (rs: readonly Row[]) =>
  rs.length === 0 ? 0 : (rs.filter((r) => r[2]).length / rs.length) * 100;

/** Tham số hiện tại của bot quy về dạng được thử (config cũ: SL % giá → % margin, early profit USDC bỏ qua). */
export function currentParams(c: VolumeFarmConfig): ReviewParams {
  const sl = c.slPct === undefined ? Number(c.slMarginPct) : Number(c.slPct) * c.leverage;
  return {
    earlyProfitFees: Number(c.earlyProfitFees),
    earlyExitSecs: c.earlyExitSecs,
    minHoldSecs: c.minHoldSecs,
    maxHoldSecs: c.maxHoldSecs,
    slMarginPct: Math.min(90, Math.max(1, sl)),
  };
}

const sameParams = (a: ReviewParams, b: ReviewParams) =>
  a.earlyProfitFees === b.earlyProfitFees &&
  a.earlyExitSecs === b.earlyExitSecs &&
  a.minHoldSecs === b.minHoldSecs &&
  a.maxHoldSecs === b.maxHoldSecs &&
  a.slMarginPct === b.slMarginPct;

/** Lượt dùng cho replay: ghép từ fill, bỏ lượt khớp lẻ vài USDC, xếp theo giờ vào. */
export function reviewTrades(fills: readonly ReviewFill[]): ReviewTrade[] {
  return buildTrades(fills)
    .filter((t) => t.notional >= MIN_NOTIONAL)
    .sort((a, b) => a.t0 - b.t0);
}

/** Phí mỗi chiều thật của bot (tỷ lệ notional) theo maker / taker; thiếu loại nào thì dùng mức dự phòng. */
export function realFeeRates(
  fills: readonly ReviewFill[],
  fallback: { maker: number; taker: number },
): { maker: number; taker: number } {
  let mf = 0;
  let mv = 0;
  let tf = 0;
  let tv = 0;
  for (const f of fills) {
    const n = f.price * f.size;
    if (f.isMaker) {
      mf += f.fee;
      mv += n;
    } else {
      tf += f.fee;
      tv += n;
    }
  }
  return { maker: mv > 0 ? mf / mv : fallback.maker, taker: tv > 0 ? tf / tv : fallback.taker };
}

/** Một phương án để replay: tham số lối ra + đòn bẩy (đổi khoảng SL theo % margin). */
export interface ReplayOption {
  params: ReviewParams;
  leverage: number;
}

export interface ReplayOutcome {
  trades: number;
  /** Lãi / lỗ ròng (USDC) = Σ (lãi giá − phí) × notional. */
  net: number;
  volume: number;
  /** Lượt thoát bằng stop loss gốc trên SoDEX. Không mô phỏng thanh lý (DEC-172). */
  slExits: number;
  /** Lượt tệ nhất (USDC, âm là lỗ); null khi không có lượt. */
  worstTrade: number | null;
  winRatePct: number;
  /** Ký quỹ mỗi lượt = notional trung vị ÷ đòn bẩy (USDC); null khi không có lượt. */
  marginPerTrade: number | null;
}

/**
 * What-if của AI Desk B+ (DEC-166): replay **lối ra** của từng phương án trên đúng lượt vào thật (cùng cách của Review
 * this run, DEC-131). Lượt vào, notional và thời điểm giữ nguyên; chỉ lối ra đổi. Tất định: cùng dữ liệu, cùng kết quả.
 */
export function replayOptions(input: {
  trades: readonly ReviewTrade[];
  candles: readonly Candle[];
  tpUsd: number;
  fee: { maker: number; taker: number };
  options: readonly ReplayOption[];
}): ReplayOutcome[] {
  const candles = new Map(input.candles.map((k) => [k.t, k]));
  const notionals = input.trades.map((t) => t.notional).sort((a, b) => a - b);
  const mid =
    notionals.length === 0 ? null : (notionals[Math.floor((notionals.length - 1) / 2)] ?? null);
  return input.options.map((o) => {
    let net = 0;
    let volume = 0;
    let slExits = 0;
    let wins = 0;
    let worst: number | null = null;
    for (const t of input.trades) {
      const s = simulate(
        t,
        o.params,
        { tpUsd: input.tpUsd, leverage: o.leverage },
        candles,
        input.fee,
      );
      const r = (s.gross - s.fee) * t.notional;
      net += r;
      volume += 2 * t.notional;
      if (s.exit === "sl") slExits += 1;
      if (s.gross > 0) wins += 1;
      worst = worst === null || r < worst ? r : worst;
    }
    const n = input.trades.length;
    return {
      trades: n,
      net,
      volume,
      slExits,
      worstTrade: worst,
      winRatePct: n === 0 ? 0 : (wins / n) * 100,
      marginPerTrade: mid === null ? null : mid / o.leverage,
    };
  });
}

export function reviewVolumeFarm(input: {
  config: VolumeFarmConfig;
  fills: readonly ReviewFill[];
  candles: readonly Candle[];
  /** Phí mỗi chiều (tỷ lệ, đã gồm builder fee); thiếu fill taker thì dùng mức của sàn. */
  fallbackFee: { maker: number; taker: number };
  seed: number;
}): ReviewResult {
  const trades = reviewTrades(input.fills);
  if (trades.length < REVIEW_MIN_TRADES)
    return { status: "insufficient", trades: trades.length, minTrades: REVIEW_MIN_TRADES };

  // Phí thật của bot theo từng loại lệnh.
  const fee = realFeeRates(input.fills, input.fallbackFee);
  const candles = new Map(input.candles.map((k) => [k.t, k]));
  const c = { tpUsd: Number(input.config.tpUsd), leverage: input.config.leverage };

  const volume = sum(trades, (t) => t.volume);
  const feesAll = sum(trades, (t) => t.fees);
  const grossAll = sum(trades, (t) => t.gross);
  const actual = {
    costPerMillion: ((feesAll - grossAll) / volume) * 1e6,
    feesPerMillion: (feesAll / volume) * 1e6,
    builderPerMillion: (sum(trades, (t) => t.builderFees) / volume) * 1e6,
    pricePerMillion: (-grossAll / volume) * 1e6,
    winRatePct: (trades.filter((t) => t.gross > 0).length / trades.length) * 100,
  };

  const cut = Math.floor(trades.length * SPLIT);
  const isIdx = Array.from({ length: cut }, (_, i) => i);
  const oosIdx = Array.from({ length: trades.length - cut }, (_, i) => cut + i);

  const cur = currentParams(input.config);
  const curRows = rows(trades, cur, c, candles, fee);
  const slBase = cur.slMarginPct;
  let tested = 0;
  const split = trades.length >= SPLIT_MIN_TRADES;
  let best: { p: ReviewParams; rs: Row[]; is: number; oos: number } | null = null;
  /** Bộ rẻ nhất trên toàn bộ lượt (đề xuất `weak` khi không bộ nào qua được kiểm tra hai phần). */
  let cheapest: { p: ReviewParams; rs: Row[]; is: number; oos: number; all: number } | null = null;
  const curIs = cpm(curRows, isIdx);
  const curOos = cpm(curRows, oosIdx);
  const curAll = cpm(curRows);
  for (const ep of REVIEW_GRID.earlyProfitFees)
    for (const es of REVIEW_GRID.earlyExitSecs)
      for (const [lo, hi] of REVIEW_GRID.hold)
        for (const sc of REVIEW_GRID.slScale) {
          const p: ReviewParams = {
            earlyProfitFees: ep,
            earlyExitSecs: es,
            minHoldSecs: lo,
            maxHoldSecs: hi,
            slMarginPct: Math.round(Math.min(90, Math.max(1, slBase * sc)) * 10) / 10,
          };
          tested += 1;
          const rs = rows(trades, p, c, candles, fee);
          const is = cpm(rs, isIdx);
          const oos = cpm(rs, oosIdx);
          const allCpm = cpm(rs);
          if (allCpm < curAll && (cheapest === null || allCpm < cheapest.all))
            cheapest = { p, rs, is, oos, all: allCpm };
          // Đề xuất chắc: tốt hơn bộ hiện tại ở cả hai phần dữ liệu; trong số đó chọn bộ tốt nhất ở phần đầu.
          if (!split || is >= curIs || oos >= curOos) continue;
          if (best === null || is < best.is) best = { p, rs, is, oos };
        }

  const pick = best ?? cheapest ?? { p: cur, rs: curRows, is: curIs, oos: curOos };
  // Khoảng tin cậy tính trên phần 30% lượt mà bộ tham số KHÔNG được chọn trên đó (DEC-142): tính trên cả dữ liệu đã
  // dùng để chọn thì bộ tốt nhất trong 135 bộ luôn trông tốt hơn thực tế. Không chia được thì dùng toàn bộ (và khi đó
  // không đề xuất vì `best` null).
  const r = rng(input.seed);
  const diffs: number[] = [];
  const pool = split ? oosIdx : trades.map((_, i) => i);
  const m = pool.length;
  const idx: number[] = new Array<number>(m).fill(0);
  for (let b = 0; b < BOOT; b += 1) {
    for (let i = 0; i < m; i += 1) idx[i] = pool[Math.floor(r() * m)] ?? 0;
    diffs.push(cpm(pick.rs, idx) - cpm(curRows, idx));
  }
  diffs.sort((a, b) => a - b);
  const ciLow = diffs[Math.floor(BOOT * 0.025)] ?? 0;
  const ciHigh = diffs[Math.floor(BOOT * 0.975)] ?? 0;
  const delta = cpm(pick.rs) - cpm(curRows);
  const changed = !sameParams(pick.p, cur) && delta < 0;
  // Chỉ đề xuất khi bộ mới thắng cài đặt hiện tại ở cả 70% lượt đầu và 30% lượt sau VÀ rẻ hơn trong 95% lần lấy mẫu
  // lại (DEC-142). Không qua thì không đề xuất gì: bộ "rẻ nhất trên cùng dữ liệu" luôn tồn tại nên dễ thành đề xuất bậy.
  // `weak` không còn được sinh ra; giữ trong kiểu cho kết quả đã lưu trước đây.
  const suggestion: "strong" | "weak" | "none" =
    changed && best !== null && ciHigh < 0 ? "strong" : "none";

  const taker = trades.filter((t) => !t.allMaker);
  const maker = trades.filter((t) => t.allMaker);
  const realCpm = (ts: readonly ReviewTrade[]) => {
    const v = sum(ts, (t) => t.volume);
    return ts.length === 0 || v === 0
      ? null
      : ((sum(ts, (t) => t.fees) - sum(ts, (t) => t.gross)) / v) * 1e6;
  };

  return {
    status: "done",
    trades: trades.length,
    from: trades[0]?.t0 ?? 0,
    to: trades.at(-1)?.t1 ?? 0,
    volume,
    actual,
    current: { params: cur, costPerMillion: cpm(curRows), winRatePct: win(curRows) },
    best: {
      params: pick.p,
      costPerMillion: cpm(pick.rs),
      winRatePct: win(pick.rs),
      deltaPerMillion: delta,
      ciLow,
      ciHigh,
      inSample: pick.is,
      outOfSample: pick.oos,
      currentInSample: curIs,
      currentOutOfSample: curOos,
    },
    recommended: suggestion === "strong",
    suggestion,
    tested,
    takerShare: {
      trades: taker.length,
      takerCostPerMillion: realCpm(taker),
      makerCostPerMillion: realCpm(maker),
    },
  };
}
