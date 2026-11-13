import type { LeaderEvent } from "@drift/shared";
import { describe, expect, it } from "vitest";

import {
  bigMoveFollowers,
  listedOnly,
  planPositionAlerts,
  positionFollowers,
  positionSide,
} from "../follow-alerts";

// Cảnh báo follow theo mức (DEC-209): hàm thuần.

const NOW = 1_800_000_000_000;
function ev(
  kind: LeaderEvent["kind"],
  coin: string,
  market: string | null,
  before: string,
  after: string,
  at = NOW,
): LeaderEvent {
  return {
    coin,
    market,
    kind,
    positionBefore: before,
    positionAfter: after,
    notional: "50000",
    price: "100",
    realized: null,
    at,
    lastAt: at,
    lastTid: String(at),
  };
}

describe("followers by level", () => {
  const f = [
    { userId: "a", level: "big_moves" as const },
    { userId: "b", level: "positions" as const },
    { userId: "c", level: "off" as const },
  ];
  it("big moves go to everyone except Off; position changes only to New and closed positions", () => {
    expect(bigMoveFollowers(f).map((x) => x.userId)).toEqual(["a", "b"]);
    expect(positionFollowers(f).map((x) => x.userId)).toEqual(["b"]);
  });
});

describe("listedOnly", () => {
  it("drops markets SoDEX doesn't list (e.g. GRAM)", () => {
    const out = listedOnly([
      ev("open", "GRAM", null, "0", "-5"),
      ev("open", "BTC", "BTC-USD", "0", "1"),
    ]);
    expect(out.map((e) => e.coin)).toEqual(["BTC"]);
  });
});

describe("positionSide", () => {
  it("uses the side after the change, or the side just closed", () => {
    expect(positionSide({ positionBefore: "0", positionAfter: "2" })).toBe("long");
    expect(positionSide({ positionBefore: "0", positionAfter: "-2" })).toBe("short");
    expect(positionSide({ positionBefore: "-3", positionAfter: "0" })).toBe("short");
    expect(positionSide({ positionBefore: "0", positionAfter: "0" })).toBeNull();
  });
});

describe("planPositionAlerts", () => {
  it("alerts on open, close, flip and liquidation, not on add or reduce", () => {
    const out = planPositionAlerts(
      [
        ev("open", "BTC", "BTC-USD", "0", "1"),
        ev("add", "ETH", "ETH-USD", "1", "2"),
        ev("reduce", "SOL", "SOL-USD", "-5", "-2"),
        ev("close", "ARB", "ARB-USD", "-3", "0"),
        ev("flip", "NEAR", "NEAR-USD", "2", "-1"),
        ev("liquidated", "ZEC", "ZEC-USD", "4", "0"),
      ],
      new Map(),
      new Set(),
      NOW,
    );
    expect(out.map((a) => [a.coin, a.event.kind, a.side])).toEqual([
      ["BTC", "open", "long"],
      ["ARB", "close", "short"],
      ["NEAR", "flip", "short"],
      ["ZEC", "liquidated", "long"],
    ]);
  });

  it("only listed markets, one per coin (the latest), none within 10 minutes, none right after a big move", () => {
    const out = planPositionAlerts(
      [
        ev("open", "GRAM", null, "0", "-5"),
        ev("open", "BTC", "BTC-USD", "0", "1", NOW - 1000),
        ev("close", "BTC", "BTC-USD", "1", "0", NOW),
        ev("open", "ETH", "ETH-USD", "0", "1"),
        ev("open", "SOL", "SOL-USD", "0", "1"),
      ],
      new Map([["ETH", NOW - 9 * 60_000]]),
      new Set(["SOL"]),
      NOW,
    );
    expect(out.map((a) => [a.coin, a.event.kind])).toEqual([["BTC", "close"]]);
  });

  it("alerts again once 10 minutes have passed", () => {
    const out = planPositionAlerts(
      [ev("open", "ETH", "ETH-USD", "0", "1")],
      new Map([["ETH", NOW - 10 * 60_000]]),
      new Set(),
      NOW,
    );
    expect(out).toHaveLength(1);
  });
});
