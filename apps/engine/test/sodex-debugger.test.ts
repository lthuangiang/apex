import {
  MemoryRateLimitStore,
  SignedWriteClient,
  SodexCallRecorder,
  type SodexCallRow,
  type SodexRestClient,
} from "@drift/sodex";
import type { OrderIntent } from "@drift/strategies";
import { afterEach, describe, expect, it } from "vitest";

import { withBotCallContext } from "../src/call-context";
import type { AccountRef } from "../src/gateway";
import { HttpGateway } from "../src/http-gateway";

// SoDEX Debugger trên đường gửi lệnh của engine (DEC-309): kết quả submit giống hệt khi có recorder,
// kể cả khi DB ghi treo; lời gọi mang botId / accountId / traceId của bot.

const symbol = {
  id: 1n,
  name: "vBTC_vUSDC",
  tickSize: "0.01",
  stepSize: "0.0001",
  minQuantity: "0.0001",
  minNotional: "5",
  status: "TRADING",
};
const rest = {
  getSpotSymbols: () => Promise.resolve([symbol]),
  getPerpsSymbols: () => Promise.resolve([]),
} as unknown as SodexRestClient;
const signer = { sign: () => Promise.resolve(`0x01${"cd".repeat(65)}` as `0x${string}`) };
const order: OrderIntent = {
  clOrdID: "c1",
  market: "vBTC_vUSDC",
  engine: "spot",
  side: "buy",
  type: "limit",
  price: "100",
  quantity: "1",
  timeInForce: "GTC",
  reduceOnly: false,
  tag: "t",
};
const account: AccountRef = {
  id: "0193a0c4-0000-7000-8000-000000000001",
  address: "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db",
  sodexAccountId: 7n,
  apiKeyId: "k",
  apiKeyName: "DeskLabs",
};
const fence = { shard: 0, epoch: 1 };

const recorders: SodexCallRecorder[] = [];
afterEach(async () => {
  await Promise.all(recorders.splice(0).map((r) => r.close(10)));
});

function gateway(recorder?: SodexCallRecorder) {
  let n = 0;
  const writer = new SignedWriteClient({
    config: { restUrl: "https://mainnet-gw.sodex.dev", restWeightPerMinute: 1_000_000_000 },
    rateLimit: new MemoryRateLimitStore(),
    egressKey: "test",
    fetch: () => {
      n += 1;
      // Lần lượt: khớp, bị từ chối từng lệnh, timeout.
      if (n % 3 === 0) return Promise.reject(new DOMException("timed out", "TimeoutError"));
      const data =
        n % 3 === 1
          ? '[{"code":0,"clOrdID":"c1","orderID":11}]'
          : '[{"code":-1,"clOrdID":"c1","error":"PostOnly"}]';
      return Promise.resolve(
        new Response(`{"code":0,"timestamp":1,"data":${data}}`, { status: 200 }),
      );
    },
    ...(recorder === undefined ? {} : { recorder }),
  });
  return new HttpGateway(rest, writer, signer, 1645n);
}

describe("engine order path with the SoDEX Debugger", () => {
  it("submits with the same results while the debugger's DB write hangs", async () => {
    const hanging = new SodexCallRecorder({
      service: "engine",
      flushIntervalMs: 1,
      sink: () => new Promise(() => undefined),
    });
    recorders.push(hanging);
    const plain = gateway();
    const recorded = gateway(hanging);
    for (let i = 0; i < 6; i += 1) {
      const a = await plain.submit(account, [order], fence);
      const b = await recorded.submit(account, [order], fence);
      expect(b).toEqual(a);
    }
    expect(hanging.queued + hanging.dropped.ok + hanging.dropped.problem).toBeGreaterThan(0);
  });

  it("tags every SoDEX call of a bot with its bot, account and one traceId per operation", async () => {
    const rows: SodexCallRow[] = [];
    const recorder = new SodexCallRecorder({
      service: "engine",
      flushIntervalMs: 3_600_000,
      sink: (batch) => {
        rows.push(...batch);
        return Promise.resolve();
      },
    });
    recorders.push(recorder);
    const gw = withBotCallContext(gateway(recorder), "bot-1", account.id);
    await gw.submit(account, [order], fence);
    await gw.submit(account, [order], fence);
    await recorder.flush();
    // Flush ghi bản ghi lỗi trước: so không theo thứ tự.
    expect(rows.map((r) => [r.botId, r.accountId, r.outcome]).sort()).toEqual([
      ["bot-1", account.id, "ok"],
      ["bot-1", account.id, "rejected"],
    ]);
    expect(rows[0]?.traceId).toMatch(/^[0-9a-f]{16}$/);
    expect(rows[0]?.traceId).not.toBe(rows[1]?.traceId);
    expect(rows[0]?.actionType).toBe("batchNewOrder");
    expect(JSON.stringify(rows)).not.toContain("cd".repeat(65));
  });
});
