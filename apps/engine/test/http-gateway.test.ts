import {
  MemoryRateLimitStore,
  SignedWriteClient,
  type FetchLike,
  type SodexRestClient,
} from "@drift/sodex";
import type { OrderIntent } from "@drift/strategies";
import { describe, expect, it } from "vitest";

import type { AccountRef } from "../src/gateway";
import {
  cancelItemResult,
  HttpGateway,
  PaperRefusedError,
  rejectMessage,
} from "../src/http-gateway";

// Builder fee trên lệnh (DEC-46 / DEC-47): người dùng trả 10 (0.01%); account của chính builder không gắn builder.

const BUILDER = 1645n;
const symbol = {
  id: 1n,
  name: "vBTC_vUSDC",
  tickSize: "0.01",
  stepSize: "0.0001",
  minQuantity: "0.0001",
  minNotional: "5",
  status: "TRADING",
};

function gateway(
  response: unknown = { outcome: "ok", data: [{ code: 0, clOrdID: "c1", orderID: 1 }] },
  builderExempt = true,
) {
  const bodies: string[] = [];
  const rest = {
    getSpotSymbols: () => Promise.resolve([symbol]),
    getPerpsSymbols: () => Promise.resolve([]),
  } as unknown as SodexRestClient;
  const writer = {
    write: (req: { body: string }) => {
      bodies.push(req.body);
      return Promise.resolve(response);
    },
  } as unknown as SignedWriteClient;
  const signer = { sign: () => Promise.resolve(`0x01${"ab".repeat(65)}` as `0x${string}`) };
  return { gw: new HttpGateway(rest, writer, signer, BUILDER, builderExempt), bodies };
}

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
const account = (id: bigint): AccountRef => ({
  id: "a",
  address: "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db",
  sodexAccountId: id,
  apiKeyId: "k",
  apiKeyName: "DRIFT",
});

describe("builder fee on orders", () => {
  it("charges users DRIFT's 0.01% and leaves the builder's own account uncharged", async () => {
    const user = gateway();
    await user.gw.submit(account(7n), [order], { shard: 0, epoch: 1 });
    expect(user.bodies[0]).toContain('"builder":{"id":1645,"fee":10}');

    const farm = gateway();
    await farm.gw.submit(account(7n), [order], { shard: 0, epoch: 1 }, 5);
    expect(farm.bodies[0]).toContain('"builder":{"id":1645,"fee":5}');
    // Không bao giờ vượt mức người dùng đã approve.
    const capped = gateway();
    await capped.gw.submit(account(7n), [order], { shard: 0, epoch: 1 }, 50);
    expect(capped.bodies[0]).toContain('"builder":{"id":1645,"fee":10}');

    const own = gateway();
    await own.gw.submit(account(BUILDER), [order], { shard: 0, epoch: 1 });
    expect(own.bodies[0]).not.toContain('"builder"');
    expect(await own.gw.builderApproved(account(BUILDER))).toBe(true);
  });

  it("charges the builder's own account too when the exemption is off (DEC-124)", async () => {
    const own = gateway(undefined, false);
    await own.gw.submit(account(BUILDER), [order], { shard: 0, epoch: 1 }, 5);
    expect(own.bodies[0]).toContain('"builder":{"id":1645,"fee":5}');
  });
});

describe("SoDEX reject message", () => {
  it("keeps SoDEX's error text for a rejected request and for a rejected order in a batch", async () => {
    const whole = gateway({
      outcome: "rejected",
      status: 400,
      sodexCode: -1,
      sodexError: "bad order",
    });
    expect(await whole.gw.submit(account(7n), [order], { shard: 0, epoch: 1 })).toEqual([
      { clOrdID: "c1", outcome: "rejected", code: "-1", message: "bad order" },
    ]);
    const item = gateway({
      outcome: "ok",
      data: [{ code: -1, clOrdID: "c1", error: "  no\n position " }],
    });
    expect(await item.gw.submit(account(7n), [order], { shard: 0, epoch: 1 })).toEqual([
      { clOrdID: "c1", outcome: "rejected", code: "-1", message: "no position" },
    ]);
  });

  it("returns null for an empty message and caps long ones at 300 characters", () => {
    expect(rejectMessage(undefined)).toBeNull();
    expect(rejectMessage("  ")).toBeNull();
    expect(rejectMessage("x".repeat(400))).toHaveLength(300);
  });
});

describe("paper bots (DEC-105)", () => {
  it("refuses every call for a paper bot before signing or touching SoDEX", async () => {
    let signed = 0;
    let reads = 0;
    const rest = new Proxy(
      {},
      {
        get: () => () => {
          reads += 1;
          return Promise.resolve([]);
        },
      },
    ) as unknown as SodexRestClient;
    const writer = {
      write: () => Promise.reject(new Error("must not write")),
    } as unknown as SignedWriteClient;
    const signer = {
      sign: () => {
        signed += 1;
        return Promise.resolve(`0x01${"ab".repeat(65)}` as `0x${string}`);
      },
    };
    const gw = new HttpGateway(rest, writer, signer, BUILDER);
    const paper: AccountRef = { ...account(7n), paper: true };
    const fence = { shard: 0, epoch: 1 };
    const ref = { clOrdID: "c1", market: "vBTC_vUSDC", engine: "spot" as const };
    const calls: (() => Promise<unknown>)[] = [
      () => gw.submit(paper, [order], fence),
      () => gw.cancel(paper, [ref], fence),
      () => gw.lookup(paper, ref),
      () => gw.tradesOf(paper, ref),
      () => gw.recentTrades(paper, { market: "vBTC_vUSDC", engine: "spot" }),
      () => gw.readPositions(paper),
      () => gw.setLeverage(paper, { market: "BTC-USD", leverage: 2, marginMode: "cross" }, fence),
      () => gw.readLeverage(paper, "BTC-USD"),
      () => gw.builderApproved(paper),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(PaperRefusedError);
    expect(signed).toBe(0);
    expect(reads).toBe(0);
  });
});

describe("cancel results (DEC-308)", () => {
  it("reads SoDEX's OrderNotFound without a clOrdID as not found, not unknown", async () => {
    const { gw } = gateway({
      outcome: "ok",
      data: [{ code: -1, error: "order rejected: OrderNotFound" }],
    });
    const ref = { clOrdID: "c1", market: "vBTC_vUSDC", engine: "spot" as const };
    expect(await gw.cancel(account(7n), [ref], { shard: 0, epoch: 1 })).toEqual([
      { clOrdID: "c1", outcome: "not_found" },
    ]);
  });

  it("keeps ok, rejected and unreadable results as before", () => {
    expect(cancelItemResult("c1", [{ code: 0, clOrdID: "c1" }])).toEqual({
      clOrdID: "c1",
      outcome: "ok",
    });
    expect(
      cancelItemResult("c1", [{ code: -1, clOrdID: "c1", error: "order rejected: OrderNotFound" }]),
    ).toEqual({ clOrdID: "c1", outcome: "not_found" });
    expect(cancelItemResult("c1", [{ code: -2, clOrdID: "c1", error: "nope" }])).toEqual({
      clOrdID: "c1",
      outcome: "rejected",
      code: "-2",
    });
    // Mã lỗi khác mà không có clOrdID: không biết lệnh nào, vẫn chưa rõ (quy tắc 1.7).
    expect(cancelItemResult("c1", [{ code: -1, error: "busy" }])).toMatchObject({
      clOrdID: "c1",
      outcome: "unknown",
    });
    expect(cancelItemResult("c1", { weird: true })).toMatchObject({ outcome: "unknown" });
  });
});

describe("market info on the order path (DEC-308)", () => {
  it("sends with the last known symbol id while a refresh of the symbol list hangs", async () => {
    let calls = 0;
    const rest = {
      getSpotSymbols: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve([symbol]) : new Promise<never>(() => undefined);
      },
      getPerpsSymbols: () => Promise.resolve([]),
    } as unknown as SodexRestClient;
    const bodies: string[] = [];
    const writer = {
      write: (req: { body: string }) => {
        bodies.push(req.body);
        return Promise.resolve({ outcome: "ok", data: [{ code: 0, clOrdID: "c1", orderID: 1 }] });
      },
    } as unknown as SignedWriteClient;
    const signer = { sign: () => Promise.resolve(`0x01${"ab".repeat(65)}` as `0x${string}`) };
    const gw = new HttpGateway(rest, writer, signer, BUILDER);
    await gw.submit(account(7n), [order], { shard: 0, epoch: 1 });
    // Danh sách symbol hết cache và lần đọc lại treo: lệnh vẫn đi ngay với id đã biết.
    const second = await gw.submit(account(7n), [{ ...order, clOrdID: "c2" }], {
      shard: 0,
      epoch: 1,
    });
    expect(second[0]?.outcome).not.toBe("unknown");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain('"symbolID":1');
    expect(calls).toBe(2);
  });

  it("drops a market a refresh no longer lists, and refuses to send to an unknown market", async () => {
    let listed = true;
    const rest = {
      getSpotSymbols: () => Promise.resolve(listed ? [symbol] : []),
      getPerpsSymbols: () => Promise.resolve([]),
    } as unknown as SodexRestClient;
    const bodies: string[] = [];
    const writer = {
      write: (req: { body: string }) => {
        bodies.push(req.body);
        return Promise.resolve({ outcome: "ok", data: [{ code: 0, clOrdID: "c1", orderID: 1 }] });
      },
    } as unknown as SignedWriteClient;
    const signer = { sign: () => Promise.resolve(`0x01${"ab".repeat(65)}` as `0x${string}`) };
    const gw = new HttpGateway(rest, writer, signer, BUILDER);
    await gw.submit(account(7n), [order], { shard: 0, epoch: 1 });
    // Bỏ niêm yết: lần gửi sau còn dùng id đã biết và làm mới ở nền; lần làm mới không thấy market thì bỏ id cũ.
    listed = false;
    await gw.submit(account(7n), [{ ...order, clOrdID: "c2" }], { shard: 0, epoch: 1 });
    await new Promise((r) => setTimeout(r, 0));
    const third = await gw.submit(account(7n), [{ ...order, clOrdID: "c3" }], {
      shard: 0,
      epoch: 1,
    });
    expect(third).toEqual([
      {
        clOrdID: "c3",
        outcome: "rejected",
        code: "MARKET_NOT_FOUND",
        message: "Market is not listed on SoDEX.",
      },
    ]);
    expect(bodies).toHaveLength(2);
  });

  it("marks a cancel refused as a whole request (SoDEX error envelope) as request scope", async () => {
    const { gw } = gateway({
      outcome: "rejected",
      status: 429,
      sodexCode: -1,
      sodexError: "too many",
    });
    const ref = { clOrdID: "c1", market: "vBTC_vUSDC", engine: "spot" as const };
    expect(await gw.cancel(account(7n), [ref], { shard: 0, epoch: 1 })).toEqual([
      { clOrdID: "c1", outcome: "rejected", code: "-1", scope: "request" },
    ]);
  });

  it("returns not_sent when the symbol list cannot be read before signing (nothing left DeskLabs)", async () => {
    let signed = 0;
    const rest = {
      getSpotSymbols: () => Promise.reject(new Error("SoDEX rate limit reached")),
      getPerpsSymbols: () => Promise.resolve([]),
    } as unknown as SodexRestClient;
    const writer = {
      write: () => Promise.reject(new Error("must not write")),
    } as unknown as SignedWriteClient;
    const signer = {
      sign: () => {
        signed += 1;
        return Promise.resolve(`0x01${"ab".repeat(65)}` as `0x${string}`);
      },
    };
    const gw = new HttpGateway(rest, writer, signer, BUILDER);
    expect(await gw.submit(account(7n), [order], { shard: 0, epoch: 1 })).toEqual([
      { clOrdID: "c1", outcome: "not_sent", code: "market_info_unavailable" },
    ]);
    expect(signed).toBe(0);
  });

  it("reads a cancel-pending order with the write-priority client, other reads with the background one (DEC-317)", async () => {
    const used: string[] = [];
    const client = (name: string) =>
      ({
        getOpenOrders: () => {
          used.push(`${name}:open`);
          return Promise.resolve([]);
        },
        getOrderHistory: () => {
          used.push(`${name}:history`);
          return Promise.resolve([]);
        },
        getTrades: () => {
          used.push(`${name}:trades`);
          return Promise.resolve([]);
        },
      }) as unknown as SodexRestClient;
    const writer = {} as unknown as SignedWriteClient;
    const signer = { sign: () => Promise.resolve(`0x01${"ab".repeat(65)}` as `0x${string}`) };
    const gw = new HttpGateway(
      client("rest"),
      writer,
      signer,
      BUILDER,
      true,
      client("background"),
      client("urgent"),
    );
    const ref = { clOrdID: "c1", market: "vBTC_vUSDC", engine: "spot" as const };
    const q = { market: "vBTC_vUSDC", engine: "spot" as const };
    await gw.lookup(account(7n), ref);
    await gw.recentTrades(account(7n), q);
    expect(used).toEqual(["background:open", "background:history", "background:trades"]);
    used.length = 0;
    await gw.lookup(account(7n), ref, { urgent: true });
    await gw.recentTrades(account(7n), q, { urgent: true });
    await gw.tradesOf(account(7n), ref, { urgent: true });
    expect(used).toEqual(["urgent:open", "urgent:history", "urgent:trades", "urgent:trades"]);
  });
});

describe("updateLeverage without data (#495)", () => {
  /** Gateway với SignedWriteClient thật; HTTP giả trả `body` (không có lệnh nào tới SoDEX thật). */
  function real(body: string, status = 200) {
    const rest = {
      getSpotSymbols: () => Promise.resolve([]),
      getPerpsSymbols: () => Promise.resolve([{ ...symbol, id: 9n, name: "NVDA-USD" }]),
    } as unknown as SodexRestClient;
    const fetchImpl: FetchLike = () => Promise.resolve(new Response(body, { status }));
    const writer = new SignedWriteClient({
      config: { restUrl: "https://mainnet-gw.sodex.dev" },
      rateLimit: new MemoryRateLimitStore(),
      egressKey: "test",
      fetch: fetchImpl,
    });
    const signer = { sign: () => Promise.resolve(`0x01${"ab".repeat(65)}` as `0x${string}`) };
    return new HttpGateway(rest, writer, signer, BUILDER);
  }
  const spec = { market: "NVDA-USD", leverage: 1, marginMode: "isolated" as const };
  const fence = { shard: 0, epoch: 1 };

  it("is ok when SoDEX answers {code:0,timestamp} with no data (prod 2026-11-23)", async () => {
    expect(
      await real('{"code":0,"timestamp":1795400000000}').setLeverage(account(7n), spec, fence),
    ).toEqual({
      outcome: "ok",
    });
  });

  it("still rejects an error envelope and keeps an unreadable body unknown", async () => {
    expect(
      await real('{"code":-1,"error":"invalid leverage","timestamp":1}', 400).setLeverage(
        account(7n),
        spec,
        fence,
      ),
    ).toEqual({ outcome: "rejected", code: "-1" });
    expect(
      await real("<html>bad gateway</html>", 502).setLeverage(account(7n), spec, fence),
    ).toEqual({
      outcome: "unknown",
    });
  });

  it("an order response with an ok envelope but no order results stays unknown (reconcile by clOrdID)", async () => {
    const { gw } = gateway({ outcome: "ok", data: undefined });
    expect(await gw.submit(account(7n), [order], fence)).toEqual([
      { clOrdID: "c1", outcome: "unknown" },
    ]);
  });
});
