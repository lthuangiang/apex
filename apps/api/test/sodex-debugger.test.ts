import { randomUUID } from "node:crypto";

import { createSodexCallSink } from "@drift/db";
import {
  errorResponseSchema,
  meSchema,
  sodexCallDetailSchema,
  sodexCallFacetsSchema,
  sodexCallsPageSchema,
  sodexCallSummarySchema,
  SODEX_CALL_COUNT_CAP,
} from "@drift/shared";
import {
  envelopeOf,
  parseSodexJson,
  SIGNATURE_REDACTED,
  toSodexCallRow,
  uuidV7At,
  type SodexRestCapture,
  type SodexWsCapture,
} from "@drift/sodex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// SoDEX Debugger (docs/mockups/sodex-debugger, DEC-309): quyền team, lọc, phân trang, chi tiết đã che,
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
  // Như client: body response đã parse sẵn → code envelope / kết quả lệnh (debugger không parse lại).
  const rest = (over: Partial<SodexRestCapture>): SodexRestCapture => {
    const c = restRaw(over);
    let body: unknown;
    let json = c.responseText !== null && c.failure === null;
    try {
      body = c.responseText === null ? undefined : parseSodexJson(c.responseText);
    } catch {
      json = false;
    }
    const env = envelopeOf(body);
    return {
      ...c,
      json,
      responseLength: c.responseText?.length ?? null,
      envelopeCode: env.code,
      envelopeError: env.error,
      orderResults: c.orderEndpoint === true && Array.isArray(env.data) ? env.data : null,
    };
  };
  const restRaw = (over: Partial<SodexRestCapture>): SodexRestCapture => ({
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
    responseHeaders: { "content-type": "application/json" },
    responseText:
      '{"code":0,"timestamp":1,"data":[{"code":0,"clOrdID":"drift-b31-l2-a0","orderID":777}]}',
    responseLength: null,
    json: true,
    envelopeCode: null,
    envelopeError: null,
    orderEndpoint: true,
    orderResults: null,
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
      items: [{ c: "drift-b31-l2-a0", i: 777, X: "NEW" }],
    },
    rest({}),
    // Huỷ trả kết quả lỗi không có clOrdID (không phải OrderNotFound, #493) → unreadable, cùng clOrdID gốc qua origClOrdID.
    rest({
      startedAt: now - MIN + 580,
      method: "DELETE",
      actionType: "cancelOrder",
      requestBody:
        '{"accountID":20417,"cancels":[{"symbolID":2,"clOrdID":"drift-b31-cx-1","origClOrdID":"drift-b31-l2-a0"}]}',
      responseText:
        '{"code":0,"timestamp":1,"data":[{"code":-1,"error":"order rejected: InternalError"}]}',
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
      orderEndpoint: false,
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
      orderEndpoint: false,
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
      sodexSays: "order rejected: InternalError",
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
    // Bảng ok (3 ngày) không nén để mọi index dùng được; bảng problem nén sau 2 ngày (review PR #217 M4).
    expect(rows.map((r) => [r.hypertable_name, r.proc_name, r.config])).toEqual([
      ["sodex_calls_ok", "policy_retention", expect.objectContaining({ drop_after: "3 days" })],
      [
        "sodex_calls_problem",
        "policy_compression",
        expect.objectContaining({ compress_after: "2 days" }),
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

  it("drops only the row Postgres refuses and keeps every other row of the batch", async () => {
    const now = env.clock.now.getTime();
    const base = toSodexCallRow(
      restRawForSink({ startedAt: now - 30 * MIN, failure: "timeout" }),
      "sink-test",
    );
    const ok = toSodexCallRow(restRawForSink({ startedAt: now - 30 * MIN }), "sink-test");
    const rows = [
      { ...base, id: uuidV7At(now - 30 * MIN), sodexError: "bad\u0000x" }, // NUL: Postgres từ chối
      { ...base, id: uuidV7At(now - 30 * MIN + 1), botId: "not-a-uuid" }, // uuid hỏng
      { ...base, id: uuidV7At(now - 30 * MIN + 2) },
      { ...ok, id: uuidV7At(now - 30 * MIN + 3) },
      { ...ok, id: uuidV7At(now - 30 * MIN + 4) },
    ];
    const sink = createSodexCallSink(env.container.getConnectionUri());
    expect(await sink.write(rows)).toEqual({ dropped: 2 });
    await sink.close();
    const stored = await list("?service=sink-test");
    expect(stored.items.map((i) => i.outcome).sort()).toEqual(["ok", "ok", "timeout"]);
  });

  it("caps the outcome counts at 1,000+ and only counts on the first page", async () => {
    const now = env.clock.now.getTime();
    const one = toSodexCallRow(
      restRawForSink({ startedAt: now - 40 * MIN, failure: "timeout" }),
      "bulk",
    );
    const rows = Array.from({ length: SODEX_CALL_COUNT_CAP + 5 }, (_, i) => ({
      ...one,
      id: uuidV7At(now - 40 * MIN + i),
      at: new Date(now - 40 * MIN + i),
    }));
    const sink = createSodexCallSink(env.container.getConnectionUri());
    await sink.write(rows);
    await sink.close();
    const first = await list("?service=bulk&show=timeouts&limit=2");
    expect(first.counts).toEqual({
      all: SODEX_CALL_COUNT_CAP + 1,
      errors: SODEX_CALL_COUNT_CAP + 1,
      timeouts: SODEX_CALL_COUNT_CAP + 1,
      slow: SODEX_CALL_COUNT_CAP + 1,
    });
    const next = await list(`?service=bulk&show=timeouts&limit=2&cursor=${first.nextCursor ?? ""}`);
    expect(next.counts).toBeNull();
    expect(next.items).toHaveLength(2);
  });

  it("shows a WS close with its code, reason, reconnect delay and the next open and subscribe acks (#240)", async () => {
    const now = env.clock.now.getTime();
    const addr = "0xc602000000000000000000000000000000000426";
    const t0 = now - 50 * MIN;
    const base: SodexWsCapture = {
      kind: "ws",
      startedAt: t0,
      latencyMs: 0,
      event: "CLOSE",
      url: "wss://mainnet-gw.sodex.dev/ws/perps",
      engine: "perps",
      channel: null,
      connId: "ws-perps-e03438e0",
      accountAddress: addr,
      sodexAccountId: "47125",
      request: null,
      response: JSON.stringify({
        closedBy: "server",
        code: 1001,
        reason: "going away",
        wasClean: true,
        openForMs: 3_600_000,
        lastMessageAgoMs: 1200,
        reconnectInMs: 1100,
        reconnectAttempt: 1,
      }),
      outcome: "network",
      detail:
        'closed by SoDEX (code 1001, reason "going away"): reconnecting in 1100 ms (attempt 1)',
      context: undefined,
    };
    const sub = (at: number, id: number, channel: string, connId: string, account = addr) => ({
      ...base,
      event: "SUB" as const,
      startedAt: at,
      latencyMs: 80,
      channel,
      connId,
      accountAddress: account,
      request: `{"op":"subscribe","id":${String(id)},"params":{"channel":"${channel}"}}`,
      response: `{"op":"subscribe","id":${String(id)},"success":true}`,
      outcome: "ok" as const,
      detail: null,
    });
    const captures: SodexWsCapture[] = [
      base,
      // Kết nối của account khác mở ngay sau: không được nối.
      {
        ...base,
        event: "OPEN",
        startedAt: t0 + 500,
        connId: "ws-perps-other",
        accountAddress: ADDR,
        sodexAccountId: "20417",
        response: null,
        outcome: "ok",
        detail: null,
      },
      {
        ...base,
        event: "OPEN",
        startedAt: t0 + 1150,
        latencyMs: 40,
        connId: "ws-perps-next0001",
        response: null,
        outcome: "ok",
        detail: null,
      },
      sub(t0 + 1250, 1, "accountOrderUpdate", "ws-perps-next0001"),
      sub(t0 + 1260, 2, "accountTrade", "ws-perps-next0001"),
      sub(t0 + 1270, 1, "accountOrderUpdate", "ws-perps-other", ADDR),
    ];
    const sink = createSodexCallSink(env.container.getConnectionUri());
    await sink.write(captures.map((c) => toSodexCallRow(c, "engine")));
    await sink.close();

    const close = (await list("?q=ws-perps-e03438e0")).items.find((i) => i.method === "CLOSE");
    const res = await team.request("GET", `/api/v1/admin/sodex-calls/${close?.id ?? ""}`);
    expect(res.statusCode).toBe(200);
    const d = sodexCallDetailSchema.parse(res.json());
    expect(d.sodexSays).toContain("code 1001");
    expect(d.wsReconnect?.close).toEqual({
      closedBy: "server",
      code: 1001,
      reason: "going away",
      wasClean: true,
      openForMs: 3_600_000,
      lastMessageAgoMs: 1200,
      reconnectInMs: 1100,
      reconnectAttempt: 1,
    });
    expect(d.wsReconnect?.nextOpenAvailable).toBe(true);
    expect(d.wsReconnect?.nextOpen).toMatchObject({ method: "OPEN", connId: "ws-perps-next0001" });
    expect(new Date(d.wsReconnect?.nextOpen?.at ?? 0).getTime() - new Date(d.at).getTime()).toBe(
      1150,
    );
    expect(d.wsReconnect?.nextSubscribes.map((s) => [s.endpoint, s.outcome, s.connId])).toEqual([
      ["accountOrderUpdate", "ok", "ws-perps-next0001"],
      ["accountTrade", "ok", "ws-perps-next0001"],
    ]);

    // Dòng không phải CLOSE: không có wsReconnect.
    const open = (await list("?q=ws-perps-next0001")).items.find((i) => i.method === "OPEN");
    const openDetail = sodexCallDetailSchema.parse(
      (await team.request("GET", `/api/v1/admin/sodex-calls/${open?.id ?? ""}`)).json(),
    );
    expect(openDetail.wsReconnect).toBeNull();

    // Review #256: CLOSE (bảng problem, 14 ngày) cũ hơn thời hạn giữ dòng ok (3 ngày) thì OPEN kế tiếp có thể đã bị
    // xoá: API báo không tra được, không nói "không có". Ở đây OPEN vẫn còn trong DB, nên kết quả chỉ dựa vào tuổi.
    const realNow = env.clock.now;
    try {
      const closeAt = new Date(d.at).getTime();
      const detailAt = async (at: number) => {
        env.clock.now = new Date(at);
        const r = await team.request("GET", `/api/v1/admin/sodex-calls/${close?.id ?? ""}`);
        return sodexCallDetailSchema.parse(r.json()).wsReconnect;
      };
      // Cửa sổ 10 phút vẫn nằm trong 3 ngày: còn tra.
      const inside = await detailAt(closeAt + 10 * MIN + 3 * 24 * HOUR - MIN);
      expect(inside?.nextOpenAvailable).toBe(true);
      expect(inside?.nextOpen?.connId).toBe("ws-perps-next0001");
      // Cửa sổ đã cũ hơn 3 ngày: không tra, chi tiết đóng vẫn còn.
      const expired = await detailAt(closeAt + 10 * MIN + 3 * 24 * HOUR + MIN);
      expect(expired).toEqual({
        close: d.wsReconnect?.close,
        nextOpenAvailable: false,
        nextOpen: null,
        nextSubscribes: [],
      });
    } finally {
      env.clock.now = realNow;
    }
  });
});

function restRawForSink(over: Partial<SodexRestCapture>): SodexRestCapture {
  return {
    kind: "rest",
    startedAt: Date.now(),
    latencyMs: over.failure === "timeout" ? 5000 : 100,
    method: "GET",
    url: `${BASE}/perps/markets/mark-prices`,
    requestHeaders: { Accept: "application/json" },
    requestBody: null,
    signed: false,
    actionType: null,
    failure: null,
    errorDetail: null,
    httpStatus: over.failure === "timeout" ? null : 200,
    responseHeaders: null,
    responseText: over.failure === "timeout" ? null : '{"code":0,"timestamp":1,"data":[]}',
    responseLength: null,
    json: over.failure !== "timeout",
    envelopeCode: over.failure === "timeout" ? null : 0,
    envelopeError: null,
    schemaOk: true,
    context: undefined,
    ...over,
  };
}
