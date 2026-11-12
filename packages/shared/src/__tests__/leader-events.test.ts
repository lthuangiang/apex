import { describe, expect, it } from "vitest";

import {
  bigMove,
  BIG_MOVE,
  coinIndex,
  groupLeaderEvents,
  type LeaderEvent,
  type TidFill,
} from "../leader-stats";

const INDEX = coinIndex(["BTC-USD", "ETH-USD"]);
const T = Date.UTC(2026, 10, 11, 12);
let tid = 0;
const f = (
  p: Partial<TidFill> & Pick<TidFill, "time" | "side" | "sz" | "startPosition">,
): TidFill => ({
  coin: "BTC",
  px: "100",
  closedPnl: "0",
  fee: "0",
  liquidatedSelf: false,
  tid: String((tid += 1)),
  ...p,
});

describe("groupLeaderEvents", () => {
  it("merges fills of one coin within 60 s from the first fill into one event", () => {
    const { events } = groupLeaderEvents(
      [
        f({ time: T, side: "B", sz: "1", startPosition: "0", px: "100" }),
        f({ time: T + 30_000, side: "B", sz: "1", startPosition: "1", px: "102" }),
        f({ time: T + 61_000, side: "B", sz: "2", startPosition: "2" }),
      ],
      INDEX,
    );
    expect(events.map((e) => [e.kind, e.positionBefore, e.positionAfter, e.notional])).toEqual([
      ["open", "0", "2", "202"],
      ["add", "2", "4", "200"],
    ]);
    expect(events[0]?.price).toBe("101");
    expect(events[0]?.market).toBe("BTC-USD");
  });

  it("labels reduce, close, flip and the wallet's own liquidation", () => {
    const kinds = (fills: TidFill[]) => groupLeaderEvents(fills, INDEX).events.map((e) => e.kind);
    expect(kinds([f({ time: T, side: "A", sz: "1", startPosition: "3" })])).toEqual(["reduce"]);
    const closed = groupLeaderEvents(
      [f({ time: T, side: "A", sz: "3", startPosition: "3", closedPnl: "12", fee: "2" })],
      INDEX,
    ).events[0];
    expect(closed?.realized).toBe("10");
    expect(kinds([f({ time: T, side: "A", sz: "3", startPosition: "3" })])).toEqual(["close"]);
    expect(kinds([f({ time: T, side: "A", sz: "5", startPosition: "3" })])).toEqual(["flip"]);
    expect(
      kinds([f({ time: T, side: "A", sz: "3", startPosition: "3", liquidatedSelf: true })]),
    ).toEqual(["liquidated"]);
  });

  it("marks coins SoDEX doesn't list", () => {
    const { events } = groupLeaderEvents(
      [f({ coin: "HYPE", time: T, side: "B", sz: "1", startPosition: "0" })],
      INDEX,
    );
    expect(events[0]?.market).toBeNull();
  });

  it("keeps a group that is still inside its 60 s window open", () => {
    const fills = [f({ time: T, side: "B", sz: "1", startPosition: "0" })];
    expect(groupLeaderEvents(fills, INDEX, T + 30_000)).toMatchObject({ events: [], open: fills });
    expect(groupLeaderEvents(fills, INDEX, T + 61_000).events).toHaveLength(1);
  });
});

describe("bigMove", () => {
  const ev = (kind: LeaderEvent["kind"], notional: string, at: number): LeaderEvent => ({
    coin: "BTC",
    market: "BTC-USD",
    kind,
    positionBefore: "0",
    positionAfter: "1",
    notional,
    price: "100",
    realized: null,
    at,
    lastAt: at,
    lastTid: "1",
  });
  const base = { medianEntryNotional: "10000", minUsd: "50000", lastAlertAt: null, now: T };

  it("is off without a USD threshold or a known usual size", () => {
    expect(bigMove({ ...base, minUsd: null, events: [ev("open", "900000", T)] })).toBeNull();
    expect(
      bigMove({ ...base, medianEntryNotional: null, events: [ev("open", "900000", T)] }),
    ).toBeNull();
  });

  it("sums opens and adds over 15 minutes and needs both the USD floor and 3× usual size", () => {
    const events = [ev("open", "30000", T - 10 * 60_000), ev("add", "25000", T)];
    expect(bigMove({ ...base, events })?.toString()).toBe("55000");
    expect(
      bigMove({ ...base, events: [ev("open", "55000", T - BIG_MOVE.windowMs - 1)] }),
    ).toBeNull();
    expect(bigMove({ ...base, medianEntryNotional: "20000", events })).toBeNull();
    expect(bigMove({ ...base, events: [ev("reduce", "900000", T)] })).toBeNull();
  });

  it("waits 10 minutes between alerts for the same wallet and coin", () => {
    const events = [ev("open", "90000", T)];
    expect(bigMove({ ...base, events, lastAlertAt: T - 5 * 60_000 })).toBeNull();
    expect(bigMove({ ...base, events, lastAlertAt: T - BIG_MOVE.cooldownMs })).not.toBeNull();
  });
});
