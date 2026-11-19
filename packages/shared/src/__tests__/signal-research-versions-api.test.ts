import { describe, expect, it } from "vitest";

import { researchVersionChangeSchema } from "../api/signal-research";
import type { GateStatus } from "../signal-research/report";
import {
  baselineVersionConfig,
  diffVersionConfig,
  effectiveMaxOpenTrades,
  extraCheckOn,
  segmentStart,
  versionGateStatus,
  type BotVersionConfig,
} from "../signal-research/versions";

// API News bot versions (#305): giới hạn hiệu dụng, đoạn đếm, khác biệt với version gốc, cổng (kể cả kiểm tra thêm).

const base = baselineVersionConfig();
const withAssets = (a: Partial<BotVersionConfig["assets"]>): BotVersionConfig => ({
  ...base,
  assets: { ...base.assets, ...a },
});

describe("effectiveMaxOpenTrades", () => {
  it("is min(max, list size) only in Only these", () => {
    expect(effectiveMaxOpenTrades(base)).toBe(20);
    expect(
      effectiveMaxOpenTrades(withAssets({ mode: "only", markets: ["BTC-USD", "ETH-USD"] })),
    ).toBe(2);
    expect(
      effectiveMaxOpenTrades({
        ...withAssets({ mode: "only", markets: ["BTC-USD", "ETH-USD", "SOL-USD"] }),
        maxOpenTrades: 2,
      }),
    ).toBe(2);
    expect(
      effectiveMaxOpenTrades(withAssets({ mode: "except", markets: ["BTC-USD", "ETH-USD"] })),
    ).toBe(20);
  });
});

describe("segmentStart", () => {
  const saved = new Date("2026-11-19T13:05:00Z");
  it("takes the later of version save and classifier start", () => {
    expect(segmentStart(saved, null)).toEqual(saved);
    expect(segmentStart(saved, new Date("2026-11-19T13:00:00Z"))).toEqual(saved);
    const later = new Date("2026-11-20T00:00:00Z");
    expect(segmentStart(saved, later)).toEqual(later);
  });
});

describe("diffVersionConfig", () => {
  it("is empty for the same config, and decimals compare by value", () => {
    expect(diffVersionConfig(base, JSON.parse(JSON.stringify(base)) as BotVersionConfig)).toEqual(
      [],
    );
    expect(diffVersionConfig(base, { ...base, tpMultiple: "1.50" })).toEqual([]);
  });

  it("lists every change, structured and in config order", () => {
    const to: BotVersionConfig = {
      ...base,
      news: { ...base.news, treasury_buy: { enabled: false, maxHoldHours: 48 } },
      minLevel: "medium",
      slMultiple: "1",
      maxNewTradesPerDay: 5,
      onOppositeNews: "close",
      assets: { mode: "only", markets: ["SOL-USD", "BTC-USD"], crypto: true, stocks: false },
    };
    const changes = diffVersionConfig(base, to);
    expect(changes).toEqual([
      {
        field: "newsType",
        catalyst: "treasury_buy",
        from: base.news.treasury_buy,
        to: { enabled: false, maxHoldHours: 48 },
      },
      { field: "minLevel", from: "low", to: "medium" },
      { field: "slMultiple", from: "0.75", to: "1" },
      { field: "maxNewTradesPerDay", from: null, to: 5 },
      { field: "onOppositeNews", from: "keep", to: "close" },
      { field: "assetMode", from: "all", to: "only" },
      {
        field: "assetKinds",
        from: { crypto: true, stocks: true },
        to: { crypto: true, stocks: false },
      },
      { field: "assets", added: ["BTC-USD", "SOL-USD"], removed: [] },
    ]);
    for (const c of changes) expect(researchVersionChangeSchema.safeParse(c).success).toBe(true);
  });

  it("an off news type differs only by on/off, not by its hidden max hold", () => {
    const off = (h: number): BotVersionConfig => ({
      ...base,
      news: { ...base.news, listing: { enabled: false, maxHoldHours: h } },
    });
    expect(diffVersionConfig(off(24), off(48))).toEqual([]);
    const rest = Object.fromEntries(
      Object.entries(base.news).filter(([k]) => k !== "listing"),
    ) as BotVersionConfig["news"];
    expect(diffVersionConfig(off(24), { ...base, news: rest })).toEqual([]);
    expect(diffVersionConfig(base, off(24))).toHaveLength(1);
  });

  it("asset list order does not count", () => {
    const a = withAssets({ mode: "except", markets: ["BTC-USD", "ETH-USD"] });
    const b = withAssets({ mode: "except", markets: ["ETH-USD", "BTC-USD"] });
    expect(diffVersionConfig(a, b)).toEqual([]);
    const c = withAssets({ mode: "except", markets: ["ETH-USD", "SOL-USD"] });
    expect(diffVersionConfig(a, c)).toEqual([
      { field: "assets", added: ["SOL-USD"], removed: ["BTC-USD"] },
    ]);
  });
});

describe("versionGateStatus", () => {
  /** Cổng giả: lệnh i qua khi `pass(i)`; một khoảng qua khi mọi lệnh trong đó qua và đủ 100. */
  const gates =
    (pass: (i: number) => boolean) =>
    (from: number, to: number): GateStatus => {
      if (to - from < 100) return "collecting";
      for (let i = from; i < to; i += 1) if (!pass(i)) return "failing";
      return "passing";
    };
  const run = (o: {
    classifier?: "passed" | "needsLabels" | "underPrecision" | "unknown";
    closed?: number;
    segmentClosed: number;
    versionsTried: number;
    pass?: (i: number) => boolean;
  }) =>
    versionGateStatus({
      classifier: o.classifier ?? "passed",
      closed: o.closed ?? o.segmentClosed,
      segmentClosed: o.segmentClosed,
      versionsTried: o.versionsTried,
      gateOf: gates(o.pass ?? (() => true)),
    });

  it("trades only count once the current classifier passed its labels", () => {
    expect(
      run({ classifier: "needsLabels", segmentClosed: 0, closed: 0, versionsTried: 3 }).status,
    ).toBe("waits_for_labels");
    expect(
      run({ classifier: "needsLabels", segmentClosed: 4, closed: 4, versionsTried: 3 }).status,
    ).toBe("waits_for_labels");
    // Mọi lệnh đóng thuộc classifier cũ chưa qua (Baseline của thiết kế): "Not counted".
    expect(
      run({ classifier: "needsLabels", segmentClosed: 0, closed: 31, versionsTried: 4 }).status,
    ).toBe("not_counted");
    expect(run({ classifier: "underPrecision", segmentClosed: 120, versionsTried: 3 }).status).toBe(
      "not_counted",
    );
    expect(run({ classifier: "unknown", segmentClosed: 0, versionsTried: 3 }).status).toBe(
      "not_counted",
    );
  });

  it("without the extra check (≤ 3 versions tried) the plain gate decides", () => {
    expect(run({ segmentClosed: 99, versionsTried: 3 })).toEqual({
      status: "collecting",
      firstPassAt: null,
      repeat: null,
    });
    expect(run({ segmentClosed: 100, versionsTried: 3 }).status).toBe("passes");
    expect(run({ segmentClosed: 150, versionsTried: 3, pass: (i) => i !== 5 }).status).toBe(
      "fails",
    );
    expect(extraCheckOn(3)).toBe(false);
    expect(extraCheckOn(4)).toBe(true);
  });

  it("with the extra check a pass must repeat on the next 100 closed trades", () => {
    expect(run({ segmentClosed: 99, versionsTried: 4 }).status).toBe("collecting");
    // Qua lần đầu ở 100, mới có 30 lệnh sau đó.
    expect(run({ segmentClosed: 130, versionsTried: 4 })).toEqual({
      status: "needs_repeat",
      firstPassAt: 100,
      repeat: { closed: 30, needed: 100 },
    });
    expect(run({ segmentClosed: 200, versionsTried: 4 })).toEqual({
      status: "passes",
      firstPassAt: 100,
      repeat: { closed: 100, needed: 100 },
    });
    // Lặp lại hỏng (một lệnh trong 100 lệnh sau lần qua đầu) → fails, kể cả khi về sau lại tốt.
    expect(run({ segmentClosed: 260, versionsTried: 4, pass: (i) => i !== 150 })).toMatchObject({
      status: "fails",
      firstPassAt: 100,
    });
  });

  it("the first pass is the shortest passing prefix, and the repeat window is fixed after it", () => {
    // Lệnh 0 hỏng: tiền tố nào cũng chứa nó nên không bao giờ qua.
    expect(run({ segmentClosed: 300, versionsTried: 5, pass: (i) => i !== 0 })).toMatchObject({
      status: "fails",
      firstPassAt: null,
    });
    // Cổng thật có thể qua ở một tiền tố dài hơn: lần qua đầu ở 140 → lặp lại trên [140, 240).
    const seen: [number, number][] = [];
    const r = versionGateStatus({
      classifier: "passed",
      closed: 240,
      segmentClosed: 240,
      versionsTried: 4,
      gateOf: (from, to) => {
        seen.push([from, to]);
        if (from === 0) return to >= 140 ? "passing" : "failing";
        return "passing";
      },
    });
    expect(r).toEqual({ status: "passes", firstPassAt: 140, repeat: { closed: 100, needed: 100 } });
    expect(seen.at(-1)).toEqual([140, 240]);
  });
});
