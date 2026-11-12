import type { BookTop, MinuteCandle } from "../core/types";

// Tín hiệu hướng vào lệnh của Volume Farm: port nguyên công thức FarmMicroSignalEngine của apex
// (src/modules/FarmMicroSignalEngine.ts) — 5 thành phần chuẩn hoá về [0, 1] (0 = giảm, 0.5 = trung tính,
// 1 = tăng), regime từ nến 5 phút, chặn ngược xu hướng và chặn spread rộng. Chỉ là chấm điểm (không phải
// tiền) nên dùng number; mọi giá trị tiền của lệnh vẫn tính bằng Decimal ở index.ts.
// Khác apex: DRIFT chưa có luồng trade gần nhất, nên `tradePressure` luôn trung tính (0.5) và độ tin cậy giảm
// 10% như apex làm khi thiếu dữ liệu trade. Nến 5 phút gộp từ nến 1 phút thay vì gọi REST riêng.

export type FarmDirection = "long" | "short" | "skip";
export type FarmRegime = "SIDEWAY" | "TREND_UP" | "TREND_DOWN" | "HIGH_VOLATILITY" | "UNKNOWN";

export interface FarmSignal {
  direction: FarmDirection;
  score: number;
  confidence: number;
  regime: FarmRegime;
  components: {
    candleMomentum: number;
    wickRejection: number;
    volumeAcceleration: number;
    tradePressure: number;
    orderbookImbalance: number;
  };
  spreadBps: number | null;
  reason: string;
}

interface K {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const ZERO: K = { t: 0, o: 0, h: 0, l: 0, c: 0, v: 0 };

/** Ngưỡng của apex (`.env` FARM_MICRO_*). */
export const FARM_SIGNAL = {
  trendCounterThreshold: 0.7,
  maxCandleAgeSecs: 120,
  minCandles: 10,
  /** Thiếu sổ lệnh và trade: cần đủ ngần này nến. */
  candleOnlyMin: 21,
} as const;

const WEIGHTS = {
  candleMomentum: 0.3,
  wickRejection: 0.25,
  volumeAcceleration: 0.2,
  tradePressure: 0.15,
  orderbookImbalance: 0.1,
} as const;

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

export function ema(values: readonly number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let prev = values[0] ?? 0;
  for (let i = 1; i < values.length; i += 1) prev = (values[i] ?? 0) * k + prev * (1 - k);
  return prev;
}

export function atr(candles: readonly K[], period: number): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i] ?? ZERO;
    const p = candles[i - 1] ?? ZERO;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const recent = trs.slice(-period);
  return recent.length === 0 ? 0 : recent.reduce((a, b) => a + b, 0) / recent.length;
}

/** SR-1 (30%): lợi nhuận 3 nến gần nhất + khoảng cách EMA5 / EMA13, chuẩn hoá theo ATR. */
export function scoreCandleMomentum(candles: readonly K[]): number {
  if (candles.length < 14) return 0.5;
  const closes = candles.map((c) => c.c);
  const n = closes.length;
  const last = closes[n - 1] ?? 0;
  const before = closes[n - 4] ?? 0;
  if (before <= 0 || last <= 0) return 0.5;
  const ret3 = (last - before) / before;
  const a = atr(candles, 14);
  if (a <= 0) return 0.5;
  const raw = (ret3 / (a / last)) * 0.6 + ((ema(closes, 5) - ema(closes, 13)) / a) * 0.4;
  return clamp01(0.5 + Math.max(-2.5, Math.min(2.5, raw)) * 0.15);
}

/** SR-2 (25%): râu nến từ chối + vị trí giá đóng cửa, 2 nến gần nhất (60% / 40%). */
export function scoreWickRejection(candles: readonly K[]): number {
  if (candles.length < 2) return 0.5;
  const weights = [0.6, 0.4];
  let total = 0;
  for (let i = 0; i < 2; i += 1) {
    const c = candles[candles.length - 1 - i] ?? ZERO;
    const w = weights[i] ?? 0;
    const range = c.h - c.l;
    if (range <= 0) {
      total += 0.5 * w;
      continue;
    }
    const lowerWick = (Math.min(c.o, c.c) - c.l) / range;
    const upperWick = (c.h - Math.max(c.o, c.c)) / range;
    const closePos = (c.c - c.l) / range;
    let score: number;
    if (lowerWick > 0.4 && closePos > 0.6) score = 0.5 + lowerWick * closePos * 0.5;
    else if (upperWick > 0.4 && closePos < 0.4) score = 0.5 - upperWick * (1 - closePos) * 0.5;
    else score = 0.5 + (closePos - 0.5) * 0.3;
    total += clamp01(score) * w;
  }
  return clamp01(total);
}

/** SR-3 (20%): khối lượng 3 nến gần nhất so với 10 nến trước, chỉ tính khi giá đi có hướng. */
export function scoreVolumeAcceleration(candles: readonly K[]): number {
  if (candles.length < 14) return 0.5;
  const n = candles.length;
  const recent = candles.slice(n - 3);
  const prior = candles.slice(n - 13, n - 3);
  const avgRecent = recent.reduce((s, c) => s + c.v, 0) / 3;
  const avgPrior = prior.reduce((s, c) => s + c.v, 0) / Math.max(prior.length, 1);
  if (avgPrior <= 0) return 0.5;
  const ratio = avgRecent / avgPrior;
  const first = recent[0] ?? ZERO;
  const last = recent[2] ?? ZERO;
  const change = last.c - first.o;
  const range = Math.max(...recent.map((c) => c.h)) - Math.min(...recent.map((c) => c.l));
  const directionality = range > 0 ? Math.abs(change) / range : 0;
  if (ratio > 1 && directionality > 0.3) {
    const boost = Math.min((ratio - 1) * 0.5, 0.4);
    return clamp01(0.5 + (change > 0 ? 1 : -1) * boost * directionality);
  }
  return 0.5;
}

/** SR-5 (10%): notional bên mua / tổng, giảm nhiễu 20%. Sổ rỗng hoặc chéo → trung tính. */
export function scoreOrderbookImbalance(book: BookTop | null): number {
  if (book === null) return 0.5;
  const bid = Number(book.bid);
  const ask = Number(book.ask);
  const b = Number(book.bidNotional);
  const a = Number(book.askNotional);
  if (!(bid > 0) || !(ask > bid) || !(a + b > 0)) return 0.5;
  return clamp01(0.5 + (b / (a + b) - 0.5) * 0.8);
}

/** Regime từ nến 5 phút: ATR > 0.5% giá → biến động cao; giá ngoài EMA21 ± 0.2% → có xu hướng. */
export function detectRegime(candles5m: readonly K[]): FarmRegime {
  if (candles5m.length < 15) return "UNKNOWN";
  const closes = candles5m.map((c) => c.c);
  const price = closes[closes.length - 1] ?? 0;
  const atrPct = price > 0 ? atr(candles5m, 14) / price : 0;
  if (atrPct > 0.005) return "HIGH_VOLATILITY";
  const e21 = ema(closes, 21);
  if (price > e21 * 1.002) return "TREND_UP";
  if (price < e21 * 0.998) return "TREND_DOWN";
  return "SIDEWAY";
}

/** Gộp nến 1 phút thành nến 5 phút theo mốc 5 phút; bỏ nhóm chưa đủ 5 nến. */
export function toFiveMinute(candles: readonly K[]): K[] {
  const groups = new Map<number, K[]>();
  for (const c of candles) {
    const key = Math.floor(c.t / 300_000) * 300_000;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.entries()]
    .filter(([, g]) => g.length === 5)
    .sort(([a], [b]) => a - b)
    .map(([t, g]) => ({
      t,
      o: (g[0] ?? ZERO).o,
      h: Math.max(...g.map((c) => c.h)),
      l: Math.min(...g.map((c) => c.l)),
      c: (g.at(-1) ?? ZERO).c,
      v: g.reduce((s, c) => s + c.v, 0),
    }));
}

/** Nến hợp lệ, sắp theo thời gian, bỏ trùng và bỏ nến chưa đóng (giống `validateCandles` của apex). */
export function validCandles(raw: readonly MinuteCandle[], now: number): K[] {
  const out: K[] = [];
  let lastT = -1;
  for (const r of [...raw].sort((a, b) => a.t - b.t)) {
    if (r.t === lastT) continue;
    const k = {
      t: r.t,
      o: Number(r.o),
      h: Number(r.h),
      l: Number(r.l),
      c: Number(r.c),
      v: Number(r.v),
    };
    if (
      ![k.o, k.h, k.l, k.c, k.v].every(Number.isFinite) ||
      k.o <= 0 ||
      k.l <= 0 ||
      k.c <= 0 ||
      k.v < 0 ||
      k.h < k.l
    )
      continue;
    out.push(k);
    lastT = r.t;
  }
  const last = out.at(-1);
  // Nến đóng đúng lúc `now` (backtest gửi timer ở ms cuối của nến) vẫn tính là đã đóng.
  if (last !== undefined && last.t + 60_000 > now + 1) out.pop();
  return out;
}

const skip = (reason: string, regime: FarmRegime = "UNKNOWN"): FarmSignal => ({
  direction: "skip",
  score: 0.5,
  confidence: 0,
  regime,
  components: {
    candleMomentum: 0.5,
    wickRejection: 0.5,
    volumeAcceleration: 0.5,
    tradePressure: 0.5,
    orderbookImbalance: 0.5,
  },
  spreadBps: null,
  reason,
});

/**
 * Điểm tổng hợp và hướng (FARM luôn giao dịch: score ≥ 0.5 → long, < 0.5 → short), trừ khi regime chặn ngược
 * xu hướng, spread vượt `maxSpreadBps`, nến cũ quá 120 s hoặc không đủ nến.
 */
export function farmSignal(
  raw: readonly MinuteCandle[],
  book: BookTop | null,
  now: number,
  maxSpreadBps: number,
): FarmSignal {
  const candles = validCandles(raw, now);
  if (candles.length < FARM_SIGNAL.minCandles)
    return skip(`INSUFFICIENT_CANDLES: only ${String(candles.length)} completed 1m candles`);
  const age = (now - ((candles.at(-1)?.t ?? 0) + 60_000)) / 1000;
  if (age > FARM_SIGNAL.maxCandleAgeSecs)
    return skip(`STALE_CANDLES: newest candle closed ${age.toFixed(0)} s ago`);
  if (book === null && candles.length < FARM_SIGNAL.candleOnlyMin)
    return skip("INSUFFICIENT_CANDLES: candle-only mode needs 21 candles");

  const components = {
    candleMomentum: scoreCandleMomentum(candles),
    wickRejection: scoreWickRejection(candles),
    volumeAcceleration: scoreVolumeAcceleration(candles),
    tradePressure: 0.5,
    orderbookImbalance: scoreOrderbookImbalance(book),
  };
  const regime = detectRegime(toFiveMinute(candles));
  const score = clamp01(
    components.candleMomentum * WEIGHTS.candleMomentum +
      components.wickRejection * WEIGHTS.wickRejection +
      components.volumeAcceleration * WEIGHTS.volumeAcceleration +
      components.tradePressure * WEIGHTS.tradePressure +
      components.orderbookImbalance * WEIGHTS.orderbookImbalance,
  );
  const vals = Object.values(components);
  const sign = score >= 0.5 ? 1 : -1;
  const agreeing = vals.filter((v) => (v - 0.5) * sign > 0).length / vals.length;
  const disagreement = Math.max(...vals) - Math.min(...vals);
  let confidence = clamp01(
    agreeing * 0.5 + Math.abs(score - 0.5) * 2 * 0.3 + (1 - disagreement * 0.5) * 0.2,
  );
  if (Math.abs(score - 0.5) < 0.03) confidence = Math.min(confidence, 0.3);
  if (candles.length < 21) confidence *= 0.8;
  confidence *= 0.9; // chưa có trade gần nhất
  if (book === null) confidence *= 0.9;

  let direction: FarmDirection = score >= 0.5 ? "long" : "short";
  let reason = `${direction.toUpperCase()}: score ${score.toFixed(3)}, regime ${regime}`;
  const t = FARM_SIGNAL.trendCounterThreshold;
  if (
    (regime === "TREND_UP" && direction === "short" && score > 1 - t) ||
    (regime === "TREND_DOWN" && direction === "long" && score < t)
  ) {
    direction = "skip";
    reason = `COUNTER_TREND_BLOCKED: ${regime} blocked ${score >= 0.5 ? "long" : "short"} (score ${score.toFixed(3)})`;
  }
  let spreadBps: number | null = null;
  if (book !== null) {
    const bid = Number(book.bid);
    const ask = Number(book.ask);
    const mid = (bid + ask) / 2;
    if (mid > 0) spreadBps = ((ask - bid) / mid) * 10_000;
  }
  if (direction !== "skip" && spreadBps !== null && spreadBps > maxSpreadBps) {
    direction = "skip";
    reason = `SPREAD_TOO_WIDE: ${spreadBps.toFixed(1)} bp > ${String(maxSpreadBps)} bp`;
  }
  return {
    direction,
    score,
    confidence: clamp01(confidence),
    regime,
    components,
    spreadBps,
    reason,
  };
}
