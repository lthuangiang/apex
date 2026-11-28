import {
  errorResponseSchema,
  featuresSchema,
  usMarketsResponseSchema,
  WEALTH_BUSY_REASON,
  wealthMeResponseSchema,
} from "@drift/shared";
import type { WealthReadResult } from "@drift/sodex";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  WEALTH_ME_CACHE_MS,
  type UsMarketRest,
  type WealthReader,
} from "../src/modules/us-market/service";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// #589 (DEC-402): GET /api/v1/markets/us và GET /api/v1/wealth/me. REST SoDEX và Wealth là bản giả (đếm lời gọi);
// địa chỉ ví là địa chỉ giả. Kiểm: công tắc 404, cache theo chu kỳ, chỉ đọc master wallet của chính user, log không có
// địa chỉ.

const WALLET_A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const WALLET_B = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";

const calls: string[] = [];
const switchState = { enabled: true };
const failing = new Set<string>();
/** Phần trả `budget` (hết ngân sách weight của chính DeskLabs, #592). */
const budget = new Set<string>();

const lv = (p: string, s: string): [string, string] => [p, s];
const symbol = (name: string, status: "TRADING" | "HALT" = "TRADING") => ({
  id: 1n,
  name,
  displayName: name.replace("_", "/"),
  pricePrecision: 2,
  tickSize: "0.01",
  minPrice: "0.01",
  maxPrice: "0",
  quantityPrecision: 3,
  stepSize: "0.001",
  minQuantity: "0.001",
  maxQuantity: "0",
  marketMinQuantity: "0.001",
  marketMaxQuantity: "0",
  minNotional: "5",
  maxNotional: "0",
  status,
});

function clockMs() {
  return env.clock.now.getTime();
}

const rest: UsMarketRest = {
  getSpotSymbols: () => {
    calls.push("symbols:spot");
    return Promise.resolve([
      { ...symbol("vANT_vUSDC"), baseCoin: "vANT", quoteCoin: "vUSDC" },
      { ...symbol("vVOO_vUSDC"), baseCoin: "vVOO", quoteCoin: "vUSDC" },
    ]);
  },
  getPerpsSymbols: () => {
    calls.push("symbols:perps");
    return Promise.resolve([
      { ...symbol("ANT-USD", "HALT"), maxLeverage: 10, fundingInterval: 3600 },
    ]);
  },
  getTickers: (engine) => {
    calls.push(`tickers:${engine}`);
    if (engine === "perps")
      return Promise.resolve([
        {
          symbol: "ANT-USD",
          lastPx: "91.38",
          quoteVolume: "129004.1",
          volume: "1",
          closeTime: clockMs() - 1000,
        },
      ]);
    return Promise.resolve([
      {
        symbol: "vANT_vUSDC",
        lastPx: "91.42",
        quoteVolume: "6812.4",
        volume: "1",
        closeTime: clockMs() - 1000,
      },
      {
        symbol: "vVOO_vUSDC",
        lastPx: "662.06",
        quoteVolume: "9.93",
        volume: "0.015",
        closeTime: clockMs() - 3 * 86_400_000,
      },
    ]);
  },
  getOrderbook: (_engine, sym) => {
    calls.push(`orderbook:${sym}`);
    if (failing.has(`orderbook:${sym}`)) return Promise.reject(new Error("boom"));
    if (sym === "vVOO_vUSDC") return Promise.resolve({ bids: [], asks: [] });
    return Promise.resolve({ bids: [lv("90", "27.2")], asks: [lv("91", "21.5")] });
  },
};

const ok = <T>(data: T): Promise<WealthReadResult<T>> => Promise.resolve({ kind: "ok", data });
const np = <T>(): Promise<WealthReadResult<T>> =>
  Promise.resolve({ kind: "not_provided", reason: "business" });
const busy = <T>(retryAfterMs: number): Promise<WealthReadResult<T>> =>
  Promise.resolve({ kind: "not_provided", reason: "budget", retryAfterMs });

const pnlOf = (total: string) => ({
  currency: "USD",
  settledValue: total,
  totalCost: "100",
  totalPnl: "1",
  totalRealizedPnl: "0",
  totalUnrealizedPnl: "1",
  totalPnl24h: "0.5",
  inFlightValue: "0",
  totalValue: total,
  complete: true,
  incompleteFunds: null,
  bridgeStatus: null,
  positions: [
    {
      fundId: "CXMT",
      source: "vault",
      shares: "20",
      avgCostWithAirdrop: "5",
      price: "5.05",
      priceAsOf: null,
      marketValue: total,
      unrealizedPnl: "1",
      realizedPnl: "0",
      pnl24h: "0.5",
      priced: true,
    },
  ],
});

const wealth: WealthReader = {
  getFunds: () => {
    calls.push("funds");
    if (failing.has("funds")) return np();
    return ok([
      {
        fundId: "CXMT",
        name: "CXMT",
        fundType: "escrow_vault",
        fundStatus: "live",
        iconUrl: null,
        tagline: null,
        nav: "5.05",
        aum: "18066.98",
        asOf: "2026-10-27T07:00:00Z",
        share: null,
        spot: null,
      },
      {
        fundId: "vVOO",
        name: "vVOO Fund",
        fundType: "clob",
        fundStatus: "live",
        iconUrl: null,
        tagline: null,
        nav: null,
        aum: null,
        asOf: null,
        share: null,
        spot: { symbol: "vVOO_vUSDC", symbolId: 39, displayName: "VOO/USDC", quote: null },
      },
    ]);
  },
  getTradingStatus: (fundId) => {
    calls.push(`trading-status:${fundId}`);
    return ok({
      fundId,
      channel: "closed",
      closedReason: "batch_cutoff",
      nextChannel: "batch",
      nextChannelAt: 1795998600,
      sessionMode: "auto",
      rfq: null,
      batch: null,
    });
  },
  getPnl: (address) => {
    calls.push(`pnl:${address}`);
    if (budget.has("pnl")) return busy(12_000);
    if (failing.has("pnl")) return np();
    return ok(pnlOf(address === WALLET_A.toLowerCase() ? "101" : "202"));
  },
  getPositions: (address) => {
    calls.push(`positions:${address}`);
    if (budget.has("positions")) return busy(20_000);
    return ok({
      summary: null,
      bridgeStatus: null,
      positions: [
        {
          fundId: "CXMT",
          name: null,
          source: "vault",
          coin: null,
          share: null,
          spot: null,
          pendingRedeemShares: "10",
          pendingDepositShares: "0",
          processingCost: "0",
          pendingProceeds: "0",
          costBasis: "100",
          ledgerShares: "30",
          avgCost: "5",
          avgCostWithAirdrop: null,
          completedCost: "100",
          redeemedShares: "0",
        },
      ],
    });
  },
  getInFlight: (address) => {
    calls.push(`in-flight:${address}`);
    return ok({ funds: [], bridgeStatus: null });
  },
  getFundDetails: (address) => {
    calls.push(`fund-details:${address}`);
    return ok({ totals: [], entries: [], bridgeStatus: null });
  },
  // Thật: gateway trả `code -1` cho ví không có kế hoạch.
  getRecurringBuys: (address) => {
    calls.push(`recurring-buys:${address}`);
    return np();
  },
  getPnlHistory: (address) => {
    calls.push(`pnl-history:${address}`);
    if (budget.has("pnl-history")) return busy(5_000);
    return ok({ currency: "USD", interval: "1d", range: "1M", points: [], accountingFrom: null });
  },
};

let env: TestEnv;

beforeAll(async () => {
  env = await startTestEnv({
    usMarket: { enabled: () => switchState.enabled, wealth, rest },
  });
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => {
  calls.length = 0;
  failing.clear();
  budget.clear();
  switchState.enabled = true;
  // Mỗi test ở một chu kỳ cache mới.
  env.clock.now = new Date(env.clock.now.getTime() + 5 * 60_000);
});

async function connect(email: string, address: string) {
  const client = new TestClient(env.app);
  await signIn(env, client, email);
  const user = await env.pool.query<{ id: string }>("select id from users where email = $1", [
    email,
  ]);
  await env.pool.query(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected')",
    [user.rows[0]?.id ?? "", address, Math.floor(Math.random() * 1e9)],
  );
  return client;
}

describe("US_MARKET_ENABLED switch", () => {
  it("features.usMarket follows the switch; routes 404 when off", async () => {
    const user = new TestClient(env.app);
    await signIn(env, user, "us-switch@example.com");
    const features = async () =>
      featuresSchema.parse((await user.request("GET", "/api/v1/features")).json());
    expect((await features()).usMarket).toBe(true);

    switchState.enabled = false;
    expect((await features()).usMarket).toBe(false);
    for (const path of ["/api/v1/markets/us", "/api/v1/wealth/me"]) {
      const r = await user.request("GET", path);
      expect(r.statusCode).toBe(404);
      expect(errorResponseSchema.parse(r.json()).error.code).toBe("NOT_FOUND");
    }
    expect(calls).toEqual([]);
  });

  it("requires sign-in", async () => {
    const anon = new TestClient(env.app);
    expect((await anon.request("GET", "/api/v1/markets/us")).statusCode).toBe(401);
    expect((await anon.request("GET", "/api/v1/wealth/me")).statusCode).toBe(401);
  });
});

describe("GET /api/v1/markets/us", () => {
  it("returns depth, status, last trade and funds; one read per market per cycle", async () => {
    const user = new TestClient(env.app);
    await signIn(env, user, "us-markets@example.com");
    const r = await user.request("GET", "/api/v1/markets/us");
    expect(r.statusCode).toBe(200);
    const body = usMarketsResponseSchema.parse(r.json());
    expect(body.readAt).toBe(env.clock.now.toISOString());

    const [perps, spot] = body.anthropic;
    expect(perps).toMatchObject({
      symbol: "ANT-USD",
      engine: "perps",
      maxLeverage: 10,
      lastPrice: "91.38",
      volume24h: "129004.1",
      bookStatus: "halted",
    });
    expect(spot).toMatchObject({
      symbol: "vANT_vUSDC",
      bookStatus: "trading",
      depth: {
        bidsNotional: "2448",
        asksNotional: "1956.5",
        label: "thin",
        maxPositionUsd: "1956.5",
      },
    });

    if (body.fundTokens.status !== "ok") throw new Error("fund tokens missing");
    expect(body.fundTokens.items).toEqual([
      expect.objectContaining({
        symbol: "vVOO_vUSDC",
        fundId: "vVOO",
        bookStatus: "empty",
        volume24h: null,
        lastPrice: "662.06",
        depth: expect.objectContaining({ label: "very_thin" }) as unknown,
      }),
    ]);
    expect(body.fundTokens.items[0]?.lastTradeAt).not.toBeNull();

    if (body.funds.status !== "ok") throw new Error("funds missing");
    expect(body.funds.items).toEqual([
      expect.objectContaining({
        fundId: "CXMT",
        aum: "18066.98",
        requests: {
          channel: "closed",
          open: false,
          closedReason: "batch_cutoff",
          nextChannel: "batch",
          nextChannelAt: new Date(1795998600 * 1000).toISOString(),
        },
      }),
    ]);

    // Ba người xem trong cùng chu kỳ: vẫn một lần đọc mỗi market.
    const other = new TestClient(env.app);
    await signIn(env, other, "us-markets-2@example.com");
    await other.request("GET", "/api/v1/markets/us");
    await user.request("GET", "/api/v1/markets/us");
    expect(calls.filter((c) => c === "orderbook:ANT-USD")).toHaveLength(1);
    expect(calls.filter((c) => c === "funds")).toHaveLength(1);

    // Hết chu kỳ: đọc lại.
    env.clock.now = new Date(env.clock.now.getTime() + 61_000);
    await user.request("GET", "/api/v1/markets/us");
    expect(calls.filter((c) => c === "orderbook:ANT-USD")).toHaveLength(2);
  });

  it("partial failures → null / not_provided, never zero", async () => {
    failing.add("orderbook:vANT_vUSDC");
    failing.add("funds");
    const user = new TestClient(env.app);
    await signIn(env, user, "us-partial@example.com");
    const body = usMarketsResponseSchema.parse(
      (await user.request("GET", "/api/v1/markets/us")).json(),
    );
    expect(body.anthropic[1]).toMatchObject({ depth: null, bookStatus: null, lastPrice: "91.42" });
    expect(body.fundTokens).toEqual({ status: "not_provided" });
    expect(body.funds).toEqual({ status: "not_provided" });
  });
});

describe("GET /api/v1/wealth/me", () => {
  it("not connected → not_connected, no gateway call", async () => {
    const user = new TestClient(env.app);
    await signIn(env, user, "us-none@example.com");
    const r = await user.request("GET", "/api/v1/wealth/me");
    expect(r.statusCode).toBe(200);
    expect(wealthMeResponseSchema.parse(r.json())).toEqual({ status: "not_connected" });
    expect(calls.filter((c) => c.startsWith("pnl:"))).toEqual([]);
  });

  it("reads only the signed-in user's master wallet; cached per address; no address in logs", async () => {
    const a = await connect("us-wallet-a@example.com", WALLET_A);
    const b = await connect("us-wallet-b@example.com", WALLET_B);
    const logStart = env.logs.length;

    const ra = wealthMeResponseSchema.parse(
      (await a.request("GET", "/api/v1/wealth/me?address=" + WALLET_B)).json(),
    );
    if (ra.status !== "ok") throw new Error("expected ok");
    expect(ra.summary.totalValue).toBe("101");
    expect(ra.holdings[0]).toMatchObject({
      fundId: "CXMT",
      name: "CXMT",
      fundType: "escrow_vault",
      avgCost: "5",
      pendingRedeemShares: "10",
    });
    // Không yêu cầu `include` → không đọc mua định kỳ / PnL history (#592).
    expect(ra.recurringBuys).toBeUndefined();
    expect(ra.pnlHistory).toBeUndefined();
    expect(ra.inFlight).toEqual({ status: "ok", items: [] });

    const rb = wealthMeResponseSchema.parse((await b.request("GET", "/api/v1/wealth/me")).json());
    if (rb.status !== "ok") throw new Error("expected ok");
    expect(rb.summary.totalValue).toBe("202");

    expect(calls.filter((c) => c.startsWith("pnl:"))).toEqual([
      `pnl:${WALLET_A.toLowerCase()}`,
      `pnl:${WALLET_B.toLowerCase()}`,
    ]);
    // Mỗi lượt mặc định: 4 lời gọi theo địa chỉ, không có recurring-buys / pnl-history.
    const perAddress = calls.filter((c) => c.endsWith(WALLET_A.toLowerCase()));
    expect(perAddress.sort()).toEqual(
      ["fund-details", "in-flight", "pnl", "positions"].map(
        (p) => `${p}:${WALLET_A.toLowerCase()}`,
      ),
    );
    // Trong chu kỳ cache: không đọc lại.
    await a.request("GET", "/api/v1/wealth/me");
    expect(calls.filter((c) => c === `pnl:${WALLET_A.toLowerCase()}`)).toHaveLength(1);

    // Phần thêm lỗi (ví không có kế hoạch mua định kỳ → `code -1`): log `wealth: read failed`, không có địa chỉ.
    const withPlans = wealthMeResponseSchema.parse(
      (await a.request("GET", "/api/v1/wealth/me?include=recurringBuys")).json(),
    );
    if (withPlans.status !== "ok") throw new Error("expected ok");
    expect(withPlans.recurringBuys).toEqual({ status: "not_provided" });

    // Dòng log request của fastify ghi URL mà client gửi (ở đây chính test đã chèn `?address=` giả); chỉ xét log do
    // module US Market ghi: không được có địa chỉ ví.
    const logs = env.logs
      .slice(logStart)
      .filter((line) => !line.includes('"req":') && !line.includes('"res":'))
      .join("\n")
      .toLowerCase();
    expect(logs).toContain("wealth: read failed");
    expect(logs).not.toContain(WALLET_A.toLowerCase());
    expect(logs).not.toContain(WALLET_B.toLowerCase());
    expect(logs).not.toContain(WALLET_A.slice(2, 12).toLowerCase());
  });

  it("pnl failure → 502 SODEX_UNAVAILABLE, not cached", async () => {
    const c = await connect(
      "us-wallet-fail@example.com",
      "0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc",
    );
    failing.add("pnl");
    const r = await c.request("GET", "/api/v1/wealth/me");
    expect(r.statusCode).toBe(502);
    expect(errorResponseSchema.parse(r.json()).error.code).toBe("SODEX_UNAVAILABLE");
    failing.delete("pnl");
    expect((await c.request("GET", "/api/v1/wealth/me")).statusCode).toBe(200);
  });

  it("own weight budget → 429 RATE_LIMITED busy with retryAfterMs, not cached (#592)", async () => {
    const d = await connect(
      "us-wallet-busy@example.com",
      "0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd",
    );
    budget.add("positions");
    const r = await d.request("GET", "/api/v1/wealth/me");
    expect(r.statusCode).toBe(429);
    const err = errorResponseSchema.parse(r.json()).error;
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.details).toMatchObject({ reason: WEALTH_BUSY_REASON, retryAfterMs: 20_000 });

    budget.clear();
    budget.add("pnl");
    const r2 = await d.request("GET", "/api/v1/wealth/me");
    expect(r2.statusCode).toBe(429);
    expect(errorResponseSchema.parse(r2.json()).error.details).toMatchObject({
      reason: WEALTH_BUSY_REASON,
      retryAfterMs: 12_000,
    });

    // Không cache trạng thái busy: hết budget thì đọc lại được ngay.
    budget.clear();
    expect((await d.request("GET", "/api/v1/wealth/me")).statusCode).toBe(200);

    // Phần thêm hết budget cũng là busy.
    budget.add("pnl-history");
    const r3 = await d.request("GET", "/api/v1/wealth/me?include=pnlHistory");
    expect(r3.statusCode).toBe(429);
    expect(errorResponseSchema.parse(r3.json()).error.details).toMatchObject({
      reason: WEALTH_BUSY_REASON,
      retryAfterMs: 5_000,
    });
  });

  it("include= reads recurring buys / pnl history only on request, each cached on its own (#592)", async () => {
    const addr = "0xEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEe";
    const e = await connect("us-wallet-include@example.com", addr);
    const key = addr.toLowerCase();
    const count = (part: string) => calls.filter((c) => c === `${part}:${key}`).length;

    await e.request("GET", "/api/v1/wealth/me");
    expect(count("recurring-buys")).toBe(0);
    expect(count("pnl-history")).toBe(0);

    const body = wealthMeResponseSchema.parse(
      (await e.request("GET", "/api/v1/wealth/me?include=recurringBuys,pnlHistory")).json(),
    );
    if (body.status !== "ok") throw new Error("expected ok");
    expect(body.recurringBuys).toEqual({ status: "not_provided" });
    expect(body.pnlHistory).toEqual({ status: "ok", items: [] });
    // Phần chính vẫn từ cache: không đọc lại pnl.
    expect(count("pnl")).toBe(1);
    expect(count("recurring-buys")).toBe(1);
    expect(count("pnl-history")).toBe(1);

    const only = wealthMeResponseSchema.parse(
      (await e.request("GET", "/api/v1/wealth/me?include=pnlHistory")).json(),
    );
    if (only.status !== "ok") throw new Error("expected ok");
    expect(only.recurringBuys).toBeUndefined();
    expect(count("pnl-history")).toBe(1);

    const bad = await e.request("GET", "/api/v1/wealth/me?include=everything");
    expect(bad.statusCode).toBe(400);
    expect(errorResponseSchema.parse(bad.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("caches per address for 60–120 s (#592)", async () => {
    expect(WEALTH_ME_CACHE_MS).toBeGreaterThanOrEqual(60_000);
    expect(WEALTH_ME_CACHE_MS).toBeLessThanOrEqual(120_000);
    const addr = "0xFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFf";
    const f = await connect("us-wallet-ttl@example.com", addr);
    const pnlReads = () => calls.filter((c) => c === `pnl:${addr.toLowerCase()}`).length;
    await f.request("GET", "/api/v1/wealth/me");
    env.clock.now = new Date(env.clock.now.getTime() + 59_000);
    await f.request("GET", "/api/v1/wealth/me");
    expect(pnlReads()).toBe(1);
    env.clock.now = new Date(env.clock.now.getTime() + WEALTH_ME_CACHE_MS);
    await f.request("GET", "/api/v1/wealth/me");
    expect(pnlReads()).toBe(2);
  });
});
