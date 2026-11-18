import { Decimal } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { checkRange, groupTrades, MAX_RANGE_DAYS, ReplayLimitError } from "../src/replay/load";
import {
  baseOf,
  beforeFeeBp,
  chaseRule,
  evaluate,
  GATE,
  momentumRule,
  pullbackRule,
  rescore,
  sidewaysRule,
  toMarkdown,
  type ReplayEntry,
} from "../src/replay/vb-replay";

// Replay luật tín hiệu VB (#235): luật, thống kê, cổng PASS / FAIL. Dữ liệu tự dựng, tính tay được.

const d = (v: number | string) => new Decimal(v);
const T0 = Date.parse("2026-11-10T00:00:00Z");
const neutral = {
  candleMomentum: 0.5,
  wickRejection: 0.5,
  volumeAcceleration: 0.5,
  tradePressure: 0.5,
  orderbookImbalance: 0.5,
};

/** Lượt long 1 base ở 100: lãi trước phí = (exit − 100) USDC = (exit − 100) × 100 bp. Phí 0.02. */
function entry(o: Partial<ReplayEntry> & { exit?: number; i?: number } = {}): ReplayEntry {
  const i = o.i ?? 0;
  const exit = o.exit ?? 100;
  return {
    botId: "b",
    market: "BTC-USD",
    at: T0 + i * 60_000,
    direction: "long",
    side: "long",
    reversed: false,
    balanced: false,
    regime: "SIDEWAY",
    components: neutral,
    chgBps: { m1: 0, m3: 0, m5: 0 },
    entryPrice: d(100),
    exitPrice: d(exit),
    qty: d(1),
    fees: d("0.02"),
    volume: d(100 + exit),
    t0: T0 + i * 60_000 + 1000,
    t1: T0 + i * 60_000 + 30_000,
    tick: d("0.01"),
    reach: { low: d("99.97"), high: d("100.03"), source: "mid_1s" },
    ...o,
  };
}

describe("rules", () => {
  it("skips entries that chase a move in the entered direction, keeps unknown moves and balance entries", () => {
    const r = chaseRule("m3", 5);
    expect(r.apply(entry({ chgBps: { m1: 0, m3: 6, m5: 0 } })).kind).toBe("skip");
    expect(r.apply(entry({ chgBps: { m1: 0, m3: 4, m5: 0 } })).kind).toBe("keep");
    // Tín hiệu short, giá đã giảm 6 bp: cũng là đuổi giá.
    expect(
      r.apply(entry({ direction: "short", side: "short", chgBps: { m1: 0, m3: -6, m5: 0 } })).kind,
    ).toBe("skip");
    expect(r.apply(entry({ chgBps: { m1: 0, m3: null, m5: 0 } })).kind).toBe("keep");
    // PM: hướng bot thực sự vào (Reverse: tín hiệu short, vào long; giá đã tăng 6 bp → long đuổi giá).
    expect(
      r.apply(entry({ direction: "short", side: "long", chgBps: { m1: 0, m3: 6, m5: 0 } })).kind,
    ).toBe("skip");
    expect(
      r.apply(entry({ direction: "long", side: "short", chgBps: { m1: 0, m3: 6, m5: 0 } })).kind,
    ).toBe("keep");
    // Lượt cân long / short (DEC-80) giữ nguyên.
    expect(r.apply(entry({ balanced: true, chgBps: { m1: 0, m3: 6, m5: 0 } })).kind).toBe("keep");
  });

  it("fills a deeper entry only when the price reached it in time", () => {
    expect(pullbackRule(2).apply(entry())).toEqual({ kind: "reprice", entryPrice: d("99.98") });
    expect(pullbackRule(5).apply(entry()).kind).toBe("skip");
    expect(pullbackRule(2).apply(entry({ direction: "short", side: "short" }))).toEqual({
      kind: "reprice",
      entryPrice: d("100.02"),
    });
    // Thiếu dữ liệu: không đánh giá được, không phải "bỏ lượt".
    expect(pullbackRule(1).apply(entry({ tick: null })).kind).toBe("unknown");
    expect(pullbackRule(1).apply(entry({ reach: null })).kind).toBe("unknown");
  });

  it("re-scores without candle momentum, re-checks the counter-trend block, leaves balance entries alone", () => {
    // Đà nến 0.9 kéo điểm lên long; bỏ đà nến thì các thành phần khác (0.4) cho short.
    const c = { ...neutral, candleMomentum: 0.9, wickRejection: 0.4, volumeAcceleration: 0.4 };
    expect(rescore(c, 1)).toBeGreaterThan(0.5);
    expect(rescore(c, 0)).toBeLessThan(0.5);
    const e = entry({ components: c });
    expect(momentumRule(0).apply(e).kind).toBe("flip");
    expect(momentumRule(1).apply(e).kind).toBe("keep");
    expect(momentumRule(0).apply({ ...e, balanced: true }).kind).toBe("keep");
    // Xu hướng tăng chặn short mới.
    expect(momentumRule(0).apply({ ...e, regime: "TREND_UP" }).kind).toBe("skip");
    // Bot bật Reverse: hướng mới short → vào long, đúng hướng đã vào (bot reversed vào long khi tín hiệu short).
    expect(
      momentumRule(0).apply({ ...e, reversed: true, direction: "short", side: "long" }).kind,
    ).toBe("keep");
  });

  it("keeps only sideways entries", () => {
    expect(sidewaysRule.apply(entry()).kind).toBe("keep");
    expect(sidewaysRule.apply(entry({ regime: "TREND_UP" })).kind).toBe("skip");
  });

  it("computes before-fee bp from the entry price", () => {
    expect(beforeFeeBp(entry({ exit: 100.05 })).toString()).toBe("5");
    expect(beforeFeeBp(entry({ exit: 100.05, side: "short" })).toString()).toBe("-5");
  });
});

describe("evaluate", () => {
  // 160 lượt: BTC / ETH xen kẽ, hai nửa thời gian. Lượt "đuổi giá" (m3 = 10) lỗ 3 bp, còn lại lãi 1 bp.
  const entries = Array.from({ length: 160 }, (_, i) => {
    // 2 trong mỗi 8 lượt (một BTC, một ETH) là lượt đuổi giá.
    const chase = i % 8 === 0 || i % 8 === 1;
    return entry({
      i,
      market: i % 2 === 0 ? "BTC-USD" : "ETH-USD",
      chgBps: { m1: 0, m3: chase ? 10 : 0, m5: 0 },
      exit: chase ? 99.97 : 100.01,
    });
  });

  it("measures kept trades, Δ bp per trade, net cost and volume ratio per bucket", () => {
    const r = evaluate(entries, [chaseRule("m3", 5)]);
    expect(r.entries).toBe(160);
    // Gốc: 40 lượt −3 bp, 120 lượt +1 bp → bình quân 0 bp.
    expect(r.baseline.meanBp?.toString()).toBe("0");
    const x = r.results[0];
    const all = x?.buckets.find((b) => b.key === "all");
    expect(all?.rule.n).toBe(120);
    expect(all?.delta?.toString()).toBe("1");
    expect(x?.skipped).toBe(40);
    // Volume giữ 120 / 160 lượt.
    expect(x?.volumeRatio?.toFixed(2)).toBe("0.75");
    // Net cost: lãi 0.01 − phí 0.02 = −0.01 mỗi lượt → 0.01 ÷ 200.01 × 1M ≈ 50.
    expect(all?.rule.netCostPerMillion?.toFixed(0)).toBe("50");
  });

  it("applies the gate: Δ ≥ 1, holds in each half and market, n ≥ 30, volume/hour ≥ 80%", () => {
    const r = evaluate(entries, [chaseRule("m3", 5), sidewaysRule]);
    const chase = r.results[0];
    expect(chase?.pass).toBe(false);
    // Chỉ trượt vì volume: 75% < 80%.
    expect(chase?.reasons).toEqual([`volume/hour 75% < ${String(GATE.minVolumeRatio * 100)}%`]);
    // Sideways giữ hết: Δ 0 → FAIL vì Δ.
    expect(r.results[1]?.reasons[0]).toMatch(/^Δ 0\.00 bp < 1 bp overall/);
  });

  it("fails a bucket with fewer than 30 kept trades", () => {
    const few = entries.slice(0, 40);
    const r = evaluate(few, [chaseRule("m3", 5)]);
    expect(r.results[0]?.reasons.some((s) => /n \d+ < 30/.test(s))).toBe(true);
  });

  it("writes a markdown report with the gate, caveats and one row per rule", () => {
    const r = evaluate(entries, [chaseRule("m3", 5), pullbackRule(2), momentumRule(0)]);
    const md = toMarkdown(r, { source: "synthetic data", generatedAt: T0 });
    expect(md).toContain("# VB signal replay (#235)");
    expect(md).toContain("cannot model the bot entering again");
    expect(md).toContain(
      "Entry 2 ticks behind the touch *(upper bound: mid_1s 160, 1-min candle 0)*",
    );
    expect(md).toContain("never adds entries");
    expect(md).toContain(
      "Re-score self-check (momentum rule at k = 1, original weights):** 0 of 160",
    );
    expect(md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Rule")).length).toBe(
      3,
    );
  });
});

describe("missing data, markets, self-check, limits", () => {
  const many = (n: number, o: Partial<ReplayEntry> & { exit?: number } = {}) =>
    Array.from({ length: n }, (_, i) =>
      entry({ i, market: i % 2 === 0 ? "BTC-USD" : "ETH-USD", exit: 100.01, ...o }),
    );

  it("reports a rule as not evaluated, not FAIL, when no entry has the data it needs", () => {
    const r = evaluate(many(80, { tick: null }), [pullbackRule(1)]);
    const x = r.results[0];
    expect(x?.pass).toBe(false);
    expect(x?.reasons).toEqual([]);
    expect(x?.notEvaluated).toBe("tick size unavailable");
    expect(x?.excluded).toEqual({ "tick size unavailable": 80 });
    const md = toMarkdown(r, {
      source: "t",
      generatedAt: T0,
      notes: ["Tick sizes could not be read."],
    });
    expect(md).toContain("Not evaluated: tick size unavailable");
    expect(md).toContain("> **Note:** Tick sizes could not be read.");
    expect(md).not.toContain("FAIL");
  });

  it("leaves entries without data out of both baseline and rule for that row", () => {
    const xs = [...many(80), ...many(20, { reach: null, exit: 99 })];
    const r = evaluate(xs, [pullbackRule(1)]);
    const all = r.results[0]?.buckets.find((b) => b.key === "all");
    expect(all?.base.n).toBe(80);
    expect(r.results[0]?.excluded).toEqual({ "no price in the 10 s after the decision": 20 });
    expect(r.results[0]?.notEvaluated).toBeNull();
  });

  it("groups BTC and ETH by exact base asset", () => {
    expect(baseOf("ETHFI-USD")).toBe("ETHFI");
    expect(baseOf("eth-usd")).toBe("ETH");
    const r = evaluate([...many(60), ...many(40, { market: "ETHFI-USD" })], [sidewaysRule]);
    expect(r.results[0]?.buckets.find((b) => b.key === "eth")?.base.n).toBe(30);
  });

  it("counts entries that do not come back as kept at k = 1", () => {
    // Đà nến 0.9 kéo về long; vào short (side ≠ hướng tính lại) → k = 1 không ra keep.
    const off = entry({
      components: { ...neutral, candleMomentum: 0.9 },
      direction: "short",
      side: "short",
    });
    const r = evaluate([...many(10), off], [sidewaysRule]);
    expect(r.selfCheck).toEqual({ notKeep: 1, of: 11 });
    expect(toMarkdown(r, { source: "t", generatedAt: T0 })).toContain("**Warning:** 1 entries");
  });

  it("prints No entries in range instead of 1970 dates", () => {
    const r = evaluate([], [sidewaysRule]);
    expect(r.from).toBeNull();
    const md = toMarkdown(r, {
      source: "t",
      generatedAt: T0,
      range: { from: T0, to: T0 + 86_400_000 },
    });
    expect(md).toContain("**No entries in range (2026-11-10 00:00 → 2026-11-11 00:00 UTC).**");
    expect(md).not.toContain("1970");
  });

  it("shows a negative net cost as a net gain", () => {
    // Lãi 0.05 − phí 0.02 mỗi lượt.
    const r = evaluate(many(40, { exit: 100.05 }), [sidewaysRule]);
    expect(r.baseline.netCostPerMillion?.isNeg()).toBe(true);
    expect(toMarkdown(r, { source: "t", generatedAt: T0 })).toMatch(
      /net cost net gain \d+ per \$1M/,
    );
  });

  it("refuses ranges longer than the limit", () => {
    const from = new Date(T0);
    expect(() => {
      checkRange(from, new Date(T0 + MAX_RANGE_DAYS * 86_400_000));
    }).not.toThrow();
    expect(() => {
      checkRange(from, new Date(T0 + (MAX_RANGE_DAYS + 1) * 86_400_000));
    }).toThrow(ReplayLimitError);
    expect(() => {
      checkRange(from, from);
    }).toThrow(ReplayLimitError);
  });
});

describe("groupTrades", () => {
  it("groups in/out fills into closed trades with exact money, like buildTrades", () => {
    const f = (tag: string, side: "buy" | "sell", price: string, at: number) => ({
      tag,
      side,
      price: d(price),
      size: d("0.5"),
      fee: d("0.01"),
      at,
    });
    const trades = groupTrades([
      f("vf:1:in:0", "buy", "100", 1),
      f("vf:1:in:0", "buy", "100.2", 2),
      f("vf:1:out:0", "sell", "100.3", 3),
      f("vf:1:sl", "sell", "100.1", 4),
      // Lượt chưa đóng: bỏ.
      f("vf:2:in:0", "sell", "101", 5),
    ]);
    expect(trades).toHaveLength(1);
    const t = trades[0];
    expect(t?.side).toBe("long");
    expect(t?.entryPrice.toString()).toBe("100.1");
    expect(t?.exitPrice.toString()).toBe("100.2");
    expect(t?.qty.toString()).toBe("1");
    expect(t?.fees.toString()).toBe("0.04");
    expect(t?.volume.toString()).toBe("200.3");
  });
});
