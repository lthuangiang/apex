import { dec, hyperliquidCoinOf, hyperliquidMapKey } from "@drift/shared";
import { describe, expect, it, vi } from "vitest";

import { bandStep, LiquidationScanner, SCAN_CONFIG, toBands } from "../liquidations";

const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

function memoryStore() {
  const sets = new Map<string, Set<string>>();
  const values = new Map<string, string>();
  return {
    values,
    sadd: (k: string, ...m: string[]) => {
      const s = sets.get(k) ?? new Set<string>();
      for (const x of m) s.add(x);
      sets.set(k, s);
      return Promise.resolve(m.length);
    },
    srem: (k: string, ...m: string[]) => {
      for (const x of m) sets.get(k)?.delete(x);
      return Promise.resolve(m.length);
    },
    smembers: (k: string) => Promise.resolve([...(sets.get(k) ?? [])]),
    set: (k: string, v: string) => {
      values.set(k, v);
      return Promise.resolve("OK");
    },
  };
}

function deps(reply: (body: Record<string, string>) => unknown) {
  const store = memoryStore();
  const fetchFn = vi.fn((_url: string, init: { body: string }) =>
    Promise.resolve(
      new Response(JSON.stringify(reply(JSON.parse(init.body) as Record<string, string>))),
    ),
  );
  return {
    store,
    fetchFn,
    scanner: new LiquidationScanner({
      store,
      fetch: fetchFn as unknown as typeof fetch,
      now: () => 1_000,
      sleep: () => Promise.resolve(),
      warn: vi.fn(),
    }),
  };
}

describe("toBands", () => {
  it("uses a tidy step near 0.2% of the price", () => {
    expect(bandStep(dec("77000")).toString()).toBe("200");
    expect(bandStep(dec("2.5")).toString()).toBe("0.005");
  });

  it("sums positions per band and drops far liquidations", () => {
    const bands = toBands(
      [
        { coin: "BTC", liquidationPx: "76010", value: "100" },
        { coin: "BTC", liquidationPx: "76090", value: "50.5" },
        { coin: "BTC", liquidationPx: "78100", value: "20" },
        { coin: "BTC", liquidationPx: "30000", value: "999" },
      ],
      "77000",
    );
    expect(bands).toEqual([
      { price: "76000", value: "150.5" },
      { price: "78000", value: "20" },
    ]);
  });
});

describe("hyperliquidCoinOf", () => {
  it("maps SoDEX perp and spot names", () => {
    expect(hyperliquidCoinOf("BTC-USD")).toBe("BTC");
    expect(hyperliquidCoinOf("vBTC_vUSDC")).toBe("BTC");
    expect(hyperliquidCoinOf("VET-USD")).toBe("VET");
  });
});

describe("LiquidationScanner", () => {
  const position = { coin: "BTC", liquidationPx: "76000", positionValue: "100" };

  it("publishes a map once enough positions are scanned", async () => {
    const users = Array.from({ length: SCAN_CONFIG.minPositions }, (_, i) => [
      wallet(i * 2 + 1),
      wallet(i * 2 + 2),
    ]);
    const { scanner, store } = deps((b) => {
      if (b.type === "recentTrades")
        return b.coin === "BTC" ? users.map((u) => ({ users: u })) : [];
      if (b.type === "allMids") return { BTC: "77000" };
      return { assetPositions: [{ position }] };
    });
    await scanner.cycle();
    const raw = store.values.get(hyperliquidMapKey("BTC"));
    expect(raw).toBeDefined();
    expect(JSON.parse(raw ?? "{}")).toMatchObject({
      updatedAt: 1_000,
      bands: [{ price: "76000" }],
    });
  });

  it("keeps the map hidden while the sample is too small", async () => {
    const { scanner, store } = deps((b) => {
      if (b.type === "recentTrades") return [{ users: [wallet(1), wallet(2)] }];
      if (b.type === "allMids") return { BTC: "77000" };
      return { assetPositions: [{ position }] };
    });
    await scanner.cycle();
    expect(store.values.size).toBe(0);
  });

  it("stays within the Hyperliquid weight budget per cycle", async () => {
    const users = Array.from({ length: 400 }, (_, i) => wallet(i + 1));
    const { scanner, fetchFn } = deps((b) => {
      if (b.type === "recentTrades") return [{ users }];
      if (b.type === "allMids") return {};
      return { assetPositions: [] };
    });
    await scanner.cycle();
    const bodies = fetchFn.mock.calls.map((c) => JSON.parse(c[1].body) as { type: string });
    const weight = bodies.reduce((s, b) => s + (b.type === "recentTrades" ? 20 : 2), 0);
    expect(weight).toBeLessThan(1_200);
    expect(bodies.filter((b) => b.type === "clearinghouseState")).toHaveLength(
      SCAN_CONFIG.walletsPerCycle,
    );
  });

  it("never sends anything but read requests", async () => {
    const { scanner, fetchFn } = deps((b) => (b.type === "allMids" ? {} : []));
    await scanner.cycle();
    for (const c of fetchFn.mock.calls) expect(c[0]).toBe("https://api.hyperliquid.xyz/info");
  });
});
