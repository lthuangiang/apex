import { describe, expect, it } from "vitest";

import type { SodexRestCapture, SodexWsCapture } from "../debug/capture";
import { endpointTemplate, toSodexCallRow, uuidV7At, uuidV7Time } from "../debug/classify";

import { restCapture } from "./debug-fixtures";

// Phân loại outcome của SoDEX Debugger (DEC-309).

const BASE = "https://mainnet-gw.sodex.dev/api/v1";
const ADDR = "0x4E1e8c0B7a2d5F3e91A6b4C0d8E2f7a1B3c529Db";

function rest(over: Partial<SodexRestCapture>): SodexRestCapture {
  return restCapture(over);
}

describe("toSodexCallRow", () => {
  it("is ok when the envelope and every order result have code 0", () => {
    const row = toSodexCallRow(
      rest({
        responseText:
          '{"code":0,"timestamp":1,"data":[{"code":0,"clOrdID":"drift-b31-v4-cx-88213","orderID":18446744073709551615}]}',
      }),
      "engine",
    );
    expect(row.outcome).toBe("ok");
    expect(row.problem).toBe(false);
    expect(row.orderIds).toEqual(["18446744073709551615"]);
    expect(row.clOrdIds).toEqual(["drift-b31-v4-cx-88213"]);
    expect(row.sodexAccountId).toBe("20417");
    expect(row.endpoint).toBe("/perps/trade/orders");
    expect(row.engine).toBe("perps");
  });

  it("is rejected when SoDEX answers a negative envelope code", () => {
    const row = toSodexCallRow(
      rest({ httpStatus: 400, responseText: '{"code":-1,"error":"invalid nonce","timestamp":1}' }),
      "engine",
    );
    expect(row).toMatchObject({
      outcome: "rejected",
      sodexCode: -1,
      sodexError: "invalid nonce",
      envelopeCode: -1,
      problem: true,
    });
  });

  it("is rejected when one order in the batch has an error", () => {
    const row = toSodexCallRow(
      rest({
        method: "POST",
        responseText:
          '{"code":0,"timestamp":1,"data":[{"code":0,"clOrdID":"a","orderID":1},{"code":-1,"clOrdID":"b","error":"PostOnly"}]}',
      }),
      "engine",
    );
    expect(row).toMatchObject({
      outcome: "rejected",
      sodexCode: -1,
      sodexError: "PostOnly",
      envelopeCode: 0,
      orderCodes: [0, -1],
    });
  });

  it("is unreadable when a cancel result has no clOrdID", () => {
    const row = toSodexCallRow(
      rest({
        responseText:
          '{"code":0,"timestamp":1,"data":[{"code":-1,"error":"order rejected: OrderNotFound"}]}',
      }),
      "engine",
    );
    expect(row).toMatchObject({
      outcome: "unreadable",
      unreadableReason: "order_result_without_cl_ord_id",
      envelopeCode: 0,
      sodexCode: -1,
      sodexError: "order rejected: OrderNotFound",
      problem: true,
    });
  });

  it("is unreadable when the body is not JSON or does not match the schema", () => {
    expect(toSodexCallRow(rest({ responseText: "<html>" }), "api")).toMatchObject({
      outcome: "unreadable",
      unreadableReason: "invalid_json",
    });
    expect(
      toSodexCallRow(rest({ httpStatus: 502, responseText: "<html>bad gateway</html>" }), "api"),
    ).toMatchObject({ outcome: "unreadable", unreadableReason: "http_error" });
    expect(
      toSodexCallRow(
        rest({
          method: "GET",
          signed: false,
          orderEndpoint: false,
          schemaOk: false,
          url: `${BASE}/perps/accounts/${ADDR}/orders?symbol=BTC-USD`,
        }),
        "jobs",
      ),
    ).toMatchObject({ outcome: "unreadable", unreadableReason: "schema_mismatch" });
  });

  it("keeps timeouts and network errors with their detail", () => {
    expect(
      toSodexCallRow(
        rest({
          failure: "timeout",
          errorDetail: "SoDEX request timed out",
          httpStatus: null,
          responseText: null,
          latencyMs: 5000,
        }),
        "engine",
      ),
    ).toMatchObject({
      outcome: "timeout",
      errorDetail: "SoDEX request timed out",
      latencyMs: 5000,
    });
    expect(
      toSodexCallRow(
        rest({
          failure: "network",
          errorDetail: "socket hang up",
          httpStatus: null,
          responseText: null,
        }),
        "engine",
      ),
    ).toMatchObject({ outcome: "network", errorDetail: "socket hang up" });
  });

  it("marks slow successful calls as problems (kept 14 days)", () => {
    expect(toSodexCallRow(rest({ latencyMs: 1001 }), "engine").problem).toBe(true);
    expect(toSodexCallRow(rest({ latencyMs: 1000 }), "engine").problem).toBe(false);
  });

  it("templates addresses and symbols out of the endpoint and keeps the full address", () => {
    const row = toSodexCallRow(
      rest({
        method: "GET",
        signed: false,
        orderEndpoint: false,
        url: `${BASE}/perps/accounts/${ADDR}/orders?symbol=BTC-USD`,
        responseText: '{"code":0,"timestamp":1,"data":{"orders":[]}}',
        schemaOk: true,
      }),
      "jobs",
    );
    expect(row.endpoint).toBe("/perps/accounts/{addr}/orders");
    expect(row.accountAddress).toBe(ADDR.toLowerCase());
    expect(endpointTemplate("/perps/markets/BTC-USD/klines?interval=1m")).toBe(
      "/perps/markets/{symbol}/klines",
    );
    expect(endpointTemplate("/perps/markets/symbols")).toBe("/perps/markets/symbols");
    expect(endpointTemplate(`/user/${ADDR}/builders`)).toBe("/user/{addr}/builders");
  });

  it("records WS subscribe rejects and pushes with their clOrdIDs", () => {
    const ws: SodexWsCapture = {
      kind: "ws",
      startedAt: Date.now(),
      latencyMs: 41,
      event: "SUB",
      url: "wss://mainnet-gw.sodex.dev/ws/perps",
      engine: "perps",
      channel: "accountOrderUpdate",
      connId: "ws-perps-3f8a1c2d",
      accountAddress: ADDR,
      sodexAccountId: "20417",
      request: '{"op":"subscribe","id":1}',
      response: '{"op":"subscribe","id":1,"success":false,"error":"user not found"}',
      outcome: "rejected",
      detail: "user not found",
      context: { accountId: "0193a0c4-0000-7000-8000-000000000000" },
    };
    expect(toSodexCallRow(ws, "engine")).toMatchObject({
      kind: "ws",
      method: "SUB",
      endpoint: "accountOrderUpdate",
      outcome: "rejected",
      sodexError: "user not found",
      connId: "ws-perps-3f8a1c2d",
      accountId: "0193a0c4-0000-7000-8000-000000000000",
    });
    const push = toSodexCallRow(
      {
        ...ws,
        event: "MSG",
        outcome: "ok",
        detail: null,
        request: null,
        response: '{"channel":"accountOrderUpdate","data":[{"c":"drift-b1-a","i":99,"X":"NEW"}]}',
        items: [{ c: "drift-b1-a", i: 99, X: "NEW" }],
      },
      "engine",
    );
    expect(push).toMatchObject({ outcome: "ok", clOrdIds: ["drift-b1-a"], orderIds: ["99"] });
  });

  it("puts the call time into the uuid v7 id", () => {
    const at = Date.UTC(2026, 10, 17, 15, 5, 12, 481);
    const id = uuidV7At(at);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidV7Time(id)).toBe(at);
  });
});
