import { Decimal } from "@drift/shared";
import { FARM_SIGNAL, FARM_WEIGHTS } from "@drift/strategies";

// Replay các luật tín hiệu Volume Builder ứng viên trên lượt vào thật (#235, một phần #220; DEC-316).
// Hàm thuần, không I/O: nhận lượt vào thật đã ghép với kết quả lượt (fill thật) và snapshot tín hiệu (DEC-311), trả về
// thống kê cho từng luật và PASS / FAIL theo cổng của #235. Đây là phân tích quá khứ, không phải dự báo.

export type Side = "long" | "short";

export interface ReplayComponents {
  candleMomentum: number;
  wickRejection: number;
  volumeAcceleration: number;
  tradePressure: number;
  orderbookImbalance: number;
}

/** Một lượt vào thật đã khớp và đã đóng, kèm snapshot tín hiệu lúc quyết định. */
export interface ReplayEntry {
  botId: string;
  market: string;
  /** Thời điểm quyết định (ms). */
  at: number;
  /** Hướng của tín hiệu (trước Reverse / cân long-short). */
  direction: Side;
  /** Hướng bot thực sự vào. */
  side: Side;
  reversed: boolean;
  balanced: boolean;
  regime: string;
  components: ReplayComponents;
  /** Giá đã chạy bao nhiêu bp trong 1 / 3 / 5 phút trước lúc quyết định (dương = giá tăng). */
  chgBps: { m1: number | null; m3: number | null; m5: number | null };
  /** Giá vào / ra bình quân, khối lượng (base) của lượt thật. */
  entryPrice: Decimal;
  exitPrice: Decimal;
  qty: Decimal;
  /** Phí của cả lượt (USDC, đã gồm builder fee). */
  fees: Decimal;
  /** Σ giá × size của mọi fill trong lượt. */
  volume: Decimal;
  /** Lúc khớp lệnh vào đầu tiên / lúc đóng lượt (ms). */
  t0: number;
  t1: number;
  /** Tick size của market; null khi không đọc được (luật pullback bỏ qua lượt đó). */
  tick: Decimal | null;
  /**
   * Giá xa nhất trong 10 s sau lúc quyết định (thấp nhất / cao nhất), để thử lệnh vào lùi Y tick. `source`: `mid_1s` (giá
   * giữa mỗi giây) hoặc `candle` (nến 1 phút chứa khung 10 s: cận trên, lạc quan). null khi không có dữ liệu.
   */
  reach: { low: Decimal; high: Decimal; source: "mid_1s" | "candle" } | null;
}

/** Kết quả của một lượt dưới một luật. */
export type Outcome =
  | { kind: "keep" }
  | { kind: "skip" }
  /** Lệnh vào khớp ở giá khác (pullback): lãi / lỗ trước phí tính lại với giá vào mới. */
  | { kind: "reprice"; entryPrice: Decimal }
  /** Hướng bị đảo khi tính lại điểm: cổng tính như skip, báo thêm kết quả soi gương. */
  | { kind: "flip" }
  /** Thiếu dữ liệu để đánh giá lượt này (tick, giá 10 s): loại khỏi CẢ gốc lẫn luật của hàng đó, không tính là bỏ. */
  | { kind: "unknown"; reason: string };

export interface Rule {
  id: string;
  label: string;
  apply: (e: ReplayEntry) => Outcome;
  /** Nhãn "cận trên" khi kết quả dựa vào nến 1 phút (pullback). */
  upperBound?: boolean;
}

/** Cổng của #235 (PM chốt): Δ ≥ 1 bp tổng; Δ > 0 ở mỗi nửa và ở BTC, ETH; n ≥ 30 mỗi nhóm; volume / giờ ≥ 80%. */
export const GATE = {
  minDeltaBp: 1,
  minN: 30,
  minVolumeRatio: 0.8,
} as const;

/** Lưới mặc định (cấu hình được ở CLI). */
export const DEFAULT_GRIDS = {
  chaseBps: [2, 3, 5, 8, 12],
  chaseWindows: ["m1", "m3", "m5"] as const,
  pullbackTicks: [1, 2, 3],
  momentumScale: [0.5, 0.25, 0],
};

const signOf = (s: Side) => (s === "long" ? 1 : -1);

/** Lãi / lỗ trước phí (USDC) của lượt với giá vào `entry`. */
export function grossOf(e: ReplayEntry, entry: Decimal = e.entryPrice): Decimal {
  return e.exitPrice.sub(entry).mul(e.qty).mul(signOf(e.side));
}

/** bp trước phí trên giá trị lệnh vào. */
export function beforeFeeBp(e: ReplayEntry, entry: Decimal = e.entryPrice): Decimal {
  return e.exitPrice.sub(entry).div(entry).mul(10_000).mul(signOf(e.side));
}

// ---------- Luật ----------

/**
 * (a) Không vào khi giá đã chạy ≥ X bp theo hướng bot THỰC SỰ vào trong k phút (PM: hướng thật mới là hướng chịu giá chạy
 * ngược). Lượt do cân long / short (DEC-80) giữ nguyên, như luật (c). Thiếu số → giữ.
 */
export function chaseRule(window: "m1" | "m3" | "m5", xBps: number): Rule {
  return {
    id: `chase-${window}-${String(xBps)}`,
    label: `Skip after ≥ ${String(xBps)} bp move in the entered direction over ${window.slice(1)} min`,
    apply: (e) => {
      if (e.balanced) return { kind: "keep" };
      const chg = e.chgBps[window];
      if (chg === null) return { kind: "keep" };
      return chg * signOf(e.side) >= xBps ? { kind: "skip" } : { kind: "keep" };
    },
  };
}

export const NO_TICK = "tick size unavailable";
export const NO_REACH = "no price in the 10 s after the decision";

/** (b) Đặt lệnh vào lùi Y tick sau giá chạm; khớp khi giá trong 10 s chạm tới, không thì bỏ lượt. */
export function pullbackRule(ticks: number): Rule {
  return {
    id: `pullback-${String(ticks)}`,
    label: `Entry ${String(ticks)} tick${ticks === 1 ? "" : "s"} behind the touch`,
    upperBound: true,
    apply: (e) => {
      if (e.tick === null) return { kind: "unknown", reason: NO_TICK };
      if (e.reach === null) return { kind: "unknown", reason: NO_REACH };
      const off = e.tick.mul(ticks);
      const price = e.side === "long" ? e.entryPrice.sub(off) : e.entryPrice.add(off);
      const reached = e.side === "long" ? e.reach.low.lte(price) : e.reach.high.gte(price);
      return reached ? { kind: "reprice", entryPrice: price } : { kind: "skip" };
    },
  };
}

/** Điểm tín hiệu với trọng số candleMomentum × k (chuẩn hoá lại tổng trọng số về 1). */
export function rescore(c: ReplayComponents, k: number): number {
  const w = { ...FARM_WEIGHTS, candleMomentum: FARM_WEIGHTS.candleMomentum * k };
  const total =
    w.candleMomentum +
    w.wickRejection +
    w.volumeAcceleration +
    w.tradePressure +
    w.orderbookImbalance;
  const raw =
    c.candleMomentum * w.candleMomentum +
    c.wickRejection * w.wickRejection +
    c.volumeAcceleration * w.volumeAcceleration +
    c.tradePressure * w.tradePressure +
    c.orderbookImbalance * w.orderbookImbalance;
  return Math.min(1, Math.max(0, raw / total));
}

/**
 * (c) Giảm trọng số đà nến: tính lại điểm và hướng, chạy lại chặn ngược xu hướng (cùng ngưỡng với `farmSignal`); lượt do
 * cân long / short (DEC-80) giữ nguyên; bot bật Reverse đảo sau khi tính lại và kiểm chặn ngược xu hướng lần nữa (như
 * chiến lược). Hướng mới khác hướng đã vào → `flip`.
 */
export function momentumRule(k: number): Rule {
  return {
    id: `momentum-${String(k)}`,
    label: `Candle momentum weight × ${String(k)}`,
    apply: (e) => {
      if (e.balanced) return { kind: "keep" };
      const score = rescore(e.components, k);
      const dir: Side = score >= 0.5 ? "long" : "short";
      const t = FARM_SIGNAL.trendCounterThreshold;
      if (
        (e.regime === "TREND_UP" && dir === "short" && score > 1 - t) ||
        (e.regime === "TREND_DOWN" && dir === "long" && score < t)
      )
        return { kind: "skip" };
      let side = dir;
      if (e.reversed) {
        side = dir === "long" ? "short" : "long";
        if (
          (e.regime === "TREND_UP" && side === "short") ||
          (e.regime === "TREND_DOWN" && side === "long")
        )
          return { kind: "skip" };
      }
      return side === e.side ? { kind: "keep" } : { kind: "flip" };
    },
  };
}

/** (d) Chỉ vào khi thị trường đi ngang. */
export const sidewaysRule: Rule = {
  id: "sideways-only",
  label: "Sideways only",
  apply: (e) => (e.regime === "SIDEWAY" ? { kind: "keep" } : { kind: "skip" }),
};

export function defaultRules(grids = DEFAULT_GRIDS): Rule[] {
  return [
    ...grids.chaseWindows.flatMap((w) => grids.chaseBps.map((x) => chaseRule(w, x))),
    ...grids.pullbackTicks.map((y) => pullbackRule(y)),
    ...grids.momentumScale.map((k) => momentumRule(k)),
    sidewaysRule,
  ];
}

// ---------- Thống kê ----------

export interface Stats {
  n: number;
  /** bp trước phí bình quân mỗi lượt (bình quân đều theo lượt); null khi n = 0. */
  meanBp: Decimal | null;
  /** −Σ(lãi trước phí − phí) ÷ Σvolume × 1M; âm = lãi ròng ("net gain"); null khi không có volume. */
  netCostPerMillion: Decimal | null;
  volume: Decimal;
}

interface Row {
  bp: Decimal;
  gross: Decimal;
  fees: Decimal;
  volume: Decimal;
}

function statsOf(rows: readonly Row[]): Stats {
  const volume = rows.reduce((s, r) => s.add(r.volume), new Decimal(0));
  const net = rows.reduce((s, r) => s.add(r.gross).sub(r.fees), new Decimal(0));
  return {
    n: rows.length,
    meanBp:
      rows.length === 0
        ? null
        : rows.reduce((s, r) => s.add(r.bp), new Decimal(0)).div(rows.length),
    netCostPerMillion: volume.isZero() ? null : net.neg().div(volume).mul(1_000_000),
    volume,
  };
}

/** Lượt dưới luật: giữ / đổi giá / bỏ; `mirror` = lượt đảo hướng tính như soi gương (chỉ để tham khảo). */
function rowsUnder(entries: readonly ReplayEntry[], rule: Rule | null, mirror: boolean): Row[] {
  return entries.flatMap((e) => {
    const o: Outcome = rule === null ? { kind: "keep" } : rule.apply(e);
    if (o.kind === "skip" || o.kind === "unknown") return [];
    if (o.kind === "flip") {
      if (!mirror) return [];
      const g = grossOf(e).neg();
      return [{ bp: beforeFeeBp(e).neg(), gross: g, fees: e.fees, volume: e.volume }];
    }
    const entry = o.kind === "reprice" ? o.entryPrice : e.entryPrice;
    const volume =
      o.kind === "reprice" ? e.volume.sub(e.entryPrice.mul(e.qty)).add(entry.mul(e.qty)) : e.volume;
    return [{ bp: beforeFeeBp(e, entry), gross: grossOf(e, entry), fees: e.fees, volume }];
  });
}

export interface Bucket {
  key: "all" | "h1" | "h2" | "btc" | "eth";
  base: Stats;
  rule: Stats;
  /** Δ bp trước phí mỗi lượt (luật − gốc); null khi thiếu số. */
  delta: Decimal | null;
}

export interface RuleResult {
  rule: Rule;
  /** Số lượt bị bỏ / đổi giá / đảo hướng. */
  skipped: number;
  repriced: number;
  flipped: number;
  buckets: Bucket[];
  /** Volume / giờ của luật ÷ của gốc (cùng khoảng thời gian, nên = tỉ lệ volume). */
  volumeRatio: Decimal | null;
  /** Kết quả khi coi lượt đảo hướng là lượt soi gương (chỉ tham khảo, không dùng cho cổng). */
  mirrored: Stats | null;
  pass: boolean;
  /** Lý do FAIL (rỗng khi PASS). */
  reasons: string[];
  /** Lượt thiếu dữ liệu, đã loại khỏi cả gốc lẫn luật của hàng này: lý do → số lượt. */
  excluded: Record<string, number>;
  /** Không đánh giá được (không lượt nào đủ dữ liệu): lý do; khi đó không có PASS / FAIL. */
  notEvaluated: string | null;
  /** Luật dùng giá 10 s (pullback): số lượt đánh giá bằng mid_1s / bằng nến 1 phút. */
  sources: { mid1s: number; candle: number } | null;
}

export interface ReplayReport {
  entries: number;
  /** null khi không có lượt nào. */
  from: number | null;
  to: number | null;
  hours: number;
  baseline: Stats;
  results: RuleResult[];
  /**
   * Đối chứng dựng lại điểm: số lượt mà luật (c) với k = 1 (trọng số gốc) KHÔNG ra `keep`. Kỳ vọng ≈ 0; lệch là do snapshot
   * làm tròn thành phần (DEC-311) hoặc công thức lệch với chiến lược.
   */
  selfCheck: { notKeep: number; of: number };
}

/** Base asset chính xác (`ETHFI-USD` không phải ETH). */
export const baseOf = (m: string) => m.toUpperCase().split(/[-_/]/)[0] ?? "";
const isBtc = (m: string) => baseOf(m) === "BTC";
const isEth = (m: string) => baseOf(m) === "ETH";

export function evaluate(entries: readonly ReplayEntry[], rules: readonly Rule[]): ReplayReport {
  const sorted = [...entries].sort((a, b) => a.t0 - b.t0);
  const from = sorted[0]?.t0 ?? 0;
  const to = sorted.reduce((m, e) => Math.max(m, e.t1), from);
  const mid = from + (to - from) / 2;
  // Nửa thời gian cố định theo toàn bộ dữ liệu, để mọi hàng chia cùng một mốc.
  const groupsOf = (xs: readonly ReplayEntry[]): Record<Bucket["key"], ReplayEntry[]> => ({
    all: [...xs],
    h1: xs.filter((e) => e.t0 < mid),
    h2: xs.filter((e) => e.t0 >= mid),
    btc: xs.filter((e) => isBtc(e.market)),
    eth: xs.filter((e) => isEth(e.market)),
  });
  const baseline = statsOf(rowsUnder(sorted, null, false));
  const k1 = momentumRule(1);
  const selfCheck = {
    notKeep: sorted.filter((e) => k1.apply(e).kind !== "keep").length,
    of: sorted.length,
  };
  const results = rules.map((rule): RuleResult => {
    const applied = sorted.map((e) => ({ e, o: rule.apply(e) }));
    const outcomes = applied.map((x) => x.o.kind);
    const excluded: Record<string, number> = {};
    for (const { o } of applied)
      if (o.kind === "unknown") excluded[o.reason] = (excluded[o.reason] ?? 0) + 1;
    const known = applied.filter((x) => x.o.kind !== "unknown").map((x) => x.e);
    const sources =
      rule.upperBound === true
        ? {
            mid1s: known.filter((e) => e.reach?.source === "mid_1s").length,
            candle: known.filter((e) => e.reach?.source === "candle").length,
          }
        : null;
    const groups = groupsOf(known);
    const buckets = (Object.keys(groups) as Bucket["key"][]).map((key) => {
      const base = statsOf(rowsUnder(groups[key], null, false));
      const r = statsOf(rowsUnder(groups[key], rule, false));
      return {
        key,
        base,
        rule: r,
        delta: base.meanBp === null || r.meanBp === null ? null : r.meanBp.sub(base.meanBp),
      };
    });
    const all = buckets.find((b) => b.key === "all");
    const volumeRatio =
      all === undefined || all.base.volume.isZero() ? null : all.rule.volume.div(all.base.volume);
    const flipped = outcomes.filter((k) => k === "flip").length;
    const reasons: string[] = [];
    const d = (k: Bucket["key"]) => buckets.find((b) => b.key === k);
    const allDelta = all?.delta ?? null;
    if (allDelta === null || allDelta.lt(GATE.minDeltaBp))
      reasons.push(`Δ ${fmt(allDelta)} bp < ${String(GATE.minDeltaBp)} bp overall`);
    for (const k of ["h1", "h2", "btc", "eth"] as const) {
      const b = d(k);
      if (b === undefined || b.rule.n < GATE.minN)
        reasons.push(`${label(k)}: n ${String(b?.rule.n ?? 0)} < ${String(GATE.minN)}`);
      else if (b.delta === null || b.delta.lte(0))
        reasons.push(`${label(k)}: Δ ${fmt(b.delta)} bp ≤ 0`);
    }
    if (volumeRatio === null || volumeRatio.lt(GATE.minVolumeRatio))
      reasons.push(
        `volume/hour ${volumeRatio === null ? "n/a" : `${volumeRatio.mul(100).toFixed(0)}%`} < ${String(GATE.minVolumeRatio * 100)}%`,
      );
    const notEvaluated =
      sorted.length > 0 && known.length === 0 ? Object.keys(excluded).join("; ") : null;
    return {
      rule,
      skipped: outcomes.filter((k) => k === "skip").length,
      repriced: outcomes.filter((k) => k === "reprice").length,
      flipped,
      buckets,
      volumeRatio,
      mirrored: flipped === 0 ? null : statsOf(rowsUnder(known, rule, true)),
      pass: notEvaluated === null && reasons.length === 0,
      reasons: notEvaluated === null ? reasons : [],
      excluded,
      notEvaluated,
      sources,
    };
  });
  return {
    entries: sorted.length,
    from: sorted.length === 0 ? null : from,
    to: sorted.length === 0 ? null : to,
    hours: (to - from) / 3_600_000,
    baseline,
    results,
    selfCheck,
  };
}

const label = (k: Bucket["key"]) =>
  ({ all: "All", h1: "First half", h2: "Second half", btc: "BTC", eth: "ETH" })[k];
const fmt = (v: Decimal | null, dp = 2) => (v === null ? "n/a" : v.toFixed(dp));
/** Chi phí ròng / $1M: số âm là lãi ròng, ghi rõ "net gain". */
const fmtCost = (v: Decimal | null) =>
  v === null ? "n/a" : v.isNeg() ? `net gain ${v.neg().toFixed(0)}` : v.toFixed(0);

// ---------- Báo cáo markdown ----------

const day = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

export function toMarkdown(
  r: ReplayReport,
  meta: {
    source: string;
    generatedAt: number;
    /** Khoảng đã yêu cầu (in khi không có lượt nào). */
    range?: { from: number; to: number };
    /** Ghi chú của bộ nạp (ví dụ không đọc được tick size): in ngay đầu báo cáo. */
    notes?: readonly string[];
  },
): string {
  const L: string[] = [];
  L.push("# VB signal replay (#235)");
  L.push("");
  L.push(
    `Generated ${day(meta.generatedAt)} UTC from ${meta.source}. Past trades only, not a forecast.`,
  );
  L.push("");
  for (const n of meta.notes ?? []) L.push(`> **Note:** ${n}`);
  if ((meta.notes ?? []).length > 0) L.push("");
  if (r.from === null || r.to === null) {
    const range =
      meta.range === undefined ? "" : ` (${day(meta.range.from)} → ${day(meta.range.to)} UTC)`;
    L.push(`**No entries in range${range}.** Nothing to evaluate.`);
    L.push("");
    return L.join("\n");
  }
  L.push(
    `**Data:** ${String(r.entries)} closed Volume Builder trades with a v1 entry snapshot, ${day(r.from)} → ${day(r.to)} UTC (${r.hours.toFixed(1)} h).`,
  );
  L.push(
    `**Baseline:** ${fmt(r.baseline.meanBp)} bp/trade before fees, net cost ${fmtCost(r.baseline.netCostPerMillion)} per $1M, volume ${r.baseline.volume.toFixed(0)} USDC.`,
  );
  L.push(
    `**Re-score self-check (momentum rule at k = 1, original weights):** ${String(r.selfCheck.notKeep)} of ${String(r.selfCheck.of)} entries do not come back as kept (expected about 0).`,
  );
  if (r.selfCheck.notKeep > 0)
    L.push(
      `> **Warning:** ${String(r.selfCheck.notKeep)} entries do not reproduce at k = 1, likely because the snapshot rounds components to 4 decimals near the 0.5 and counter-trend thresholds. Read the momentum rows with that margin in mind.`,
    );
  L.push("");
  L.push(
    `**Gate (PM):** Δ before-fee bp/trade ≥ ${String(GATE.minDeltaBp)} overall; Δ > 0 in each time half and on BTC and on ETH separately; ≥ ${String(GATE.minN)} kept trades in each half and each market; volume/hour ≥ ${String(GATE.minVolumeRatio * 100)}% of baseline.`,
  );
  L.push("");
  L.push("**Read with care:**");
  L.push(
    "- Volume/hour: the replay cannot model the bot entering again after a skipped entry, so filter rules lower volume/hour by exactly their skip share. This is pessimistic.",
  );
  L.push(
    "- Chase: the move is measured in the direction the bot actually entered (after Reverse). Long/short balance entries (DEC-80) are left unchanged.",
  );
  L.push(
    "- Pullback: a deeper entry counts as filled when the price reached it within 10 s after the decision, using `mid_1s` (Market Making markets, last 48 h) when present, otherwise the 1-minute candle. Each row shows how many entries used each source. The result is an **upper bound**: a mid price touching the level does not mean the order filled (queue position is ignored), and the candle window also includes the part of the minute before the decision. Not filled = entry skipped. Exits are unchanged.",
  );
  L.push(
    "- Momentum re-weighting can only remove or flip entries that were taken. It never adds entries that the live signal blocked, because those have no snapshot. Entries whose direction flips count as skipped for the gate. The mirrored result (before-fee bp negated, same prices) is shown for information only.",
  );
  L.push(
    "- Entries without the data a rule needs (tick size, a price in the 10 s window) are left out of both the baseline and the rule for that row, and listed below the table. They are not counted as skipped.",
  );
  L.push("- Net cost per $1M below 0 is shown as a net gain.");
  L.push("- Fees are the real fees of each trade; a repriced entry keeps its fee.");
  L.push("");
  L.push(
    "| Rule | Kept | Δ bp/trade | Net cost / $1M | Vol/hour | 1st half Δ (n) | 2nd half Δ (n) | BTC Δ (n) | ETH Δ (n) | Result |",
  );
  L.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const x of r.results) {
    const b = (k: Bucket["key"]) => x.buckets.find((y) => y.key === k);
    const cell = (k: Bucket["key"]) => {
      const y = b(k);
      return y === undefined ? "n/a" : `${fmt(y.delta)} (${String(y.rule.n)})`;
    };
    const all = b("all");
    const evaluated = all?.base.n ?? 0;
    const keptPct =
      evaluated === 0 ? "n/a" : `${(((all?.rule.n ?? 0) / evaluated) * 100).toFixed(0)}%`;
    const bound =
      x.sources === null
        ? ""
        : ` *(upper bound: mid_1s ${String(x.sources.mid1s)}, 1-min candle ${String(x.sources.candle)})*`;
    const result =
      x.notEvaluated !== null
        ? `Not evaluated: ${x.notEvaluated}`
        : x.pass
          ? "**PASS**"
          : `FAIL: ${x.reasons.join("; ")}`;
    L.push(
      `| ${x.rule.label}${bound} | ${String(all?.rule.n ?? 0)} (${keptPct}) | ${fmt(all?.delta ?? null)} | ${fmtCost(all?.rule.netCostPerMillion ?? null)} | ${x.volumeRatio === null ? "n/a" : `${x.volumeRatio.mul(100).toFixed(0)}%`} | ${cell("h1")} | ${cell("h2")} | ${cell("btc")} | ${cell("eth")} | ${result} |`,
    );
  }
  const left = r.results.filter((x) => Object.keys(x.excluded).length > 0);
  if (left.length > 0) {
    L.push("");
    L.push("**Entries left out for missing data (not counted as skipped):**");
    L.push("");
    for (const x of left)
      L.push(
        `- ${x.rule.label}: ${Object.entries(x.excluded)
          .map(([why, n]) => `${String(n)} (${why})`)
          .join(", ")}${x.notEvaluated === null ? "" : " — not evaluated"}.`,
      );
  }
  const flips = r.results.filter((x) => x.mirrored !== null);
  if (flips.length > 0) {
    L.push("");
    L.push("**Momentum re-weighting, flipped entries mirrored (information only):**");
    L.push("");
    L.push("| Rule | Flipped | Mean bp/trade with flips mirrored | Net cost / $1M |");
    L.push("|---|---:|---:|---:|");
    for (const x of flips)
      L.push(
        `| ${x.rule.label} | ${String(x.flipped)} | ${fmt(x.mirrored?.meanBp ?? null)} | ${fmtCost(x.mirrored?.netCostPerMillion ?? null)} |`,
      );
  }
  L.push("");
  return L.join("\n");
}
