import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { capBody, RECORD_BODY_LIMIT, type SodexWsCapture } from "../debug/capture";
import { toSodexCallRow, type SodexCallRow } from "../debug/classify";
import { createSodexCallRecorder, SodexCallRecorder } from "../debug/recorder";
import { REDACTED, redactBody, scrubText } from "../debug/redact";

import { restCapture } from "./debug-fixtures";

// Sửa theo review PR #217: B2 (không đứng event loop), B3 (công tắc), M1 (che hex trong chuỗi), M2 (dữ liệu hỏng),
// M3 (giới hạn theo dung lượng), M6 (cảnh báo có giới hạn).

const SIG65 = `0x01${"ab".repeat(65)}`;
const SIG64 = `0x${"cd".repeat(64)}`;
const PRIV = `0x${"11".repeat(32)}`;

const recorders: SodexCallRecorder[] = [];
function recorder(opts: Partial<ConstructorParameters<typeof SodexCallRecorder>[0]> = {}) {
  const r = new SodexCallRecorder({
    service: "engine",
    sink: () => Promise.resolve(),
    flushIntervalMs: 3_600_000,
    ...opts,
  });
  recorders.push(r);
  return r;
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(recorders.splice(0).map((r) => r.close(10)));
});

describe("M1: long hex is removed everywhere, not only whole values", () => {
  it("scrubs signatures echoed in SoDEX errors, error details, WS details and bodies", () => {
    const row = toSodexCallRow(
      restCapture({
        httpStatus: 400,
        responseText: JSON.stringify({ code: -1, error: `invalid signature ${SIG65}` }),
        errorDetail: `upstream said ${SIG64}`,
      }),
      "engine",
    );
    const stored = JSON.stringify(row);
    expect(stored).not.toContain("ab".repeat(65));
    expect(stored).not.toContain("cd".repeat(64));
    expect(row.sodexError).toBe(`invalid signature ${REDACTED}`);
    expect(row.responseBody).toContain(`invalid signature ${REDACTED}`);

    const ws: SodexWsCapture = {
      kind: "ws",
      startedAt: Date.now(),
      latencyMs: 1,
      event: "SUB",
      url: "wss://x/ws/perps",
      engine: "perps",
      channel: "accountTrade",
      connId: "ws-perps-1",
      accountAddress: "0x4e1e8c0b7a2d5f3e91a6b4c0d8e2f7a1b3c529db",
      sodexAccountId: null,
      request: null,
      response: null,
      outcome: "rejected",
      detail: `bad sig ${SIG65}`,
      context: undefined,
    };
    expect(JSON.stringify(toSodexCallRow(ws, "engine"))).not.toContain("ab".repeat(65));
  });

  it("scrubs hex inside longer strings and secret-named fields of any spelling", () => {
    const out =
      redactBody(
        JSON.stringify({
          note: `key=${PRIV}`,
          s: SIG64,
          apiSign: "x",
          sign: "y",
          api_secret: "z",
          privateKeyHex: "w",
          walletSignature: "v",
          keep: "visible",
        }),
      ) ?? "";
    expect(out).not.toContain("11".repeat(32));
    expect(out).not.toContain("cd".repeat(64));
    expect(JSON.parse(out)).toEqual({
      note: `key=${REDACTED}`,
      s: REDACTED,
      apiSign: REDACTED,
      sign: REDACTED,
      api_secret: REDACTED,
      privateKeyHex: REDACTED,
      walletSignature: REDACTED,
      keep: "visible",
    });
    expect(scrubText(`a ${SIG65} b`)).toBe(`a ${REDACTED} b`);
  });

  it("masks key names and public keys in api-key list responses (rule 1.9)", () => {
    const row = toSodexCallRow(
      restCapture({
        method: "GET",
        signed: false,
        orderEndpoint: false,
        url: "https://mainnet-gw.sodex.dev/api/v1/user/0x4e1e8c0b7a2d5f3e91a6b4c0d8e2f7a1b3c529db/api-keys?accountID=1",
        responseText: JSON.stringify({
          code: 0,
          timestamp: 1,
          data: [{ name: "my-own-key", publicKey: "0x1563915e194d8cfba1943570603f7606a3115508" }],
        }),
        schemaOk: true,
      }),
      "api",
    );
    expect(row.responseBody).not.toContain("my-own-key");
    expect(row.responseBody).not.toContain("1563915e194d8cfba1943570603f7606a3115508");
    expect(row.responseBody).toContain("••-key");
    expect(row.responseBody).toContain("••5508");
  });
});

describe("M2: bad data never blocks the recorder", () => {
  it("strips NUL and lone surrogates before insert", () => {
    const row = toSodexCallRow(
      restCapture({
        httpStatus: 400,
        responseText: '{"code":-1,"error":"bad\\u0000x"}',
        errorDetail: "half \ud800 surrogate\u0000",
      }),
      "engine",
    );
    // Body chứa escape "\u0000" (6 ký tự, hợp lệ trong text); ký tự NUL thật thì bị bỏ.
    expect(row.errorDetail).toBe("half � surrogate");
    expect(JSON.stringify(row).includes(String.fromCharCode(0))).toBe(false);
  });

  it("retries an error record a few times, then drops it and counts it", async () => {
    let calls = 0;
    const r = recorder({
      maxAttempts: 2,
      sink: () => {
        calls += 1;
        return Promise.reject(new Error("db down"));
      },
    });
    r.record(restCapture({ failure: "timeout", httpStatus: null, responseText: null }));
    await r.flush();
    expect(r.queued).toBe(1);
    // Sau lần lỗi, recorder nghỉ (backoff): flush ngay không gọi sink.
    await r.flush();
    expect(calls).toBe(1);
    await r.close(10); // close bỏ backoff và thử lần cuối
    expect(r.queued).toBe(0);
    expect(r.dropped.problem).toBe(1);
  });

  it("counts rows the database refused without failing the batch", async () => {
    const warn = vi.fn();
    const r = recorder({ sink: () => Promise.resolve({ dropped: 1 }), log: { warn } });
    r.record(restCapture({}));
    await r.flush();
    expect(r.dropped.bad).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ droppedBad: 1 }),
      "sodex debugger dropped rows the database refused",
    );
  });
});

describe("M3: queue is bounded by bytes", () => {
  it("copies bodies down to the storage cap at record time", () => {
    const big = "x".repeat(RECORD_BODY_LIMIT * 4);
    const capped = capBody(big);
    expect(capped?.length).toBe(RECORD_BODY_LIMIT);
    expect(capBody("small")).toBe("small");
  });

  it("drops Ok records first when the byte budget is used up", () => {
    const L = 60_000;
    const size = 1_024 + 2 * L;
    const r = recorder({ maxBytes: 3 * size + 10 });
    const ok = () =>
      restCapture({
        method: "GET",
        signed: false,
        orderEndpoint: false,
        requestBody: null,
        responseText: `{"code":0,"timestamp":1,"data":"${"y".repeat(L - 34)}"}`,
        schemaOk: true,
      });
    expect(ok().responseText?.length).toBe(L);
    const bad = () => ({ ...ok(), latencyMs: 2_000 });
    r.record(ok());
    r.record(ok());
    r.record(ok());
    r.record(ok()); // không còn chỗ: bỏ
    expect(r.dropped.ok).toBe(1);
    r.record(bad()); // lỗi / chậm: đẩy một Ok ra
    expect(r.queued).toBe(3);
    expect(r.dropped).toMatchObject({ ok: 2, problem: 0 });
    expect(r.queuedBytes).toBeLessThanOrEqual(3 * size + 10);
  });
});

describe("B2: flush never holds the event loop", () => {
  it("keeps every classification slice under 10 ms with 250 KB bodies", async () => {
    const item = `{"code":0,"clOrdID":"drift-b1-v1-l1-a1","orderID":18446744073709551615,"error":"PostOnly ${"z".repeat(200)}"}`;
    const big = `{"code":0,"timestamp":1,"data":[${Array.from({ length: 1_000 }, () => item).join(",")}]}`;
    expect(big.length).toBeGreaterThan(250_000);
    // Đồng hồ thật bị nhiễu khi máy chạy nhiều worker test (bị OS tạm dừng thread, GC lớn): đo 4 vòng độc lập và lấy
    // vòng tốt nhất. Một lát vượt 10 ms ở MỌI vòng mới là lỗi thật của code.
    const rounds: { slice: number; lag: number; rows: SodexCallRow[] }[] = [];
    for (let round = 0; round < 4; round += 1) {
      const rows: SodexCallRow[] = [];
      const r = recorder({
        sink: (batch) => {
          rows.push(...batch);
          return Promise.resolve();
        },
      });
      for (let i = 0; i < 150; i += 1) {
        r.record(
          restCapture({
            method: i % 2 === 0 ? "GET" : "POST",
            signed: i % 2 === 1,
            orderEndpoint: false,
            url: `https://mainnet-gw.sodex.dev/api/v1/perps/accounts/0x4e1e8c0b7a2d5f3e91a6b4c0d8e2f7a1b3c529db/orders/history?i=${String(i)}`,
            responseText: capBody(big),
            responseLength: big.length,
            schemaOk: true,
            latencyMs: i % 3 === 0 ? 1_500 : 100,
          }),
        );
      }
      // Độ trễ event loop thật trong lúc flush: một timer 1 ms.
      let lag = 0;
      let last = performance.now();
      const probe = setInterval(() => {
        const now = performance.now();
        lag = Math.max(lag, now - last - 1);
        last = now;
      }, 1);
      await r.flush();
      clearInterval(probe);
      rounds.push({ slice: r.maxSliceMs, lag, rows });
    }
    for (const round of rounds) {
      expect(round.rows).toHaveLength(150);
      expect(round.rows.every((x) => x.responseTruncated)).toBe(true);
    }
    expect(Math.min(...rounds.map((x) => x.slice))).toBeLessThan(10);
    expect(Math.min(...rounds.map((x) => x.lag))).toBeLessThan(15); // gồm cả độ trễ của chính timer
  });
});

describe("M6: write failures are logged at most once a minute", () => {
  it("throttles the warning and counts every failure", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const warn = vi.fn();
    const r = recorder({ sink: () => Promise.reject(new Error("db down")), log: { warn } });
    for (let i = 0; i < 5; i += 1) {
      r.record(restCapture({ failure: "timeout", httpStatus: null, responseText: null }));
      vi.setSystemTime(Date.now() + 70_000); // qua backoff
      await r.flush();
    }
    expect(warn.mock.calls.length).toBeLessThanOrEqual(5);
    vi.setSystemTime(Date.now() + 1);
    const calls = warn.mock.calls.length;
    r.record(restCapture({ failure: "timeout", httpStatus: null, responseText: null }));
    await r.close(10);
    // Lần lỗi ngay sau đó (< 1 phút) không log thêm; bộ đếm vẫn tăng.
    expect(warn.mock.calls.length).toBe(calls);
    const last = warn.mock.calls.at(-1)?.[0] as { failures: number } | undefined;
    expect(last?.failures).toBeGreaterThanOrEqual(1);
  });
});

describe("B3: SODEX_DEBUGGER=off reaches every app container", () => {
  it("creates no recorder and opens no DB pool when off", () => {
    const sink = vi.fn(() => ({ write: () => Promise.resolve(), close: () => Promise.resolve() }));
    expect(
      createSodexCallRecorder({ service: "engine", env: { SODEX_DEBUGGER: "off" }, sink }),
    ).toBe(undefined);
    expect(sink).not.toHaveBeenCalled();
  });

  it.each(["docker-compose.yml", "deploy/server/docker-compose.yml"])(
    "%s passes SODEX_DEBUGGER to every app service through x-app-env",
    (file) => {
      const text = readFileSync(
        fileURLToPath(new URL(`../../../../${file}`, import.meta.url)),
        "utf8",
      );
      // Khối biến môi trường dùng chung của app service: `x-app-env` (dev) / `x-env` (server).
      const start = text.search(/^x-(app-)?env:/m);
      const block = text.slice(start, text.indexOf("\nx-app:"));
      expect(block).toContain("SODEX_DEBUGGER: ${SODEX_DEBUGGER:-on}");
    },
  );
});
