import { afterEach, describe, expect, it, vi } from "vitest";

import type { SodexRestCapture } from "../debug/capture";
import type { SodexCallRow } from "../debug/classify";
import { withSodexCallContext } from "../debug/context";
import { SodexCallRecorder } from "../debug/recorder";
import { MemoryRateLimitStore } from "../rate-limit/token-bucket";
import { SignedWriteClient, type SignedWriteRequest } from "../rest/signed-write";

// Hàng đợi của SoDEX Debugger: không bao giờ chặn đường gửi lệnh; đầy thì bỏ bản ghi thành công trước.

const OK_TEXT = '{"code":0,"timestamp":1,"data":[{"code":0,"clOrdID":"a1","orderID":7}]}';

function capture(over: Partial<SodexRestCapture> = {}): SodexRestCapture {
  return {
    kind: "rest",
    startedAt: Date.now(),
    latencyMs: 50,
    method: "POST",
    url: "https://mainnet-gw.sodex.dev/api/v1/perps/trade/orders",
    requestHeaders: {},
    requestBody: '{"accountID":1,"orders":[{"clOrdID":"a1"}]}',
    signed: true,
    actionType: "newOrder",
    failure: null,
    errorDetail: null,
    httpStatus: 200,
    responseHeaders: null,
    responseText: OK_TEXT,
    orderResults: true,
    context: undefined,
    ...over,
  };
}
const timeout = () =>
  capture({ failure: "timeout", httpStatus: null, responseText: null, latencyMs: 5000 });

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

describe("SodexCallRecorder", () => {
  it("drops successful records first when full and never an error while an Ok record can go", () => {
    const warn = vi.fn();
    const r = recorder({ capacity: 3, log: { warn } });
    r.record(capture());
    r.record(capture());
    r.record(capture());
    r.record(capture()); // đầy: bản ghi thành công mới bị bỏ
    expect(r.dropped).toEqual({ ok: 1, problem: 0 });
    r.record(timeout()); // lỗi: đẩy một bản ghi thành công ra
    r.record(timeout());
    r.record(timeout());
    expect(r.queued).toBe(3);
    expect(r.dropped).toEqual({ ok: 4, problem: 0 });
    r.record(timeout()); // toàn lỗi: lúc này mới bỏ lỗi
    expect(r.dropped).toEqual({ ok: 4, problem: 1 });
    expect(warn).toHaveBeenCalledTimes(1); // log cảnh báo có giới hạn tần suất
    expect(warn.mock.calls[0]?.[1]).toBe("sodex debugger queue full: dropping records");
  });

  it("writes problems first, in batches, with redacted rows", async () => {
    const batches: SodexCallRow[][] = [];
    const r = recorder({
      batchSize: 2,
      sink: (rows) => {
        batches.push(rows);
        return Promise.resolve();
      },
    });
    r.record(capture());
    r.record(capture());
    r.record(timeout());
    await r.flush(); // một batch đầy; phần còn lại (< batchSize) đợi nhịp sau
    await r.flush();
    expect(batches.map((b) => b.map((x) => x.outcome))).toEqual([["timeout", "ok"], ["ok"]]);
    expect(r.queued).toBe(0);
  });

  it("keeps error records when the write fails and drops the Ok ones", async () => {
    const warn = vi.fn();
    const r = recorder({ sink: () => Promise.reject(new Error("db down")), log: { warn } });
    r.record(capture());
    r.record(timeout());
    await r.flush();
    expect(r.queued).toBe(1);
    expect(r.dropped.ok).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ rows: 2 }),
      "sodex debugger write failed",
    );
  });

  it("gives up on a hanging write after the flush timeout without blocking record()", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    let calls = 0;
    const r = recorder({
      flushTimeoutMs: 1_000,
      log: { warn },
      sink: () => {
        calls += 1;
        return new Promise(() => undefined); // DB treo mãi
      },
    });
    r.record(capture());
    const first = r.flush();
    await vi.advanceTimersByTimeAsync(10);
    // Flush đang treo: gọi lại không mở flush thứ hai, record vẫn nhận ngay.
    expect(r.flush()).toBe(first);
    r.record(capture());
    expect(r.queued).toBe(1);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    expect(warn).toHaveBeenCalledWith(expect.anything(), "sodex debugger write timed out");
  });

  it("never throws from record() even when classification would fail", async () => {
    const r = recorder();
    const bad = capture({ url: "not a url", responseText: "{" });
    expect(() => {
      r.record(bad);
    }).not.toThrow();
    await r.flush();
  });
});

const REQUEST: SignedWriteRequest = {
  path: "/perps/trade/orders",
  method: "POST",
  body: '{"accountID":1,"symbolID":2,"orders":[{"clOrdID":"a1"}]}',
  signature: `0x01${"ab".repeat(65)}`,
  nonce: 1n,
  // Không có tên key: bỏ hạn mức lệnh theo key để đo được nhiều lần (header X-API-Key được kiểm ở test redaction).
  orderCount: 1,
  actionType: "newOrder",
};

function writer(recorderImpl?: SodexCallRecorder) {
  return new SignedWriteClient({
    config: { restUrl: "https://mainnet-gw.sodex.dev", restWeightPerMinute: 1_000_000_000 },
    rateLimit: new MemoryRateLimitStore(),
    egressKey: "test",
    fetch: () => Promise.resolve(new Response(OK_TEXT, { status: 200 })),
    ...(recorderImpl === undefined ? {} : { recorder: recorderImpl }),
  });
}

describe("order path with the SoDEX Debugger", () => {
  it("returns the same result and stays as fast with a hanging DB writer", async () => {
    const hanging = recorder({
      capacity: 500, // nhỏ để phần lớn bản ghi bị bỏ trong lúc đo
      flushIntervalMs: 1,
      sink: () => new Promise(() => undefined),
    });
    const plain = writer();
    const recorded = writer(hanging);
    expect(await recorded.write(REQUEST)).toEqual(await plain.write(REQUEST));

    const N = 2_000;
    const time = async (c: SignedWriteClient) => {
      const t0 = performance.now();
      for (let i = 0; i < N; i += 1) await c.write(REQUEST);
      return performance.now() - t0;
    };
    // Khởi động JIT cho cả hai, rồi đo xen kẽ.
    await time(plain);
    await time(recorded);
    // Đo xen kẽ 5 vòng, lấy vòng nhanh nhất của mỗi bên để bớt nhiễu của máy.
    let base = Infinity;
    let withRecorder = Infinity;
    for (let round = 0; round < 5; round += 1) {
      base = Math.min(base, await time(plain));
      withRecorder = Math.min(withRecorder, await time(recorded));
    }
    const overheadPerCallMs = (withRecorder - base) / N;
    // Đẩy vào hàng đợi là O(1); cho phép nhiễu của máy CI nhưng chặn mọi I/O hay chờ trên đường gửi.
    expect(overheadPerCallMs).toBeLessThan(0.1);
    expect(hanging.queued).toBeLessThanOrEqual(500);
    expect(hanging.dropped.ok).toBeGreaterThan(0);
  });

  it("attaches the bot context and never puts the signature in the queue", async () => {
    const rows: SodexCallRow[] = [];
    const r = recorder({
      sink: (batch) => {
        rows.push(...batch);
        return Promise.resolve();
      },
    });
    await withSodexCallContext({ botId: "b1", accountId: "a1", traceId: "t1" }, () =>
      writer(r).write(REQUEST),
    );
    await r.flush();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      botId: "b1",
      accountId: "a1",
      traceId: "t1",
      clOrdIds: ["a1"],
    });
    expect(JSON.stringify(rows)).not.toContain("ab".repeat(65));
  });
});
