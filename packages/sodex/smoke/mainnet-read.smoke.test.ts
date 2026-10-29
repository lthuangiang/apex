import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import { readDriftApproval } from "../src/approvals";
import { MemoryRateLimitStore } from "../src/rate-limit/token-bucket";
import { SodexRestClient } from "../src/rest/client";
import { wsAckSchema } from "../src/ws/schemas";

// Smoke test CHỈ ĐỌC trên SoDEX mainnet (DEC-23). Không ký, không gửi lệnh.
// Chạy: SODEX_SMOKE=1 pnpm --filter @drift/sodex test:smoke
// Tuỳ chọn: SODEX_SMOKE_ADDRESS=<master wallet> để đọc account, key và approval.

const restUrl = process.env.SODEX_REST_URL ?? "https://mainnet-gw.sodex.dev";
const address = process.env.SODEX_SMOKE_ADDRESS;
const builderId = process.env.DRIFT_BUILDER_ID;
const wsUrl = process.env.SODEX_WS_URL ?? "wss://mainnet-gw.sodex.dev/ws";

const sodex = new SodexRestClient({
  config: { restUrl },
  rateLimit: new MemoryRateLimitStore(),
  egressKey: "smoke",
});

describe("SoDEX mainnet (read-only)", () => {
  it("reads spot market info", async () => {
    const symbols = await sodex.getSpotSymbols();
    expect(symbols.length).toBeGreaterThan(0);
    for (const symbol of symbols) {
      expect(symbol.tickSize).not.toBe("0");
      expect(symbol.stepSize).not.toBe("0");
    }
  });

  it("reads perps market info", async () => {
    const symbols = await sodex.getPerpsSymbols();
    expect(symbols.length).toBeGreaterThan(0);
    for (const symbol of symbols) {
      expect(symbol.maxLeverage).toBeGreaterThan(0);
      expect(symbol.fundingInterval % 3600).toBe(0);
    }
  });

  it.runIf(address !== undefined)("reads the account, API keys and builder approvals", async () => {
    const master = getAddress(address ?? "");
    const account = await sodex.getSubaccounts(master);
    expect(account.primaryAccountID).toBeGreaterThan(0n);

    const keys = await sodex.getApiKeys(master, account.primaryAccountID);
    expect(Array.isArray(keys.spot)).toBe(true);

    const approvals = await sodex.getBuilderApprovals(master);
    if (builderId) {
      const drift = readDriftApproval(approvals, BigInt(builderId));
      expect(typeof drift.approved).toBe("boolean");
    }
  });
});

describe("SoDEX mainnet history and market data (read-only)", () => {
  it("reads perps klines (1d) and mark prices", async () => {
    const klines = await sodex.getKlines("perps", "BTC-USD", { interval: "1d", limit: 30 });
    expect(klines.length).toBeGreaterThan(0);
    const marks = await sodex.getMarkPrices();
    expect(marks.some((m) => m.symbol === "BTC-USD")).toBe(true);
  });

  it.runIf(address !== undefined)("reads trades, closed positions and fundings", async () => {
    const master = getAddress(address ?? "");
    await sodex.getTrades("perps", master, { limit: 50 });
    await sodex.getTrades("spot", master, { limit: 50 });
    await sodex.getPositionsHistory(master, { limit: 50 });
    await sodex.getFundings(master, { limit: 50 });
    await sodex.getOpenOrders("perps", master, {});
    await sodex.getSpotBalances(master);
    const state = await sodex.getPerpsAccountState(master);
    expect(Number(state.av)).toBeGreaterThanOrEqual(0);
    await sodex.getOrderHistory("perps", master, { limit: 50 });
    await sodex.getOrderHistory("spot", master, { limit: 50 });
  });
});

/** Mở WS, gửi các message, gom message trả về cho tới khi `done` đúng. */
function wsExchange(url: string, send: object[], done: (received: unknown[]) => boolean) {
  return new Promise<unknown[]>((resolve, reject) => {
    const ws = new WebSocket(url);
    const received: unknown[] = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("WS smoke timed out"));
    }, 15_000);
    ws.addEventListener("open", () => {
      for (const message of send) ws.send(JSON.stringify(message));
    });
    ws.addEventListener("message", (event) => {
      received.push(JSON.parse(String(event.data)));
      if (done(received)) {
        clearTimeout(timer);
        ws.close();
        resolve(received);
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WS smoke connection failed"));
    });
  });
}

describe("SoDEX mainnet WebSocket (read-only)", () => {
  it("answers ping with pong", async () => {
    const received = await wsExchange(`${wsUrl}/perps`, [{ op: "ping" }], (r) => r.length > 0);
    expect(received[0]).toMatchObject({ op: "pong" });
  });

  it.runIf(address !== undefined)("acknowledges user-stream subscriptions", async () => {
    const user = getAddress(address ?? "");
    const isAck = (m: unknown) => wsAckSchema.safeParse(m).success;
    const received = await wsExchange(
      `${wsUrl}/perps`,
      [
        { op: "subscribe", id: 1, params: { channel: "accountOrderUpdate", user } },
        { op: "subscribe", id: 2, params: { channel: "accountTrade", user } },
      ],
      (r) => r.filter(isAck).length >= 2,
    );
    const acks = received.filter(isAck).map((m) => wsAckSchema.parse(m));
    expect(acks.every((a) => a.success)).toBe(true);
  });
});
