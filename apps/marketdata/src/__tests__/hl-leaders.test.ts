import type { HlFill } from "@drift/hyperliquid";
import { coinIndex, type LeaderEvent } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { HlLeaderTracker, type HlLeaderTrackerDeps } from "../hl-leaders";

const T = Date.UTC(2026, 10, 11, 12);
const A = "0xaaa0000000000000000000000000000000000001";
const B = "0xbbb0000000000000000000000000000000000002";

let tid = 0;
const fill = (p: Partial<HlFill> = {}): HlFill => ({
  coin: "BTC",
  px: "100",
  sz: "1",
  side: "B",
  time: T,
  startPosition: "0",
  dir: "Open Long",
  closedPnl: "0",
  fee: "0",
  feeToken: "USDC",
  tid: String((tid += 1)),
  liquidation: null,
  ...p,
});

function harness(over: Partial<HlLeaderTrackerDeps> = {}) {
  let now = T;
  const published: [string, unknown][] = [];
  const users: string[][] = [];
  const cursors = new Map<string, number>();
  const events: [string, LeaderEvent[]][] = [];
  const polled: [string, number][] = [];
  const deps: HlLeaderTrackerDeps = {
    copied: () => Promise.resolve([A]),
    followed: () => Promise.resolve([]),
    stream: { setUsers: (u) => users.push([...u]) },
    hl: {
      // Perp gốc khi không có `dex`; dex HIP-3 `xyz` trả vị thế riêng.
      clearinghouseState: (_user, _priority, dex) =>
        Promise.resolve({
          assetPositions:
            dex === undefined
              ? [
                  { position: { coin: "BTC", szi: "2" } },
                  { position: { coin: "HYPE", szi: "5" } },
                  { position: { coin: "kPEPE", szi: "-1000" } },
                ]
              : [],
        }),
      userFillsByTime: (user, start) => {
        polled.push([user, start]);
        return Promise.resolve([fill({ time: start + 10 })]);
      },
    },
    index: () => coinIndex(["BTC-USD", "1000PEPE-USD"]),
    publish: (s, p) => published.push([s, p]),
    getCursor: (a) => Promise.resolve(cursors.get(a) ?? null),
    setCursor: (a, ms) => {
      cursors.set(a, ms);
      return Promise.resolve();
    },
    onEvents: (a, e) => {
      events.push([a, e]);
      return Promise.resolve();
    },
    now: () => now,
    warn: () => undefined,
    ...over,
  };
  return {
    t: new HlLeaderTracker(deps),
    published,
    users,
    cursors,
    events,
    polled,
    advance: (ms: number) => (now += ms),
  };
}

describe("HlLeaderTracker", () => {
  it("streams copied wallets and publishes positions on SoDEX markets only", async () => {
    const h = harness();
    await h.t.sync();
    expect(h.users).toEqual([[A]]);
    expect(h.published).toEqual([
      [
        `leader.hyperliquid.${A}.position`,
        {
          source: "hyperliquid",
          address: A,
          positions: { "BTC-USD": "2", "1000PEPE-USD": "-1000" },
          at: T,
        },
      ],
    ]);
  });

  it("adds xyz HIP-3 positions mapped to SoDEX, summing a symbol listed on both (DEC-TBD-hip3-xyz)", async () => {
    const h = harness({
      index: () => coinIndex(["BTC-USD", "TSLA-USD", "MSTR-USD"]),
      hl: {
        clearinghouseState: (_user, _priority, dex) =>
          Promise.resolve({
            assetPositions:
              dex === "xyz"
                ? [
                    { position: { coin: "xyz:TSLA", szi: "3" } },
                    { position: { coin: "xyz:MSTR", szi: "1" } },
                    { position: { coin: "xyz:GOLD", szi: "9" } },
                  ]
                : [
                    { position: { coin: "BTC", szi: "2" } },
                    { position: { coin: "MSTR", szi: "-0.5" } },
                  ],
          }),
        userFillsByTime: () => Promise.resolve([]),
      },
    });
    await h.t.sync();
    expect(h.published[0]?.[1]).toMatchObject({
      positions: { "BTC-USD": "2", "TSLA-USD": "3", "MSTR-USD": "0.5" },
    });
  });

  it("publishes no snapshot when the xyz read fails, so the engine never sees false zeros", async () => {
    const warned: unknown[] = [];
    const h = harness({
      warn: (o) => warned.push(o),
      hl: {
        clearinghouseState: (_user, _priority, dex) =>
          dex === "xyz"
            ? Promise.reject(new Error("429"))
            : Promise.resolve({ assetPositions: [{ position: { coin: "BTC", szi: "2" } }] }),
        userFillsByTime: () => Promise.resolve([]),
      },
    });
    await h.t.sync();
    expect(h.published).toEqual([]);
    expect(warned).toHaveLength(1);
  });

  it("keeps wallets already streaming when over the limit", async () => {
    let copied = [B];
    const h = harness({ copied: () => Promise.resolve(copied), maxStreams: 1 });
    await h.t.sync();
    copied = [A, B];
    await h.t.sync();
    expect(h.users.at(-1)).toEqual([B]);
  });

  it("publishes WS fills with the position after the fill, skipping coins SoDEX lacks", () => {
    const h = harness();
    h.t.onWsFills(A, [
      fill({ side: "A", sz: "3", startPosition: "1", px: "101" }),
      fill({ coin: "HYPE" }),
    ]);
    expect(h.published).toEqual([
      [
        `leader.hyperliquid.${A}.fill`,
        {
          source: "hyperliquid",
          address: A,
          market: "BTC-USD",
          side: "sell",
          price: "101",
          quantity: "3",
          positionAfter: "-2",
          at: T,
        },
      ],
    ]);
  });

  it("only sets a cursor on the first poll, then reads from it; skips streaming wallets", async () => {
    const h = harness({ followed: () => Promise.resolve([A, B]) });
    await h.t.sync();
    await h.t.poll();
    expect(h.polled).toEqual([]);
    expect(h.cursors.get(B)).toBe(T);
    await h.t.poll();
    expect(h.polled).toEqual([[B, T + 1]]);
    expect(h.cursors.get(B)).toBe(T + 11);
  });

  it("groups buffered fills into events once their 60 s window has passed", async () => {
    const h = harness();
    await h.t.sync();
    h.t.onWsFills(A, [fill(), fill({ time: T + 20_000, startPosition: "1" })]);
    await h.t.flush();
    expect(h.events).toEqual([]);
    h.advance(61_000);
    await h.t.flush();
    expect(h.events.map(([a, e]) => [a, e.map((x) => [x.kind, x.positionAfter])])).toEqual([
      [A, [["open", "2"]]],
    ]);
    expect(h.cursors.get(A)).toBe(T + 20_000);
  });
});
