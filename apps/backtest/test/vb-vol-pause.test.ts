import { Decimal } from "@drift/shared";
import type { Candle } from "@drift/strategies";
import { describe, expect, it } from "vitest";

import { costSplit, largeGap, liveTrades, type LiveVbFill } from "../src/vb-vol-pause/live";
import { MEDIAN_WINDOW, pausedAfter, rangeBp, spikes } from "../src/vb-vol-pause/study";

// Nghiên cứu tạm dừng VB khi biến động vọt lên (#363): phần tính "vọt", cửa sổ m phút (không nhìn trước) và dòng hiệu
// chỉnh với bot thật. Dữ liệu tự dựng.

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 10);

/** Nến biên độ `bp` quanh giá 1000 (mở = 1000, cao = 1000 + bp / 10). */
const candle = (i: number, bp: number): Candle => ({
  t: T0 + i * MIN,
  o: "1000",
  h: String(1000 + bp / 10),
  l: "1000",
  c: "1000",
});
/** n nến biên độ 10 bp, rồi các nến đặc biệt theo vị trí. */
function series(n: number, special: Record<number, number> = {}): Candle[] {
  return Array.from({ length: n }, (_, i) => candle(i, special[i] ?? 10));
}

describe("spikes", () => {
  it("measures range as (high − low) ÷ open in bp", () => {
    expect(rangeBp(candle(0, 25))).toBeCloseTo(25, 6);
  });

  it("needs 30 closed candles before a candle can spike", () => {
    const cs = series(40, { 5: 500, [MEDIAN_WINDOW]: 500 });
    const s = spikes(cs, 2);
    expect(s[5]).toBe(false);
    expect(s[MEDIAN_WINDOW]).toBe(true);
  });

  it("is strict: range must be above k × median", () => {
    const cs = series(40, { 35: 20, 36: 21 });
    const s = spikes(cs, 2);
    expect(s[35]).toBe(false);
    expect(s[36]).toBe(true);
  });

  it("never looks ahead: later candles do not change earlier answers", () => {
    const base = series(60, { 40: 50 });
    const more = [
      ...base,
      ...Array.from({ length: 30 }, (_, i) => candle(60 + i, i % 3 === 0 ? 900 : 10)),
    ];
    const a = spikes(base, 2.5);
    const b = spikes(more, 2.5).slice(0, base.length);
    expect(b).toEqual(a);
  });
});

describe("pausedAfter", () => {
  it("pauses right after the spike candle closes, for exactly m candles", () => {
    const cs = series(50, { 40: 100 });
    for (const m of [2, 3, 5]) {
      const p = pausedAfter(cs, 2, m);
      const idx = cs.flatMap((c, i) => (p.has(c.t) ? [i] : []));
      expect(idx).toEqual(Array.from({ length: m }, (_, j) => 40 + j));
    }
  });

  it("does not pause before the spike (no look-ahead)", () => {
    const cs = series(50, { 40: 100 });
    const p = pausedAfter(cs, 2, 5);
    for (let i = 0; i < 40; i++) expect(p.has(cs[i]?.t ?? -1)).toBe(false);
  });

  it("restarts the window on a new spike", () => {
    const cs = series(60, { 40: 100, 42: 100 });
    const p = pausedAfter(cs, 2, 3);
    const idx = cs.flatMap((c, i) => (p.has(c.t) ? [i] : []));
    expect(idx).toEqual([40, 41, 42, 43, 44]);
  });
});

describe("live calibration", () => {
  const f = (o: Partial<LiveVbFill> & Pick<LiveVbFill, "tag" | "side" | "price">): LiveVbFill => ({
    botId: "b1",
    at: T0,
    size: "1",
    fee: "0.1",
    maker: true,
    ...o,
  });

  it("books closed trades like the Signal Analysis VB tab and skips open ones", () => {
    const ts = liveTrades([
      f({ tag: "vf:1:in", side: "buy", price: "1000", at: T0 }),
      f({ tag: "vf:1:out:1", side: "sell", price: "1001", at: T0 + 1_000, maker: false }),
      // Lượt đóng thiếu (< 99.9%) → bỏ.
      f({ tag: "vf:2:in", side: "sell", price: "1000", at: T0 + 2_000 }),
      f({ tag: "vf:2:out:1", side: "buy", price: "999", size: "0.5", at: T0 + 3_000 }),
      // Bot khác, lượt short lỗ, đóng bằng sl.
      f({ botId: "b2", tag: "vf:7:in", side: "sell", price: "1000", at: T0 }),
      f({ botId: "b2", tag: "vf:7:sl", side: "buy", price: "1002", at: T0 + 5_000, maker: false }),
    ]);
    expect(ts).toHaveLength(2);
    const [a, b] = ts;
    expect(a?.volume.toString()).toBe("2001");
    expect(a?.net.toString()).toBe("0.8");
    expect(a?.makerVolume.toString()).toBe("1000");
    expect(b?.net.toString()).toBe("-2.2");
    const c = costSplit(ts);
    // cost = −(0.8 − 2.2) ÷ 4003 × 1M; phí 0.4 ÷ 4003 × 1M.
    expect(c.costPerM?.toFixed(2)).toBe("349.74");
    expect(c.feesPerM?.toFixed(2)).toBe("99.93");
    expect(c.costPerM?.sub(c.feesPerM ?? 0).toFixed(2)).toBe(c.pricePerM?.toFixed(2));
  });

  it("is Not available (null) without live trades", () => {
    const c = costSplit([]);
    expect(c.costPerM).toBeNull();
    expect(c.makerPct).toBeNull();
  });

  it("flags a large gap only above max(50, 30% of live)", () => {
    expect(largeGap(new Decimal(430), new Decimal(130))).toBe(true);
    expect(largeGap(new Decimal(160), new Decimal(130))).toBe(false);
    expect(largeGap(new Decimal(430), null)).toBe(false);
  });
});
