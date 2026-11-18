import { Decimal } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { groupTrades } from "../src/replay/load";
import {
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
  it("skips entries that chase a move in the signal direction, keeps unknown moves", () => {
    const r = chaseRule("m3", 5);
    expect(r.apply(entry({ chgBps: { m1: 0, m3: 6, m5: 0 } })).kind).toBe("skip");
    expect(r.apply(entry({ chgBps: { m1: 0, m3: 4, m5: 0 } })).kind).toBe("keep");
    // Tín hiệu short, giá đã giảm 6 bp: cũng là đuổi giá.
    expect(
      r.apply(entry({ direction: "short", side: "short", chgBps: { m1: 0, m3: -6, m5: 0 } })).kind,
    ).toBe("skip");
    expect(r.apply(entry({ chgBps: { m1: 0, m3: null, m5: 0 } })).kind).toBe("keep");
  });

  it("fills a deeper entry only when the price reached it in time", () => {
    expect(pullbackRule(2).apply(entry())).toEqual({ kind: "reprice", entryPrice: d("99.98") });
    expect(pullbackRule(5).apply(entry()).kind).toBe("skip");
    expect(pullbackRule(2).apply(entry({ direction: "short", side: "short" }))).toEqual({
      kind: "reprice",
      entryPrice: d("100.02"),
    });
    expect(pullbackRule(1).apply(entry({ tick: null })).kind).toBe("skip");
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
    expect(md).toContain("Entry 2 ticks behind the touch *(upper bound)*");
    expect(md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Rule")).length).toBe(
      3,
    );
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
