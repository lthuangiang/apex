import { MemoryRateLimitStore, type FetchLike, type SodexCallCapture } from "@drift/sodex";
import { describe, expect, it } from "vitest";

import { engineSodexClients } from "../src/sodex-clients";

// Đọc của engine không bao giờ rút cạn bucket IP của lệnh ghi (DEC-TBD-engine-rest-budget).

const ADDRESS = "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db";

describe("engine SoDEX clients", () => {
  it("skips reads once the IP bucket is down to the write reserve, while order writes still go out", async () => {
    let sent = 0;
    const fetch: FetchLike = (_url, init) => {
      sent += 1;
      const body =
        init.method === "GET"
          ? '{"code":0,"timestamp":1,"data":[]}'
          : '{"code":0,"timestamp":1,"data":[{"code":0,"clOrdID":"a1","orderID":7}]}';
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    // Bucket 100 weight / phút: mức dự trữ cho lệnh ghi = 30. Mỗi lần đọc lịch sử khớp = 20.
    const { orderPath, rest, reads, writer, takeSkipped } = engineSodexClients({
      config: { restUrl: "https://sodex.test", restWeightPerMinute: 100 },
      rateLimit: new MemoryRateLimitStore(() => 1_000),
      egressKey: "engine-test",
      fetch,
      readTimeoutMs: 3_000,
    });
    const q = { accountID: 1n, symbol: "BTC-USD", limit: 500 };
    let readsDone = 0;
    let refused = 0;
    for (let i = 0; i < 10; i += 1) {
      const client = i % 2 === 0 ? rest : reads;
      try {
        await client.getTrades("perps", ADDRESS, q);
        readsDone += 1;
      } catch {
        refused += 1;
      }
    }
    // 100 → 80 → 60 → 40: lần đọc thứ 4 phải để lại < 30 nên bị bỏ (không gửi).
    expect(readsDone).toBe(3);
    expect(refused).toBe(7);
    expect(sent).toBe(3);
    // Số lời gọi đọc bị phần dự trữ chặn (log mỗi phút), rồi về 0.
    expect(takeSkipped()).toBe(7);
    expect(takeSkipped()).toBe(0);
    // Đọc id symbol ngay trước khi gửi lệnh không bị phần dự trữ chặn.
    await orderPath.getPerpsSymbols();
    expect(sent).toBe(4);
    // Lệnh huỷ / đặt vẫn đi: phần dự trữ chỉ dành cho lệnh ghi.
    for (let i = 0; i < 5; i += 1) {
      const res = await writer.write({
        path: "/perps/trade/orders",
        method: "DELETE",
        body: "{}",
        signature: "0x01aa",
        nonce: BigInt(1_760_000_000_000 + i),
        apiKeyName: "DRIFT",
        orderCount: 1,
      });
      expect(res.outcome).toBe("ok");
    }
    expect(sent).toBe(9);
  });

  it("records every call of all four clients in the SoDEX Debugger (DEC-309)", async () => {
    const fetch: FetchLike = (_url, init) =>
      Promise.resolve(
        new Response(
          init.method === "GET"
            ? '{"code":0,"timestamp":1,"data":[]}'
            : '{"code":0,"timestamp":1,"data":[{"code":0,"clOrdID":"a1","orderID":7}]}',
          { status: 200 },
        ),
      );
    const seen: SodexCallCapture[] = [];
    const { orderPath, rest, reads, writer } = engineSodexClients({
      config: { restUrl: "https://sodex.test", restWeightPerMinute: 1_200 },
      rateLimit: new MemoryRateLimitStore(() => 1_000),
      egressKey: "engine-test",
      fetch,
      readTimeoutMs: 3_000,
      recorder: { record: (c) => seen.push(c) },
    });
    const q = { accountID: 1n, symbol: "BTC-USD", limit: 500 };
    await orderPath.getPerpsSymbols();
    await rest.getTrades("perps", ADDRESS, q);
    await reads.getTrades("perps", ADDRESS, q);
    await writer.write({
      path: "/perps/trade/orders",
      method: "DELETE",
      body: "{}",
      signature: "0x01aa",
      nonce: 1_760_000_000_000n,
      apiKeyName: "DRIFT",
      orderCount: 1,
    });
    expect(seen).toHaveLength(4);
  });
});
