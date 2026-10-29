import type { SignedWriteClient, SodexRestClient } from "@drift/sodex";
import type { OrderIntent } from "@drift/strategies";
import { describe, expect, it } from "vitest";

import type { AccountRef } from "../src/gateway";
import { HttpGateway } from "../src/http-gateway";

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

function gateway() {
  const bodies: string[] = [];
  const rest = {
    getSpotSymbols: () => Promise.resolve([symbol]),
    getPerpsSymbols: () => Promise.resolve([]),
  } as unknown as SodexRestClient;
  const writer = {
    write: (req: { body: string }) => {
      bodies.push(req.body);
      return Promise.resolve({ outcome: "ok", data: [{ code: 0, clOrdID: "c1", orderID: 1 }] });
    },
  } as unknown as SignedWriteClient;
  const signer = { sign: () => Promise.resolve(`0x01${"ab".repeat(65)}` as `0x${string}`) };
  return { gw: new HttpGateway(rest, writer, signer, BUILDER), bodies };
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

    const own = gateway();
    await own.gw.submit(account(BUILDER), [order], { shard: 0, epoch: 1 });
    expect(own.bodies[0]).not.toContain('"builder"');
    expect(await own.gw.builderApproved(account(BUILDER))).toBe(true);
  });
});
