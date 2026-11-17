import { afterEach, describe, expect, it, vi } from "vitest";

import type { SodexRestCapture } from "../debug/capture";
import type { SodexCallRow } from "../debug/classify";
import { withSodexCallContext } from "../debug/context";
import { SodexCallRecorder } from "../debug/recorder";
import { MemoryRateLimitStore } from "../rate-limit/token-bucket";
import { SignedWriteClient, type SignedWriteRequest } from "../rest/signed-write";

import { restCapture } from "./debug-fixtures";

// Hàng đợi của SoDEX Debugger: không bao giờ chặn đường gửi lệnh; đầy thì bỏ bản ghi thành công trước.

const OK_TEXT = '{"code":0,"timestamp":1,"data":[{"code":0,"clOrdID":"a1","orderID":7}]}';

function capture(over: Partial<SodexRestCapture> = {}): SodexRestCapture {
  return restCapture({
    latencyMs: 50,
    method: "POST",
    requestBody: '{"accountID":1,"orders":[{"clOrdID":"a1"}]}',
    actionType: "newOrder",
    responseText: OK_TEXT,
    ...over,
  });
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
    expect(r.dropped).toMatchObject({ ok: 1, problem: 0 });
    r.record(timeout()); // lỗi: đẩy một bản ghi thành công ra
    r.record(timeout());
    r.record(timeout());
    expect(r.queued).toBe(3);
    expect(r.dropped).toMatchObject({ ok: 4, problem: 0 });
    r.record(timeout()); // toàn lỗi: lúc này mới bỏ lỗi
    expect(r.dropped).toMatchObject({ ok: 4, problem: 1 });
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
  it("returns the same results, never waits on the writer, and stays bounded while the DB write hangs", async () => {
    let sinkCalls = 0;
    const hanging = recorder({
      capacity: 500, // nhỏ để phần lớn bản ghi bị bỏ
      flushIntervalMs: 1,
      sink: () => {
        sinkCalls += 1;
        return new Promise(() => undefined);
      },
    });
    const plain = writer();
    const recorded = writer(hanging);
    hanging.record(capture());
    void hanging.flush(); // một lần ghi treo mãi
    await vi.waitFor(() => {
      expect(sinkCalls).toBe(1);
    });
    // Không đo thời gian (dễ nhiễu): kiểm hành vi. Mỗi write xong mà không phụ thuộc sink, kết quả giống hệt.
    for (let i = 0; i < 2_000; i += 1) {
      expect(await recorded.write(REQUEST)).toEqual(await plain.write(REQUEST));
    }
    // record() đồng bộ: gọi trực tiếp không trả Promise và không gọi sink.
    const before = sinkCalls;
    hanging.record(capture());
    expect(sinkCalls).toBe(before);
    expect(hanging.queued).toBeLessThanOrEqual(500);
    expect(hanging.dropped.ok).toBeGreaterThan(0);
    // Chỉ một lần ghi treo cùng lúc, không chồng.
    expect(sinkCalls).toBe(1);
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
