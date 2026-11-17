import { randomUUID } from "node:crypto";

import { createSodexCallSink } from "@drift/db";
import {
  errorResponseSchema,
  meSchema,
  sodexCallDetailSchema,
  sodexCallFacetsSchema,
  sodexCallsPageSchema,
  sodexCallSummarySchema,
} from "@drift/shared";
import {
  SIGNATURE_REDACTED,
  toSodexCallRow,
  type SodexRestCapture,
  type SodexWsCapture,
} from "@drift/sodex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// SoDEX Debugger (docs/mockups/sodex-debugger, DEC-TBD-sodex-debugger): quyền team, lọc, phân trang, chi tiết đã che,
// tóm tắt 24 giờ. Dữ liệu đi qua đúng đường ghi thật: capture → toSodexCallRow → sink batch vào hai hypertable.

let env: TestEnv;
let team: TestClient;
let botId: string;
const ADDR = "0x4e1e8c0b7a2d5f3e91a6b4c0d8e2f7a1b3c529db";
const BASE = "https://mainnet-gw.sodex.dev/api/v1";
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeAll(async () => {
  env = await startTestEnv();
  // Retention policy của Timescale chạy theo giờ thật: dữ liệu test phải nằm quanh giờ thật.
  env.clock.now = new Date(Math.floor(Date.now() / HOUR) * HOUR + 30 * MIN);
  team = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, team, `sd-${randomUUID()}@drift.test`)).json());
  await env.pool.query("update users set role = 'team' where id = $1", [me.id]);
  const { rows: acc } = await env.pool.query<{ id: string }>(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, 20417, 'mainnet', 'connected') returning id",
    [me.id, ADDR],
  );
  const accountId = acc[0]?.id ?? "";
  const { rows: bot } = await env.pool.query<{ id: string }>(
    `insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode)
     values (gen_random_uuid(), $1, $2, 'market_making', 'SOL-USD', 'perps', 'SOL quotes', 'running', 'live') returning id`,
    [me.id, accountId],
  );
  botId = bot[0]?.id ?? "";
  // Lệnh của bot: tin WS không có botId được nối với bot qua orders (account + clOrdID).
  await env.pool.query(
    `insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, status, tag, epoch)
     values (gen_random_uuid(), $1, $2, 'drift-b31-l2-a0', 'SOL-USD', 'perps', 'buy', 'limit', 'GTX', '1', 'open', 'quote', 1)`,
    [botId, accountId],
  );

  const now = env.clock.now.getTime();
  const rest = (over: Partial<SodexRestCapture>): SodexRestCapture => ({
    kind: "rest",
    startedAt: now - MIN,
    latencyMs: 100,
    method: "POST",
    url: `${BASE}/perps/trade/orders`,
    requestHeaders: {
      "Content-Type": "application/json",
      "X-API-Sign": SIGNATURE_REDACTED,
      "X-API-Nonce": "1763391912468",
      "X-API-Key": "DeskLabs-20261117",
    },
    requestBody: '{"accountID":20417,"symbolID":2,"orders":[{"clOrdID":"drift-b31-l2-a0"}]}',
    signed: true,
    actionType: "newOrder",
    failure: null,
    errorDetail: null,
    httpStatus: 200,
    responseHeaders: new Headers({ "content-type": "application/json" }),
    responseText:
      '{"code":0,"timestamp":1,"data":[{"code":0,"clOrdID":"drift-b31-l2-a0","orderID":777}]}',
    orderResults: true,
    context: { botId, accountId, traceId: "trace-place" },
    ...over,
  });
  const ws: SodexWsCapture = {
    kind: "ws",
    startedAt: now - 10 * MIN,
    latencyMs: 30,
    event: "OPEN",
    url: "wss://mainnet-gw.sodex.dev/ws/perps",
    engine: "perps",
    channel: null,
    connId: "ws-perps-3f8a1c2d",
    accountAddress: ADDR,
    sodexAccountId: "20417",
    request: null,
    response: null,
    outcome: "ok",
    detail: null,
    context: { accountId },
  };
  const captures = [
    ws,
    {
      ...ws,
      event: "MSG" as const,
      startedAt: now - MIN + 500,
      channel: "accountOrderUpdate",
      response:
        '{"channel":"accountOrderUpdate","data":[{"c":"drift-b31-l2-a0","i":777,"X":"NEW"}]}',
    },
    rest({}),
    // Huỷ trả kết quả không có clOrdID → unreadable, cùng clOrdID gốc qua origClOrdID.
    rest({
      startedAt: now - MIN + 580,
      method: "DELETE",
      actionType: "cancelOrder",
      requestBody:
        '{"accountID":20417,"cancels":[{"symbolID":2,"clOrdID":"drift-b31-cx-1","origClOrdID":"drift-b31-l2-a0"}]}',
      responseText:
        '{"code":0,"timestamp":1,"data":[{"code":-1,"error":"order rejected: OrderNotFound"}]}',
      latencyMs: 214,
      context: { botId, accountId, traceId: "trace-cancel" },
    }),
    rest({
      startedAt: now - 2 * MIN,
      responseText:
        '{"code":0,"timestamp":1,"data":[{"code":-1,"clOrdID":"drift-x-1","error":"PostOnly"}]}',
      requestBody: '{"accountID":20417,"symbolID":2,"orders":[{"clOrdID":"drift-x-1"}]}',
      context: undefined,
    }),
    rest({
      startedAt: now - 3 * MIN,
      method: "GET",
      url: `${BASE}/perps/accounts/${ADDR}/orders?symbol=SOL-USD`,
      requestHeaders: { Accept: "application/json" },
      requestBody: null,
      signed: false,
      actionType: null,
      failure: "timeout",
      errorDetail: "SoDEX request timed out",
      httpStatus: null,
      responseHeaders: null,
      responseText: null,
      latencyMs: 5000,
      orderResults: false,
      context: undefined,
    }),
    rest({
      startedAt: now - 4 * MIN,
      method: "GET",
      url: `${BASE}/perps/markets/mark-prices`,
      requestHeaders: { Accept: "application/json" },
      requestBody: null,
      signed: false,
      actionType: null,
      responseText: '{"code":0,"timestamp":1,"data":[]}',
      schemaOk: true,
      latencyMs: 1500,
      orderResults: false,
      context: undefined,
    }),
  ];
  const sink = createSodexCallSink(env.container.getConnectionUri());
  await sink.write(captures.map((c) => toSodexCallRow(c, c.kind === "ws" ? "engine" : "engine")));
  await sink.write([toSodexCallRow(rest({ startedAt: now - 5 * MIN }), "api")]);
  await sink.close();
});
afterAll(async () => {
  await env.close();
});

const list = async (query = "") => {
  const res = await team.request("GET", `/api/v1/admin/sodex-calls${query}`);
  expect(res.statusCode).toBe(200);
  return sodexCallsPageSchema.parse(res.json());
};

describe("SoDEX Debugger API", () => {
  it("is for the team only: 401 signed out, 403 for users (before parsing), no-store", async () => {
    for (const path of [
      "/api/v1/admin/sodex-calls",
      "/api/v1/admin/sodex-calls/summary",
      "/api/v1/admin/sodex-calls/facets",
      `/api/v1/admin/sodex-calls/${randomUUID()}`,
    ]) {
      expect((await new TestClient(env.app).request("GET", path)).statusCode).toBe(401);
    }
    const user = new TestClient(env.app);
    await signIn(env, user, `sd-${randomUUID()}@drift.test`);
    const denied = await user.request("GET", "/api/v1/admin/sodex-calls?show=bogus");
    expect(denied.statusCode).toBe(403);
    expect(errorResponseSchema.parse(denied.json()).error.message).toBe(
      "SoDEX Debugger is for the DeskLabs team only.",
    );
    expect((await user.request("GET", "/api/v1/admin/sodex-calls/summary")).statusCode).toBe(403);
    expect((await team.request("GET", "/api/v1/admin/sodex-calls?show=bogus")).statusCode).toBe(
      400,
    );
    const ok = await team.request("GET", "/api/v1/admin/sodex-calls");
    expect(ok.headers["cache-control"]).toBe("no-store");
  });

  it("lists every call newest first with counts, and filters by outcome", async () => {
    const all = await list();
    expect(all.items).toHaveLength(8);
    expect(all.items.map((i) => i.at)).toEqual([...all.items.map((i) => i.at)].sort().reverse());
    expect(all.counts).toEqual({ all: 8, errors: 3, timeouts: 1, slow: 2 });
    expect((await list("?show=errors")).items.map((i) => i.outcome).sort()).toEqual([
      "rejected",
      "timeout",
      "unreadable",
    ]);
    expect((await list("?show=timeouts")).items).toHaveLength(1);
    expect((await list("?show=slow")).items.map((i) => i.latencyMs).sort()).toEqual([1500, 5000]);
    expect((await list("?show=slow&slowMs=200")).items).toHaveLength(3);
    const rejected = (await list("?show=errors")).items.find((i) => i.outcome === "rejected");
    expect(rejected?.sodexSays).toBe("PostOnly");
  });

  it("filters by service, endpoint, bot, account and search", async () => {
    expect((await list("?service=api")).items).toHaveLength(1);
    expect((await list("?endpoint=/perps/accounts/{addr}/orders")).items).toHaveLength(1);
    const byBot = await list(`?botId=${botId}`);
    // Lệnh (engine + api), huỷ và tin WS (nối bot qua orders) của bot; không có lệnh ngoài ngữ cảnh bot.
    expect(byBot.items.map((i) => i.method).sort()).toEqual(["DELETE", "MSG", "POST", "POST"]);
    expect(byBot.items.every((i) => i.bot?.name === "SOL quotes")).toBe(true);
    expect((await list(`?account=${ADDR.toUpperCase().replace("0X", "0x")}`)).items.length).toBe(6);
    expect((await list("?q=drift-b31-l2-a0")).items).toHaveLength(4);
    expect((await list("?q=777")).items).toHaveLength(3);
    expect((await list("?q=trace-cancel")).items).toHaveLength(1);
    expect((await list("?q=ws-perps-3f8a1c2d")).items).toHaveLength(2);
  });

  it("pages with a cursor", async () => {
    const first = await list("?limit=3");
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(`?limit=3&cursor=${first.nextCursor ?? ""}`);
    const third = await list(`?limit=3&cursor=${second.nextCursor ?? ""}`);
    expect(third.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items, ...third.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(8);
    expect((await team.request("GET", "/api/v1/admin/sodex-calls?cursor=bad")).statusCode).toBe(
      400,
    );
  });

  it("shows a call in full with the signature and key removed, related calls and the WS connection", async () => {
    const cancel = (await list("?show=errors")).items.find((i) => i.outcome === "unreadable");
    const res = await team.request("GET", `/api/v1/admin/sodex-calls/${cancel?.id ?? ""}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).not.toContain("ab".repeat(65));
    expect(res.body).not.toContain("DeskLabs-20261117");
    const d = sodexCallDetailSchema.parse(res.json());
    expect(d).toMatchObject({
      method: "DELETE",
      endpoint: "/perps/trade/orders",
      outcome: "unreadable",
      unreadableReason: "order_result_without_cl_ord_id",
      envelopeCode: 0,
      sodexCode: -1,
      sodexSays: "order rejected: OrderNotFound",
      signed: true,
      actionType: "cancelOrder",
      traceId: "trace-cancel",
      sodexAccountId: "20417",
      accountAddress: ADDR,
      botDetail: { id: botId, name: "SOL quotes", strategy: "market_making", market: "SOL-USD" },
      wsConn: { connId: "ws-perps-3f8a1c2d", open: true },
      builderId: "1645",
    });
    expect(d.accountUserId).not.toBeNull();
    expect(d.requestHeaders).toContainEqual({
      name: "X-API-Sign",
      value: null,
      redaction: "signature",
    });
    expect(d.requestHeaders).toContainEqual({
      name: "X-API-Key",
      value: "••1117",
      redaction: "masked",
    });
    expect(JSON.parse(d.requestBody ?? "null")).toMatchObject({ accountID: 20417 });
    // Cùng clOrdID gốc: hai lệnh đặt (engine, api) và tin WS NEW.
    expect(d.related.map((r) => r.method).sort()).toEqual(["MSG", "POST", "POST"]);

    const missing = await team.request("GET", `/api/v1/admin/sodex-calls/${randomUUID()}`);
    expect(missing.statusCode).toBe(404);
    expect((await team.request("GET", "/api/v1/admin/sodex-calls/nope")).statusCode).toBe(400);
  });

  it("summarises the last 24 hours from every stored call", async () => {
    const res = await team.request("GET", "/api/v1/admin/sodex-calls/summary");
    const s = sodexCallSummarySchema.parse(res.json());
    expect(s).toMatchObject({ calls: 8, errors: 3, timeouts: 1 });
    expect(s.p95Ms).toBeGreaterThan(1000);
    expect(s.timeoutsPerHour).toHaveLength(24);
    expect(s.timeoutsPerHour.reduce((a, h) => a + h.count, 0)).toBe(1);
    expect(s.peak).toMatchObject({ count: 1, endpoints: ["GET /perps/accounts/{addr}/orders"] });
    expect(s.topReject).toEqual({ reason: "PostOnly", share: 1 });
    const post = s.endpoints.find((e) => e.method === "POST");
    expect(post).toMatchObject({ endpoint: "/perps/trade/orders", calls: 3, errors: 1 });
    // Không có 48 giờ trước để so: không đánh dấu ▲.
    expect(s.timeoutsAboveUsual).toBe(false);
    expect(s.endpoints.some((e) => e.method === "WS OPEN")).toBe(true);
  });

  it("lists filter options for the range", async () => {
    const res = await team.request("GET", "/api/v1/admin/sodex-calls/facets?range=24h");
    const f = sodexCallFacetsSchema.parse(res.json());
    expect(f.services).toEqual(["api", "engine"]);
    expect(f.endpoints).toContain("/perps/trade/orders");
    expect(f.bots).toEqual([{ id: botId, name: "SOL quotes" }]);
    expect(f.accounts).toEqual([ADDR]);
  });

  it("stores the calls in two Timescale hypertables with compression and 3 / 14 day retention", async () => {
    const { rows } = await env.pool.query<{
      hypertable_name: string;
      proc_name: string;
      config: unknown;
    }>(
      `select hypertable_name, proc_name, config from timescaledb_information.jobs
       where hypertable_name like 'sodex_calls_%' order by hypertable_name, proc_name`,
    );
    expect(rows.map((r) => [r.hypertable_name, r.proc_name, r.config])).toEqual([
      [
        "sodex_calls_ok",
        "policy_compression",
        expect.objectContaining({ compress_after: "1 day" }),
      ],
      ["sodex_calls_ok", "policy_retention", expect.objectContaining({ drop_after: "3 days" })],
      [
        "sodex_calls_problem",
        "policy_compression",
        expect.objectContaining({ compress_after: "1 day" }),
      ],
      [
        "sodex_calls_problem",
        "policy_retention",
        expect.objectContaining({ drop_after: "14 days" }),
      ],
    ]);
    const split = await env.pool.query<{ ok: string; problem: string }>(
      "select (select count(*) from sodex_calls_ok) as ok, (select count(*) from sodex_calls_problem) as problem",
    );
    // Lỗi + chậm (1500 ms, 5000 ms timeout) → bảng 14 ngày.
    expect(split.rows[0]).toEqual({ ok: "4", problem: "4" });
  });
});
