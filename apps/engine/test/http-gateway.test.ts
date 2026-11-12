import type { SignedWriteClient, SodexRestClient } from "@drift/sodex";
import type { OrderIntent } from "@drift/strategies";
import { describe, expect, it } from "vitest";

import type { AccountRef } from "../src/gateway";
import { HttpGateway, PaperRefusedError, rejectMessage } from "../src/http-gateway";

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
      () => gw.readPosition(paper, "BTC-USD"),
      () => gw.setLeverage(paper, { market: "BTC-USD", leverage: 2, marginMode: "cross" }, fence),
      () => gw.readLeverage(paper, "BTC-USD"),
      () => gw.builderApproved(paper),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(PaperRefusedError);
    expect(signed).toBe(0);
    expect(reads).toBe(0);
  });
});
