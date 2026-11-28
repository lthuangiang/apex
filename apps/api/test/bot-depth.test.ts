import { botListSchema, errorResponseSchema, featuresSchema, meSchema } from "@drift/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEPTH_CHECK_CACHE_MS } from "../src/modules/bots/depth";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Giới hạn theo sổ lệnh lúc tạo / sửa bot (DEC-402 mục 5, #590). SoDEX là mock: mặc định mọi market có sổ sâu.

let env: TestEnv;
const errorOf = (body: string) => errorResponseSchema.parse(JSON.parse(body)).error;
const ADDRESS = "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db";
/** Futures Grid trên ANT-USD (trong `DEPTH_CAP_MARKETS` mặc định): tổng vị thế tối đa = margin × leverage = 500 USD. */
const grid = {
  market: "ANT-USD",
  leverage: 2,
  marginMode: "cross",
  direction: "long",
  lowerPrice: "90",
  upperPrice: "110",
  gridLevels: 4,
  spacing: "arithmetic",
  margin: "250",
  stopBelow: "80",
  stopAbove: "120",
  maxLoss: "20",
  onStop: "close_at_market",
};
/** Sổ 10 mức với notional mỗi phía cho trước (một mức, giá 100). */
const book = (bidUsd: number, askUsd: number) => ({
  bids: bidUsd === 0 ? [] : [["100", String(bidUsd / 100)] as [string, string]],
  asks: askUsd === 0 ? [] : [["100", String(askUsd / 100)] as [string, string]],
});
/** Qua hạn cache sổ của api (30 s) để lần kiểm sau đọc sổ mới. */
const expireBookCache = () => {
  env.clock.now = new Date(env.clock.now.getTime() + DEPTH_CHECK_CACHE_MS + 1_000);
};

beforeAll(async () => {
  env = await startTestEnv();
  env.sodex.addPerpSymbol("ANT-USD", { maxLeverage: 5 });
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => {
  expireBookCache();
  env.sodex.setOrderbook("perps", "ANT-USD", book(1_000_000, 1_000_000));
});

async function connectedUser(email: string) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  const accountID = Math.floor(Math.random() * 1e9);
  env.sodex.addUser(ADDRESS, accountID);
  const { rows } = await env.pool.query<{ id: string }>(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
    [me.id, ADDRESS, accountID],
  );
  await env.pool.query(
    "insert into api_keys (id, sodex_account_id, name, public_key, ciphertext, kms_key_ref, last4, permissions_mask, expires_at, status) values (gen_random_uuid(), $1, 'DRIFT', $2, 'x', 'x', '5508', 14, now() + interval '100 days', 'active')",
    [rows[0]?.id, ADDRESS],
  );
  return client;
}

const createGrid = (client: TestClient, config: Record<string, unknown> = grid) =>
  client.request("POST", "/api/v1/bots", {
    body: { strategy: "futures_grid", name: "Grid", paramSource: "manual", config },
  });

describe("max position against the order book at create (#590)", () => {
  it("refuses a bot larger than the thinner side of a thin market", async () => {
    const client = await connectedUser("depth-create@example.com");
    // Thin: bid 300 USD, ask 9000 USD. 250 × 2 = 500 > 300.
    env.sodex.setOrderbook("perps", "ANT-USD", book(300, 9000));
    const res = await createGrid(client);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.body)).toMatchObject({
      code: "VALIDATION_FAILED",
      message:
        "Too large for ANT-USD's order book: max position is 300 USD here (the thinner side of the top 10 levels).",
      details: { reason: "order_book_depth", market: "ANT-USD", maxPosition: "300" },
    });
    // At or under the thinner side: created.
    expect((await createGrid(client, { ...grid, margin: "150" })).statusCode).toBe(201);
  });

  it("refuses a bot when one side of the book is empty", async () => {
    const client = await connectedUser("depth-empty@example.com");
    env.sodex.setOrderbook("perps", "ANT-USD", book(5000, 0));
    const res = await createGrid(client);
    expect(errorOf(res.body)).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "ANT-USD has no orders on one side of the order book. Try again when it trades.",
      details: { reason: "order_book_depth" },
    });
  });

  it("refuses when the book can't be read (never guesses the depth)", async () => {
    const client = await connectedUser("depth-fail@example.com");
    env.sodex.setOrderbook("perps", "ANT-USD", "fail");
    const res = await createGrid(client);
    expect(errorOf(res.body).code).toBe("SODEX_UNAVAILABLE");
  });

  it("does not check a deep market", async () => {
    const client = await connectedUser("depth-deep@example.com");
    // Both sides ≥ 10,000 USD: not Thin, even though the bot is larger than one side.
    env.sodex.setOrderbook("perps", "ANT-USD", book(10_000, 12_000));
    expect((await createGrid(client, { ...grid, margin: "10000" })).statusCode).toBe(201);
  });
});

describe("max position against the order book on edit (#590)", () => {
  async function runningGrid(email: string) {
    const client = await connectedUser(email);
    expect((await createGrid(client)).statusCode).toBe(201);
    const id =
      botListSchema.parse((await client.request("GET", "/api/v1/bots")).json()).items[0]?.id ?? "";
    await env.pool.query("update bots set state = 'running' where id = $1", [id]);
    // The market turns thin after the bot was created: bid 300 USD.
    expireBookCache();
    env.sodex.setOrderbook("perps", "ANT-USD", book(300, 9000));
    return { client, id };
  }
  const edit = (client: TestClient, id: string, config: Record<string, unknown>) =>
    client.request("POST", `/api/v1/bots/${id}/versions`, {
      body: { paramSource: "manual", config },
    });

  it("never blocks an edit that does not raise the max position", async () => {
    const { client, id } = await runningGrid("depth-edit-same@example.com");
    expect((await edit(client, id, { ...grid, gridLevels: 7 })).statusCode).toBe(202);
    // Lower than before, still above the thinner side: allowed (not a raise).
    expect((await edit(client, id, { ...grid, margin: "200", gridLevels: 7 })).statusCode).toBe(
      202,
    );
  });

  it("refuses an edit that raises the max position past the thinner side", async () => {
    const { client, id } = await runningGrid("depth-edit-up@example.com");
    const res = await edit(client, id, { ...grid, margin: "300" });
    expect(errorOf(res.body)).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { reason: "order_book_depth", maxPosition: "300" },
    });
  });

  it("never checks a paper bot", async () => {
    const { client, id } = await runningGrid("depth-edit-paper@example.com");
    await env.pool.query("update bots set mode = 'paper' where id = $1", [id]);
    expect((await edit(client, id, { ...grid, margin: "300" })).statusCode).toBe(202);
  });
});

describe("only markets in DEPTH_CAP_MARKETS (#590)", () => {
  it("never reads the book for a market outside the list", async () => {
    const client = await connectedUser("depth-outside@example.com");
    // A read would fail (SODEX_UNAVAILABLE) or refuse (empty): neither happens, the book is never read.
    env.sodex.setOrderbook("perps", "BTC-USD", "fail");
    const res = await createGrid(client, { ...grid, market: "BTC-USD", margin: "10000" });
    expect(res.statusCode).toBe(201);
    env.sodex.setOrderbook("perps", "BTC-USD", book(1_000_000, 1_000_000));
  });

  it("tells the web which markets are capped", async () => {
    const client = await connectedUser("depth-features@example.com");
    const f = featuresSchema.parse((await client.request("GET", "/api/v1/features")).json());
    expect(f.depthCapMarkets).toEqual([
      "ANT-USD",
      "vANT_vUSDC",
      "vVOO_vUSDC",
      "vQQQ_vUSDC",
      "vSCHD_vUSDC",
      "vSMH_vUSDC",
      "vVGT_vUSDC",
      "vVYM_vUSDC",
      "vBOXX_vUSDC",
      "vSTRC_vUSDC",
    ]);
  });
});
