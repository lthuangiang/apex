import { describe, expect, it } from "vitest";

import { BookCoalescer } from "../src/book-coalescer";

// DEC-298: hàng chờ giá tốt nhất SoDEX không dồn tin cũ.
describe("BookCoalescer", () => {
  it("handles only the newest waiting message per market, with its own receive time", async () => {
    const seen: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const c = new BookCoalescer<string>(
      async (msg, recvAt) => {
        seen.push(`${msg}@${String(recvAt)}`);
        if (msg === "a1") await gate;
      },
      () => undefined,
    );
    c.push("ETH", "a1", 1);
    c.push("ETH", "a2", 2);
    c.push("ETH", "a3", 3);
    // Market khác không chờ ETH.
    c.push("BTC", "b1", 4);
    expect(seen).toEqual(["a1@1", "b1@4"]);
    release();
    await c.idle();
    expect(seen).toEqual(["a1@1", "b1@4", "a3@3"]);
  });

  it("keeps going after a handler error", async () => {
    const errors: unknown[] = [];
    const seen: string[] = [];
    const c = new BookCoalescer<string>(
      (msg) => {
        seen.push(msg);
        return msg === "x" ? Promise.reject(new Error("boom")) : Promise.resolve();
      },
      (e) => errors.push(e),
    );
    c.push("ETH", "x", 1);
    await c.idle();
    c.push("ETH", "y", 2);
    await c.idle();
    expect(seen).toEqual(["x", "y"]);
    expect(errors).toHaveLength(1);
  });
});
