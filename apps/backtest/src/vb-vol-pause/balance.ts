import type { Candle } from "@drift/strategies";

// #363 phần 2: lượt vào để cân khối lượng long / short (snapshot `balanced`) khi thị trường đang chạy mạnh. Hàm thuần.
// Thị trường "chạy mạnh" ở nhịp quyết định ngay sau khi nến i đóng: |close(i) − close(i − 5)| ÷ close(i − 5) (bp, giá đã
// chạy 5 phút) lớn hơn 2 × trung vị của chính số đó trên 60 nến đã đóng trước i. Chỉ dùng nến đã đóng (không nhìn
// trước). Chưa đủ 65 nến trước, hoặc 5 phút trước thiếu nến → không xếp loại.

const MIN = 60_000;
const DAY = 86_400_000;
export const MOVE_MINUTES = 5;
export const TYPICAL_WINDOW = 60;
export const STRONG_FACTOR = 2;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Giờ mở của nến → true (chạy mạnh) / false (êm). Nến không xếp loại được thì không có trong map. */
export function marketState(candles: readonly Candle[]): Map<number, boolean> {
  const move: (number | null)[] = candles.map((c, i) => {
    const p = candles[i - MOVE_MINUTES];
    if (p === undefined || c.t - p.t !== MOVE_MINUTES * MIN) return null;
    const a = Number(p.c);
    return a > 0 ? (Math.abs(Number(c.c) - a) / a) * 10_000 : null;
  });
  const out = new Map<number, boolean>();
  candles.forEach((c, i) => {
    const v = move[i];
    if (v === null || v === undefined || i < TYPICAL_WINDOW + MOVE_MINUTES) return;
    const prior = move.slice(i - TYPICAL_WINDOW, i).filter((x): x is number => x !== null);
    if (prior.length < TYPICAL_WINDOW / 2) return;
    const typical = median(prior);
    out.set(c.t, typical > 0 && v > STRONG_FACTOR * typical);
  });
  return out;
}

export interface SplitTrade {
  at: number;
  /** Kết quả sau phí theo bp trên giá trị vào (số thực để thống kê). */
  netBp: number;
  net: number;
  volume: number;
  balanced: boolean;
  decidedT: number | null;
}

export type Group = "signal · calm" | "signal · strong" | "balance · calm" | "balance · strong";
export const GROUPS: readonly Group[] = [
  "signal · calm",
  "signal · strong",
  "balance · calm",
  "balance · strong",
];

export function groupOf(t: SplitTrade, state: ReadonlyMap<number, boolean>): Group | null {
  const s = t.decidedT === null ? undefined : state.get(t.decidedT);
  if (s === undefined) return null;
  return `${t.balanced ? "balance" : "signal"} · ${s ? "strong" : "calm"}`;
}

export interface Ci {
  v: number | null;
  lo: number | null;
  hi: number | null;
}

export interface GroupRow {
  group: Group;
  n: number;
  /** Trung bình kết quả sau phí (bp) [95%]. */
  meanBp: Ci;
  winPct: number | null;
  costPerM: number | null;
}

export interface SplitReport {
  rows: GroupRow[];
  /** Trung bình bp: lượt cân − lượt tín hiệu trong cùng trạng thái thị trường [95%]. */
  diffCalm: Ci;
  diffStrong: Ci;
  unclassified: number;
}

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
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))] ?? NaN;
};
const B = 2000;

/**
 * Tách lượt theo (tín hiệu / cân) × (êm / chạy mạnh). Khoảng 95%: block bootstrap theo ngày UTC (2,000 lần, seed cố định),
 * mỗi lần lấy lại các ngày có lặp rồi tính trung bình bp của nhóm trên các lượt của những ngày đó.
 */
export function balanceSplit(
  trades: readonly SplitTrade[],
  state: ReadonlyMap<number, boolean>,
  days: readonly number[],
): SplitReport {
  const byDay = new Map<number, Map<Group, number[]>>();
  let unclassified = 0;
  const all = new Map<Group, SplitTrade[]>();
  for (const t of trades) {
    const g = groupOf(t, state);
    if (g === null) {
      unclassified += 1;
      continue;
    }
    all.set(g, [...(all.get(g) ?? []), t]);
    const k = Math.floor(t.at / DAY);
    const d = byDay.get(k) ?? new Map<Group, number[]>();
    d.set(g, [...(d.get(g) ?? []), t.netBp]);
    byDay.set(k, d);
  }
  const meanOf = (idx: readonly number[], g: Group) => {
    let s = 0;
    let n = 0;
    for (const k of idx)
      for (const v of byDay.get(k)?.get(g) ?? []) {
        s += v;
        n += 1;
      }
    return n === 0 ? NaN : s / n;
  };
  const r = rng(3632);
  const samples = GROUPS.map(() => [] as number[]);
  const dCalm: number[] = [];
  const dStrong: number[] = [];
  if (days.length >= 2)
    for (let i = 0; i < B; i += 1) {
      const idx = days.map(() => days[Math.floor(r() * days.length)] ?? 0);
      const m = GROUPS.map((g) => meanOf(idx, g));
      m.forEach((v, j) => {
        if (Number.isFinite(v)) samples[j]?.push(v);
      });
      const [sc, ss, bc, bs] = m as [number, number, number, number];
      if (Number.isFinite(bc - sc)) dCalm.push(bc - sc);
      if (Number.isFinite(bs - ss)) dStrong.push(bs - ss);
    }
  const ci = (v: number, xs: number[]): Ci => ({
    v: Number.isFinite(v) ? v : null,
    lo: xs.length < 100 ? null : pct(xs, 0.025),
    hi: xs.length < 100 ? null : pct(xs, 0.975),
  });
  const point = GROUPS.map((g) => meanOf(days, g));
  const rows = GROUPS.map((g, j): GroupRow => {
    const ts = (all.get(g) ?? []).filter((t) => days.includes(Math.floor(t.at / DAY)));
    const vol = ts.reduce((s, t) => s + t.volume, 0);
    return {
      group: g,
      n: ts.length,
      meanBp: ci(point[j] ?? NaN, samples[j] ?? []),
      winPct: ts.length === 0 ? null : (ts.filter((t) => t.netBp > 0).length / ts.length) * 100,
      costPerM: vol > 0 ? (-ts.reduce((s, t) => s + t.net, 0) / vol) * 1e6 : null,
    };
  });
  const [sc, ss, bc, bs] = point as [number, number, number, number];
  return {
    rows,
    diffCalm: ci(bc - sc, dCalm),
    diffStrong: ci(bs - ss, dStrong),
    unclassified,
  };
}
