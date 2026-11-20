import { HyperliquidRateLimitedError, type HlFill, type HlPriority } from "@drift/hyperliquid";
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
  const marked: [string, number][] = [];
  const deps: HlLeaderTrackerDeps = {
    copied: () => Promise.resolve([A]),
    followed: () => Promise.resolve([]),
    research: () => Promise.resolve([]),
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
    markPolled: (a, ms) => {
      marked.push([a, ms]);
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
    marked,
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

  it("adds xyz HIP-3 positions mapped to SoDEX, summing a symbol listed on both (DEC-207)", async () => {
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

  it("marks a successful poll, even with no new fill or when only setting the cursor; never a failed one (#349)", async () => {
    let fail = false;
    const h = harness({
      copied: () => Promise.resolve([]),
      followed: () => Promise.resolve([B]),
      hl: {
        clearinghouseState: () => Promise.resolve({ assetPositions: [] }),
        userFillsByTime: () => (fail ? Promise.reject(new Error("429")) : Promise.resolve([])),
      },
    });
    await h.t.poll();
    expect(h.marked).toEqual([[B, T]]);
    h.advance(120_000);
    await h.t.poll();
    expect(h.marked).toEqual([
      [B, T],
      [B, T + 120_000],
    ]);
    fail = true;
    h.advance(120_000);
    await h.t.poll();
    expect(h.marked).toHaveLength(2);
  });

  it("marks a streaming wallet when its sync read succeeds, not when it fails", async () => {
    const ok = harness();
    await ok.t.sync();
    expect(ok.marked).toEqual([[A, T]]);
    const bad = harness({
      hl: {
        clearinghouseState: () => Promise.reject(new Error("429")),
        userFillsByTime: () => Promise.resolve([]),
      },
    });
    await bad.t.sync();
    expect(bad.marked).toEqual([]);
  });

  describe("research wallets (#353)", () => {
    const C = "0xccc0000000000000000000000000000000000003";
    const D = "0xddd0000000000000000000000000000000000004";
    const E = "0xeee0000000000000000000000000000000000005";

    /** Ghi lại thứ tự đọc và priority / yieldOnLimit; `limitAfter` = số lần đọc nhường được trước khi chạm rate limit. */
    function reads(limitAfter = Infinity) {
      const calls: [string, HlPriority, boolean][] = [];
      let yielding = 0;
      return {
        calls,
        hl: {
          clearinghouseState: () => Promise.resolve({ assetPositions: [] }),
          userFillsByTime: (
            user: string,
            _start: number,
            priority: HlPriority,
            call?: { yieldOnLimit?: boolean },
          ) => {
            const y = call?.yieldOnLimit === true;
            if (y && (yielding += 1) > limitAfter)
              return Promise.reject(new HyperliquidRateLimitedError(1000));
            calls.push([user, priority, y]);
            return Promise.resolve([]);
          },
        },
      };
    }
    const withCursors = (h: ReturnType<typeof harness>, xs: string[]) => {
      for (const a of xs) h.cursors.set(a, T - 1000);
    };

    it("polls followed wallets first (realtime), then research wallets (background, yielding) in rank order", async () => {
      const r = reads();
      const h = harness({
        copied: () => Promise.resolve([]),
        followed: () => Promise.resolve([B]),
        research: () => Promise.resolve([D, C]),
        hl: r.hl,
      });
      withCursors(h, [B, C, D]);
      await h.t.poll();
      expect(r.calls).toEqual([
        [B, "realtime", false],
        [D, "background", true],
        [C, "background", true],
      ]);
      expect(h.marked.map(([a]) => a)).toEqual([B, D, C]);
    });

    it("never polls a wallet twice: followed or streaming wallets are skipped in the research list", async () => {
      const r = reads();
      const h = harness({
        copied: () => Promise.resolve([A]),
        followed: () => Promise.resolve([B]),
        research: () => Promise.resolve([A, B.toUpperCase().replace("0X", "0x"), C]),
        hl: r.hl,
      });
      withCursors(h, [A, B, C]);
      await h.t.sync();
      await h.t.poll();
      expect(r.calls.map(([a]) => a)).toEqual([B, C]);
    });

    it("shares the poll cap: research wallets only fill what followed wallets leave", async () => {
      const r = reads();
      const h = harness({
        copied: () => Promise.resolve([]),
        followed: () => Promise.resolve([B]),
        research: () => Promise.resolve([C, D, E]),
        hl: r.hl,
        maxPolled: 3,
      });
      withCursors(h, [B, C, D, E]);
      await h.t.poll();
      expect(r.calls.map(([a]) => a)).toEqual([B, C, D]);
    });

    it("yields the rest of the round at the rate limit, without marking the skipped wallets", async () => {
      const warned: string[] = [];
      const r = reads(1);
      const h = harness({
        copied: () => Promise.resolve([]),
        followed: () => Promise.resolve([B]),
        research: () => Promise.resolve([C, D, E]),
        hl: r.hl,
        warn: (_o, m) => warned.push(m),
      });
      withCursors(h, [B, C, D, E]);
      await h.t.poll();
      expect(r.calls.map(([a]) => a)).toEqual([B, C]);
      expect(h.marked.map(([a]) => a)).toEqual([B, C]);
      expect(warned).toEqual(["hyperliquid rate limit: research wallets yielded"]);
    });
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
