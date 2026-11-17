import type {
  SodexCallDetail,
  SodexCallFacets,
  SodexCallItem,
  SodexCallsPage,
  SodexCallSummary,
} from "@drift/shared";

// Dữ liệu giả cho test của SoDEX Debugger (không bao giờ dùng trong code production).

export const ADDRESS = "0x4E1e8c0B7a2d5F3e91A6b4C0d8E2f7a1B3c529Db";
const BOT = { id: "0195f3a0-0000-7000-8000-000000000031", name: "SOL quotes" };

export const CANCEL: SodexCallItem = {
  id: "0195f3a0-0000-7000-8000-0000000000c9",
  at: "2026-11-17T15:05:12.481Z",
  service: "engine",
  kind: "rest",
  method: "DELETE",
  endpoint: "/perps/trade/orders",
  httpStatus: 200,
  outcome: "unreadable",
  sodexCode: -1,
  sodexSays: "order rejected: OrderNotFound",
  latencyMs: 214,
  bot: BOT,
  accountAddress: ADDRESS,
  clOrdIds: ["drift-b31-v4-cx-88213"],
  connId: null,
};

export const PLACE: SodexCallItem = {
  id: "0195f3a0-0000-7000-8000-0000000000c8",
  at: "2026-11-17T15:05:11.902Z",
  service: "engine",
  kind: "rest",
  method: "POST",
  endpoint: "/perps/trade/orders",
  httpStatus: 200,
  outcome: "ok",
  sodexCode: 0,
  sodexSays: null,
  latencyMs: 131,
  bot: BOT,
  accountAddress: ADDRESS,
  clOrdIds: ["drift-b31-v4-l2-a0"],
  connId: null,
};

export const SLOW: SodexCallItem = {
  id: "0195f3a0-0000-7000-8000-0000000000c5",
  at: "2026-11-17T15:04:10.118Z",
  service: "api",
  kind: "rest",
  method: "GET",
  endpoint: "/perps/accounts/{addr}/balances",
  httpStatus: 200,
  outcome: "ok",
  sodexCode: 0,
  sodexSays: null,
  latencyMs: 1840,
  bot: null,
  accountAddress: ADDRESS,
  clOrdIds: [],
  connId: null,
};

export function page(items: SodexCallItem[], nextCursor: string | null = null): SodexCallsPage {
  return {
    items,
    nextCursor,
    counts: { all: 1001, errors: 612, timeouts: 41, slow: 88 },
    readAt: "2026-11-17T15:42:10Z",
  };
}

const REQ = `{
  "accountID": 20417,
  "cancels": [
    {
      "symbolID": 2,
      "clOrdID": "drift-b31-v4-cx-88213"
    }
  ]
}`;
const RES = `{
  "code": 0,
  "data": [
    {
      "code": -1,
      "error": "order rejected: OrderNotFound"
    }
  ]
}`;

export const DETAIL: SodexCallDetail = {
  ...CANCEL,
  url: "https://mainnet-gw.sodex.dev/api/v1/perps/trade/orders",
  engine: "perps",
  actionType: "cancelOrder",
  requestHeaders: [
    { name: "Content-Type", value: "application/json", redaction: "none" },
    { name: "X-API-Key", value: "••29c1", redaction: "masked" },
    { name: "X-API-Nonce", value: "1763391912468", redaction: "none" },
    { name: "X-API-Sign", value: null, redaction: "signature" },
  ],
  requestBody: REQ,
  requestBodyBytes: 162,
  signed: true,
  responseHeaders: [{ name: "content-type", value: "application/json" }],
  responseBody: RES,
  responseBodyBytes: 78,
  responseTruncated: false,
  envelopeCode: 0,
  orderCodes: [-1],
  unreadableReason: "order_result_without_cl_ord_id",
  traceId: "7f3c9a1e5b2d4c08",
  sodexAccountId: "20417",
  orderIds: [],
  botDetail: { id: BOT.id, name: BOT.name, strategy: "volume_maker", market: "SOL-USD" },
  accountUserId: null,
  wsConn: { connId: "ws-perps-3f8a", open: true },
  related: [PLACE],
  builderId: "1645",
};

const HOUR = 3_600_000;
const END = Date.parse("2026-11-17T15:00:00Z");
export const SUMMARY: SodexCallSummary = {
  from: "2026-11-16T15:42:10Z",
  to: "2026-11-17T15:42:10Z",
  calls: 182406,
  errors: 620,
  timeouts: 41,
  timeoutsAboveUsual: true,
  errorsAboveUsual: false,
  p95Ms: 212,
  timeoutsPerHour: Array.from({ length: 24 }, (_, i) => ({
    hour: new Date(END - (23 - i) * HOUR).toISOString().replace(".000Z", "Z"),
    count: i === 23 ? 37 : i === 22 ? 2 : 0,
  })),
  peak: {
    hour: "2026-11-17T15:00:00Z",
    count: 37,
    firstAt: "2026-11-17T15:05:09Z",
    lastAt: "2026-11-17T15:09:03Z",
    endpoints: ["GET /perps/accounts/{addr}/orders", "POST /perps/trade/orders"],
  },
  endpoints: [
    {
      endpoint: "/perps/trade/orders",
      method: "POST",
      calls: 64210,
      errors: 540,
      timeouts: 9,
      p95Ms: 184,
      errorsAboveUsual: true,
      timeoutsAboveUsual: true,
    },
    {
      endpoint: "/perps/accounts/{addr}/orders",
      method: "GET",
      calls: 41377,
      errors: 29,
      timeouts: 31,
      p95Ms: 1120,
      errorsAboveUsual: false,
      timeoutsAboveUsual: true,
    },
  ],
  topReject: { reason: "PostOnly", share: 0.81 },
  readAt: "2026-11-17T15:42:10Z",
};

export const FACETS: SodexCallFacets = {
  services: ["api", "engine"],
  endpoints: ["/perps/trade/orders"],
  bots: [BOT],
  accounts: [ADDRESS],
};
