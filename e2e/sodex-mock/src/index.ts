import { exchangeDomain, exchangeTypes, universalDomain, universalTypes } from "@drift/sodex";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  getAddress,
  isAddressEqual,
  keccak256,
  recoverTypedDataAddress,
  stringToBytes,
  type Address,
} from "viem";
import { z } from "zod";

// SoDEX mock server CHỈ cho test và E2E (CODING_STANDARDS C14). Mô phỏng các endpoint DRIFT dùng
// ở P3 theo public API (tra ngày 2026-10-27), và kiểm tra chữ ký EIP-712 thật để bắt lỗi ký.

export interface MockKey {
  name: string;
  type: string;
  publicKey: string;
  expiresAt: number;
  permissions?: number;
}

export interface MockHistory {
  spotTrades: Record<string, unknown>[];
  perpsTrades: Record<string, unknown>[];
  positions: Record<string, unknown>[];
  fundings: Record<string, unknown>[];
  accountValue: string;
  /** `am` / `ami` của Perps (mặc định = accountValue). */
  availableMargin?: string;
  availableIsolated?: string;
  /** Thiết lập đòn bẩy theo symbol (`S`); `updateLeverage` ghi vào đây. */
  symbolSettings?: { s: string; l: number; m: "CROSS" | "ISOLATED" }[];
  spotBalances: { coin: string; total: string; locked: string }[];
  openPositions?: {
    i: number;
    s: string;
    m: string;
    sz: string;
    iw: string | null;
    ep: string;
    ur: string;
    l: number;
    lp: string;
  }[];
}

export interface MockOrder {
  symbol: string;
  orderID: number;
  clOrdID: string;
  side: "BUY" | "SELL";
  status: "NEW" | "FILLED" | "CANCELED";
  origQty: string;
  executedQty: string;
  executedValue: string;
  createdAt: number;
  updatedAt: number;
}

interface MockUser {
  accountID: number;
  keys: { spot: MockKey[]; perps: MockKey[] };
  builders: Map<number, number>;
  nonces: Set<string>;
  history: MockHistory;
  orders: Map<string, MockOrder>;
}

export interface SodexMock {
  app: FastifyInstance;
  addUser(address: string, accountID: number): void;
  /** Đặt approval builder trực tiếp (test). */
  setBuilder(address: string, builderID: number, rate: number): void;
  /** Lệnh đã nhận (P7): để test xem / cho khớp. */
  orders(address: string): MockOrder[];
  /** Cho một lệnh đang mở khớp hết. */
  fill(address: string, clOrdID: string, price: string): void;
  /** Dữ liệu lịch sử cho các endpoint chỉ đọc (P4). */
  setHistory(address: string, history: Partial<MockHistory>): void;
  /** Request ghi tiếp theo: `timeout` = treo quá lâu (client coi là unknown) nhưng VẪN áp dụng; `reject` = từ chối. */
  failNextWrite(mode: "timeout-after-apply" | "reject", error?: string): void;
  /** `fetch` gọi thẳng vào mock qua inject, cho test không cần mở cổng. */
  fetch: (input: string, init: RequestInit) => Promise<Response>;
}

const uint = z.coerce.number().int().nonnegative();
const addKeyBody = z.object({
  accountID: uint,
  name: z.string().regex(/^[0-9a-zA-Z_-]{1,36}$/),
  type: z.literal(1),
  publicKey: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  expiresAt: uint,
  permissions: uint.optional(),
  builder: z.object({ id: uint, fee: uint }).optional(),
});
const approveBody = z.object({
  accountID: uint,
  builderID: uint,
  maxFeeRate: z.number().int().min(0).max(2000),
});

export function buildSodexMock(
  options: { builderIds?: number[]; https?: { cert: Buffer; key: Buffer } } = {},
): SodexMock {
  const users = new Map<string, MockUser>();
  const knownBuilders = new Set(options.builderIds ?? []);
  let failNext: { mode: "timeout-after-apply" | "reject"; error: string } | null = null;
  const app = (options.https === undefined
    ? Fastify({ logger: false })
    : Fastify({ logger: false, https: options.https })) as unknown as FastifyInstance;

  const ok = (reply: FastifyReply, data: unknown) =>
    reply.send({ code: 0, timestamp: Date.now(), data });
  const fail = (reply: FastifyReply, status: number, error: string) =>
    reply.status(status).send({ code: -1, error, timestamp: Date.now() });
  const user = (address: string) => users.get(address.toLowerCase());

  async function verify(
    headers: Record<string, unknown>,
    primaryType: "UserSignedAddPermissionedAPIKeyAction" | "ApproveBuilderFeeAction",
    message: Record<string, unknown>,
    expected: Address,
  ): Promise<string | null> {
    const sign = headers["x-api-sign"];
    const chain = headers["x-api-chain"];
    if (typeof sign !== "string" || !/^0x02[0-9a-f]{128}0[01]$/i.test(sign))
      return "invalid signature";
    if (typeof chain !== "string") return "missing X-API-Chain";
    const signer = await recoverTypedDataAddress({
      domain: universalDomain(BigInt(chain)),
      types: { [primaryType]: universalTypes[primaryType] },
      primaryType,
      message,
      signature: `0x${sign.slice(4)}`,
    });
    return isAddressEqual(signer, expected) ? null : "signature mismatch";
  }

  app.get("/api/v1/user/:addr/subaccounts", (request, reply) => {
    const { addr } = request.params as { addr: string };
    const u = user(addr);
    if (u === undefined) return fail(reply, 400, "user not found");
    return ok(reply, {
      userID: u.accountID,
      primaryAccountID: u.accountID,
      subaccounts: [{ id: u.accountID, evmAddress: getAddress(addr) }],
    });
  });

  app.get("/api/v1/user/:addr/api-keys", (request, reply) => {
    const { addr } = request.params as { addr: string };
    const u = user(addr);
    if (u === undefined) return fail(reply, 400, "user not found");
    return ok(reply, { spot: u.keys.spot, perps: u.keys.perps });
  });

  app.get("/api/v1/user/:addr/builders", (request, reply) => {
    const { addr } = request.params as { addr: string };
    const u = user(addr);
    if (u === undefined) return fail(reply, 400, "user not found");
    const list = [...u.builders].map(([builderID, feeRate]) => ({ builderID, feeRate }));
    return ok(reply, { spot: list, perps: list });
  });

  app.post("/api/v1/user/:addr/api-keys", async (request, reply) => {
    const { addr } = request.params as { addr: string };
    const u = user(addr);
    if (u === undefined) return fail(reply, 400, "user not found");
    const body = addKeyBody.safeParse(request.body);
    if (!body.success) return fail(reply, 400, "invalid body");
    const b = body.data;
    if (b.builder !== undefined && b.permissions !== undefined)
      return fail(reply, 400, "builder and permissions cannot be used together");
    if (b.permissions !== undefined && (b.permissions & 3) === 0)
      return fail(reply, 400, "cannot enable both TRADE and CANCEL");
    if (b.accountID !== u.accountID) return fail(reply, 400, "invalid accountID");
    const nonce = String(request.headers["x-api-nonce"]);
    const error = await verify(
      request.headers,
      "UserSignedAddPermissionedAPIKeyAction",
      {
        chainID: 286623n,
        nonce: BigInt(nonce),
        accountID: BigInt(b.accountID),
        name: b.name,
        keyType: b.type,
        publicKey: b.publicKey,
        expiresAt: BigInt(b.expiresAt),
        permissions: BigInt(b.permissions ?? 0),
      },
      getAddress(addr),
    );
    if (error !== null) return fail(reply, 401, error);
    return write(reply, u, nonce, () => {
      if (u.keys.spot.length >= 5 || u.keys.perps.length >= 5) return "too many api keys";
      const key: MockKey = {
        name: b.name,
        type: "EVM",
        publicKey: b.publicKey,
        expiresAt: b.expiresAt,
        ...(b.permissions === undefined ? {} : { permissions: b.permissions }),
      };
      for (const engine of ["spot", "perps"] as const) {
        u.keys[engine] = [...u.keys[engine].filter((k) => k.name !== b.name), key];
      }
      return null;
    });
  });

  app.post("/api/v1/user/:addr/builders", async (request, reply) => {
    const { addr } = request.params as { addr: string };
    const u = user(addr);
    if (u === undefined) return fail(reply, 400, "user not found");
    const body = approveBody.safeParse(request.body);
    if (!body.success) return fail(reply, 400, "invalid body");
    const b = body.data;
    const nonce = String(request.headers["x-api-nonce"]);
    const error = await verify(
      request.headers,
      "ApproveBuilderFeeAction",
      {
        chainID: 286623n,
        nonce: BigInt(nonce),
        accountID: BigInt(b.accountID),
        builderID: BigInt(b.builderID),
        maxFeeRate: BigInt(b.maxFeeRate),
      },
      getAddress(addr),
    );
    if (error !== null) return fail(reply, 401, error);
    return write(reply, u, nonce, () => {
      if (b.maxFeeRate === 0) {
        u.builders.delete(b.builderID);
        return null;
      }
      if (!knownBuilders.has(b.builderID)) return "builder account not found";
      if (!u.builders.has(b.builderID) && u.builders.size >= 10)
        return "too many builder approvals";
      u.builders.set(b.builderID, b.maxFeeRate);
      return null;
    });
  });

  // Xoá key: master wallet ký ExchangeAction trên domain của engine (spot / futures), prefix 0x01.
  for (const engine of ["spot", "perps"] as const) {
    app.delete(`/api/v1/${engine}/accounts/api-keys`, async (request, reply) => {
      const body = z.object({ accountID: uint, name: z.string() }).safeParse(request.body);
      if (!body.success) return fail(reply, 400, "invalid body");
      const entry = [...users.entries()].find(([, v]) => v.accountID === body.data.accountID);
      if (entry === undefined) return fail(reply, 400, "user not found");
      const [address, u] = entry;
      if (request.headers["x-api-key"] !== undefined)
        return fail(reply, 401, "master wallet required");
      const sign = request.headers["x-api-sign"];
      const nonce = String(request.headers["x-api-nonce"]);
      if (typeof sign !== "string" || !/^0x01[0-9a-f]{128}0[01]$/i.test(sign)) {
        return fail(reply, 401, "invalid signature");
      }
      const payload = `{"type":"revokeAPIKey","params":{"accountID":${String(body.data.accountID)},"name":${JSON.stringify(body.data.name)}}}`;
      const signer = await recoverTypedDataAddress({
        domain: exchangeDomain(engine === "spot" ? "spot" : "futures"),
        types: exchangeTypes,
        primaryType: "ExchangeAction",
        message: { payloadHash: keccak256(stringToBytes(payload)), nonce: BigInt(nonce) },
        signature: `0x${sign.slice(4)}`,
      });
      if (!isAddressEqual(signer, getAddress(address)))
        return fail(reply, 401, "signature mismatch");
      return write(reply, u, `${engine}:${nonce}`, () => {
        if (!u.keys[engine].some((k) => k.name === body.data.name)) return "api key not found";
        u.keys[engine] = u.keys[engine].filter((k) => k.name !== body.data.name);
        return null;
      });
    });
  }

  // Lịch sử (chỉ đọc): mới nhất trước, lọc theo endTime/startTime, cắt theo limit như API thật.
  const page = (items: Record<string, unknown>[], timeKey: string, query: unknown, max: number) => {
    const q = z
      .object({
        endTime: z.coerce.number().optional(),
        startTime: z.coerce.number().optional(),
        limit: z.coerce.number().optional(),
      })
      .parse(query);
    const at = (item: Record<string, unknown>) => Number(item[timeKey]);
    return items
      .filter(
        (i) =>
          (q.endTime === undefined || at(i) <= q.endTime) &&
          (q.startTime === undefined || at(i) >= q.startTime),
      )
      .sort((a, b) => at(b) - at(a))
      .slice(0, Math.min(q.limit ?? max, max));
  };
  const historyRoute = (
    path: string,
    pick: (h: MockHistory) => Record<string, unknown>[],
    timeKey: string,
    max: number,
  ) => {
    app.get(path, (request, reply) => {
      const { addr } = request.params as { addr: string };
      const u = user(addr);
      if (u === undefined) return fail(reply, 400, "user not found");
      return ok(reply, page(pick(u.history), timeKey, request.query, max));
    });
  };
  historyRoute("/api/v1/spot/accounts/:addr/trades", (h) => h.spotTrades, "time", 1000);
  historyRoute("/api/v1/perps/accounts/:addr/trades", (h) => h.perpsTrades, "time", 1000);
  historyRoute(
    "/api/v1/perps/accounts/:addr/positions/history",
    (h) => h.positions,
    "updatedAt",
    500,
  );
  historyRoute("/api/v1/perps/accounts/:addr/fundings", (h) => h.fundings, "timestamp", 1000);
  app.get("/api/v1/perps/accounts/:addr/state", (request, reply) => {
    const { addr } = request.params as { addr: string };
    const u = user(addr);
    if (u === undefined) return fail(reply, 400, "user not found");
    return ok(reply, {
      av: u.history.accountValue,
      am: u.history.availableMargin ?? u.history.accountValue,
      ami: u.history.availableIsolated ?? u.history.accountValue,
      im: "0",
      cm: "0",
      B: [{ a: "vUSDC", wb: u.history.accountValue, px: "1", mr: "1", wm: u.history.accountValue }],
      P: u.history.openPositions ?? [],
      S: u.history.symbolSettings ?? [],
    });
  });

  // ---------- Market info + lệnh (P7) ----------
  const symbol = (id: number, name: string) => ({
    id,
    name,
    pricePrecision: 2,
    tickSize: "0.01",
    minPrice: "0.01",
    maxPrice: "10000000",
    quantityPrecision: 4,
    stepSize: "0.0001",
    minQuantity: "0.0001",
    maxQuantity: "100000",
    marketMinQuantity: "0.0001",
    marketMaxQuantity: "100000",
    minNotional: "5",
    maxNotional: "100000000",
    status: "TRADING",
  });
  app.get("/api/v1/perps/markets/mark-prices", (_request, reply) =>
    ok(reply, [
      {
        symbol: "BTC-USD",
        openInterest: "1",
        markPrice: "100",
        indexPrice: "100",
        fundingRate: "0.0001",
        nextFundingTime: Date.now() + 3_600_000,
      },
    ]),
  );
  app.get("/api/v1/spot/markets/symbols", (_request, reply) =>
    ok(reply, [{ ...symbol(1, "vBTC_vUSDC"), baseCoin: "vBTC", quoteCoin: "vUSDC" }]),
  );
  app.get("/api/v1/perps/markets/symbols", (_request, reply) =>
    ok(reply, [{ ...symbol(1, "BTC-USD"), maxLeverage: 20, fundingInterval: 28800 }]),
  );
  app.get("/api/v1/spot/accounts/:addr/balances", (request, reply) => {
    const u = user((request.params as { addr: string }).addr);
    if (u === undefined) return fail(reply, 400, "user not found");
    return ok(reply, { balances: u.history.spotBalances });
  });

  // Nến (P8 engine đề xuất, P9 backtest): giá tất định quanh 100, dao động hình sin chu kỳ 2 ngày.
  const STEP_MS: Record<string, number> = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "1d": 86_400_000,
  };
  const priceAt = (t: number) =>
    (100 * (1 + 0.05 * Math.sin((2 * Math.PI * t) / (2 * 86_400_000)))).toFixed(2);
  for (const engine of ["spot", "perps"] as const) {
    app.get(`/api/v1/${engine}/markets/:symbol/klines`, (request, reply) => {
      const q = request.query as {
        interval?: string;
        limit?: string;
        startTime?: string;
        endTime?: string;
      };
      const step = STEP_MS[q.interval ?? "1d"] ?? 86_400_000;
      const limit = Math.min(Number(q.limit ?? "500"), 1500);
      const now = Date.now() - (Date.now() % step);
      const end = q.endTime === undefined ? now : Math.min(Number(q.endTime), now);
      const start =
        q.startTime === undefined
          ? end - (limit - 1) * step
          : Math.ceil(Number(q.startTime) / step) * step;
      const out = [];
      for (let t = start; t <= end && out.length < limit; t += step) {
        const o = priceAt(t);
        const c = priceAt(t + step);
        const hi = (Math.max(Number(o), Number(c)) + 0.2).toFixed(2);
        const lo = (Math.min(Number(o), Number(c)) - 0.2).toFixed(2);
        out.push({ t, o, h: hi, l: lo, c, v: "1", q: c, n: 1 });
      }
      return ok(reply, out.reverse());
    });
  }

  const symbolName = (engine: "spot" | "perps", id: number) =>
    (engine === "spot" ? ["", "vBTC_vUSDC"][id] : ["", "BTC-USD"][id]) ?? "";
  // Body được giữ nguyên chuỗi để tính lại payload hash đúng từng byte.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    try {
      (req as unknown as { rawBody: string }).rawBody = String(body);
      done(null, JSON.parse(String(body)));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  async function verifyKey(
    request: FastifyRequest,
    engine: "spot" | "perps",
    type: string,
  ): Promise<{ u: MockUser | undefined; error: string | null }> {
    const raw = (request as unknown as { rawBody: string }).rawBody;
    const body = JSON.parse(raw) as { accountID: number };
    const entry = [...users.values()].find((v) => v.accountID === body.accountID);
    if (entry === undefined) return { u: undefined, error: "user not found" };
    const keyName = request.headers["x-api-key"];
    const key = entry.keys[engine].find((k) => k.name === keyName);
    const sign = request.headers["x-api-sign"];
    if (key === undefined) return { u: entry, error: "api key not found" };
    if (typeof sign !== "string" || !/^0x01[0-9a-f]{128}0[01]$/i.test(sign))
      return { u: entry, error: "invalid signature" };
    const signer = await recoverTypedDataAddress({
      domain: exchangeDomain(engine === "spot" ? "spot" : "futures"),
      types: exchangeTypes,
      primaryType: "ExchangeAction",
      message: {
        payloadHash: keccak256(stringToBytes(`{"type":"${type}","params":${raw}}`)),
        nonce: BigInt(String(request.headers["x-api-nonce"])),
      },
      signature: `0x${sign.slice(4)}`,
    });
    return {
      u: entry,
      error: isAddressEqual(signer, getAddress(key.publicKey)) ? null : "signature mismatch",
    };
  }

  // Đặt đòn bẩy (Go SDK `UpdateLeverageRequest`): thành công không có payload.
  app.post("/api/v1/perps/trade/leverage", async (request, reply) => {
    const { u, error } = await verifyKey(request, "perps", "updateLeverage");
    if (u === undefined || error !== null) return fail(reply, 401, error ?? "user not found");
    const body = request.body as { symbolID: number; leverage: number; marginMode: number };
    const name = symbolName("perps", body.symbolID);
    u.history.symbolSettings = [
      ...(u.history.symbolSettings ?? []).filter((x) => x.s !== name),
      { s: name, l: body.leverage, m: body.marginMode === 1 ? "ISOLATED" : "CROSS" },
    ];
    return reply.send({ code: 0, timestamp: Date.now() });
  });

  let nextOrderId = 1000;
  for (const engine of ["spot", "perps"] as const) {
    const path =
      engine === "spot" ? "/api/v1/spot/trade/orders/batch" : "/api/v1/perps/trade/orders";
    app.post(path, async (request, reply) => {
      const { u, error } = await verifyKey(
        request,
        engine,
        engine === "spot" ? "batchNewOrder" : "newOrder",
      );
      if (u === undefined || error !== null) return fail(reply, 401, error ?? "user not found");
      const injected = failNext;
      failNext = null;
      if (injected?.mode === "reject") return fail(reply, 400, injected.error);
      const body = request.body as {
        symbolID?: number;
        orders: { symbolID?: number; clOrdID: string; side: number; quantity?: string }[];
      };
      const results = body.orders.map((o) => {
        const order: MockOrder = {
          symbol: symbolName(engine, o.symbolID ?? body.symbolID ?? 0),
          orderID: nextOrderId++,
          clOrdID: o.clOrdID,
          side: o.side === 1 ? "BUY" : "SELL",
          status: "NEW",
          origQty: o.quantity ?? "0",
          executedQty: "0",
          executedValue: "0",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        u.orders.set(o.clOrdID, order);
        return { code: 0, clOrdID: o.clOrdID, orderID: order.orderID };
      });
      if (injected?.mode === "timeout-after-apply")
        return reply.status(504).send("gateway timeout");
      return ok(reply, results);
    });
    app.delete(path, async (request, reply) => {
      const { u, error } = await verifyKey(
        request,
        engine,
        engine === "spot" ? "batchCancelOrder" : "cancelOrder",
      );
      if (u === undefined || error !== null) return fail(reply, 401, error ?? "user not found");
      const body = request.body as { cancels: { clOrdID: string; origClOrdID?: string }[] };
      return ok(
        reply,
        body.cancels.map((c) => {
          const o = u.orders.get(c.origClOrdID ?? c.clOrdID);
          if (o?.status === "NEW") o.status = "CANCELED";
          return { code: 0, clOrdID: c.clOrdID };
        }),
      );
    });
    app.get(`/api/v1/${engine}/accounts/:addr/orders`, (request, reply) => {
      const u = user((request.params as { addr: string }).addr);
      if (u === undefined) return fail(reply, 400, "user not found");
      return ok(reply, { orders: [...u.orders.values()].filter((o) => o.status === "NEW") });
    });
    app.get(`/api/v1/${engine}/accounts/:addr/orders/history`, (request, reply) => {
      const u = user((request.params as { addr: string }).addr);
      if (u === undefined) return fail(reply, 400, "user not found");
      return ok(
        reply,
        [...u.orders.values()].filter((o) => o.status !== "NEW"),
      );
    });
  }

  async function write(
    reply: FastifyReply,
    u: MockUser,
    nonce: string,
    apply: () => string | null,
  ) {
    if (u.nonces.has(nonce)) return fail(reply, 400, "nonce already used");
    const injected = failNext;
    failNext = null;
    if (injected?.mode === "reject") return fail(reply, 400, injected.error);
    u.nonces.add(nonce);
    const error = apply();
    if (error !== null) return fail(reply, 400, error);
    if (injected?.mode === "timeout-after-apply") return reply.status(504).send("gateway timeout");
    return ok(reply, null);
  }

  return {
    app,
    addUser(address, accountID) {
      users.set(address.toLowerCase(), {
        accountID,
        keys: { spot: [], perps: [] },
        history: {
          spotTrades: [],
          perpsTrades: [],
          positions: [],
          fundings: [],
          accountValue: "100000",
          spotBalances: [{ coin: "vUSDC", total: "100000", locked: "0" }],
        },
        orders: new Map(),
        builders: new Map(),
        nonces: new Set(),
      });
    },
    setBuilder(address, builderID, rate) {
      const u = users.get(address.toLowerCase());
      if (u === undefined) return;
      if (rate === 0) u.builders.delete(builderID);
      else u.builders.set(builderID, rate);
    },
    orders(address) {
      return [...(users.get(address.toLowerCase())?.orders.values() ?? [])];
    },
    fill(address, clOrdID, price) {
      const o = users.get(address.toLowerCase())?.orders.get(clOrdID);
      if (o === undefined) return;
      o.status = "FILLED";
      o.executedQty = o.origQty;
      o.executedValue = String(Number(o.origQty) * Number(price));
      o.updatedAt = Date.now();
    },
    setHistory(address, history) {
      const u = users.get(address.toLowerCase());
      if (u !== undefined) u.history = { ...u.history, ...history };
    },
    failNextWrite(mode, error = "rejected by mock") {
      failNext = { mode, error };
    },
    fetch: async (input, init) => {
      const url = new URL(input);
      const res = await app.inject({
        method: (init.method ?? "GET") as "GET",
        url: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        ...(typeof init.body === "string" ? { payload: init.body } : {}),
      });
      return new Response(res.body, {
        status: res.statusCode,
        headers: { "content-type": "application/json" },
      });
    },
  };
}
