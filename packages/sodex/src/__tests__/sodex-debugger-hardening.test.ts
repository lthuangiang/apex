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

describe("redact before cutting (re-review #217)", () => {
  const hexTail = /[0-9a-fA-F]{16,}$/;

  it("redacts a signature that straddles the 16 KB storage cut of an Ok call", () => {
    const pad = "p".repeat(16 * 1024 - 60);
    const row = toSodexCallRow(
      restCapture({
        method: "GET",
        signed: false,
        orderEndpoint: false,
        responseText: `{"code":0,"timestamp":1,"data":"${pad} ${SIG65} tail"}`,
        schemaOk: true,
      }),
      "api",
    );
    expect(row.problem).toBe(false);
    // Chữ ký nằm vắt qua mốc 16 KB của bản thô: che trước rồi cắt nên không còn đoạn hex nào.
    expect(row.responseBody).toContain(REDACTED);
    expect(row.responseBody).not.toMatch(/abab/);
  });

  it("drops a partial hex run left at the record-time cut", () => {
    // Body dài hơn giới hạn record: chữ ký bị capBody cắt đôi, phần còn lại ngắn hơn ngưỡng 64.
    const pad = "q".repeat(RECORD_BODY_LIMIT - 30);
    const raw = `{"code":-1,"error":"${pad} ${SIG65}"}`;
    const row = toSodexCallRow(
      restCapture({ httpStatus: 400, responseText: capBody(raw), responseLength: raw.length }),
      "engine",
    );
    expect(row.responseTruncated).toBe(true);
    expect(row.responseBody).not.toMatch(hexTail);
    expect(row.responseBody).not.toMatch(/abab/);
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
  it("keeps every classification slice short with 250 KB bodies", async () => {
    const item = `{"code":0,"clOrdID":"drift-b1-v1-l1-a1","orderID":18446744073709551615,"error":"PostOnly ${"z".repeat(200)}"}`;
    const big = `{"code":0,"timestamp":1,"data":[${Array.from({ length: 1_000 }, () => item).join(",")}]}`;
    expect(big.length).toBeGreaterThan(250_000);
    // Đồng hồ thật bị nhiễu khi máy chạy nhiều worker test (bị OS tạm dừng thread, GC lớn): đo 4 vòng độc lập và lấy
    // vòng tốt nhất. Một lát dài ở MỌI vòng mới là lỗi thật của code.
    const rounds: { median: number; maxCpu: number; cpuShare: number; rows: SodexCallRow[] }[] = [];
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
      // Mỗi lượt event loop thật trong lúc flush: chuỗi setImmediate chen giữa các lát của recorder, nên khoảng cách giữa
      // hai lượt liên tiếp là một lát. Đo cả đồng hồ thật lẫn thời gian CPU của process: lúc OS tạm dừng thread (máy bận)
      // đồng hồ thật vẫn chạy nhưng CPU thì không, nên thời gian CPU của một lát là phần việc thật của code.
      const cpuMs = () => {
        const u = process.cpuUsage();
        return (u.user + u.system) / 1_000;
      };
      const turns: { wall: number; cpu: number }[] = [];
      let probing = true;
      const turn = () => {
        turns.push({ wall: performance.now(), cpu: cpuMs() });
        if (probing) setImmediate(turn);
      };
      setImmediate(turn);
      const cpuStart = cpuMs();
      // Mốc đầu ngay trước flush (đồng bộ), để lát đầu tiên cũng được đo.
      turns.push({ wall: performance.now(), cpu: cpuStart });
      await r.flush();
      const cpuTotal = cpuMs() - cpuStart;
      probing = false;
      const gaps = turns.slice(1).map((t, i) => ({
        wall: t.wall - (turns[i]?.wall ?? t.wall),
        cpu: t.cpu - (turns[i]?.cpu ?? t.cpu),
      }));
      const walls = gaps.map((g) => g.wall).sort((a, b) => a - b);
      const median = walls[Math.floor(walls.length / 2)] ?? Number.POSITIVE_INFINITY;
      // Không có lượt nào chen vào trong lúc flush: cả flush là một lát.
      const maxCpu = gaps.length === 0 ? cpuTotal : Math.max(...gaps.map((g) => g.cpu));
      rounds.push({ median, maxCpu, cpuShare: maxCpu / cpuTotal, rows });
    }
    for (const round of rounds) {
      expect(round.rows).toHaveLength(150);
      expect(round.rows.every((x) => x.responseTruncated)).toBe(true);
    }
    // Ngưỡng an toàn cho CI (#225). Mục tiêu thiết kế là lát ~2 ms (`sliceBudgetMs`) cộng một bản ghi; máy rảnh đo lát dài
    // nhất (đồng hồ thật) < 10 ms, nhưng đó là max của ~150 lát nên chỉ cần OS tạm dừng thread một lần là vượt: runner
    // 2 vCPU của GitHub đo 11,1 ms (PR #256), máy dev chạy cả monorepo đo 58–178 ms ở vòng tốt nhất. Thay bằng:
    // (1) trung vị đồng hồ thật của lát < 10 ms: lát thông thường vẫn ngắn, không nhạy với vài lần bị tạm dừng;
    // (2) thời gian CPU của lát dài nhất < 100 ms: một lần chặn 100 ms+ (ví dụ một bản ghi phân loại chậm đi 10 lần) vẫn
    //     hỏng, còn thời gian bị OS tạm dừng không tính;
    // (3) lát dài nhất < 1/10 thời gian CPU của cả lần flush: mất bước nhường event loop (cả flush là một lát) thì hỏng dù
    //     máy nhanh hay chậm.
    expect(Math.min(...rounds.map((x) => x.median))).toBeLessThan(10);
    expect(Math.min(...rounds.map((x) => x.maxCpu))).toBeLessThan(100);
    expect(Math.min(...rounds.map((x) => x.cpuShare))).toBeLessThan(0.1);
  }, 60_000);
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
