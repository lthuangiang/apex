import { describe, expect, it, vi } from "vitest";

import type { SignerApi } from "../src/http-gateway";
import { withLastUsed } from "../src/last-used";

const input = {
  apiKeyId: "k1",
  domain: "spot" as const,
  payloadHash: "0x01" as const,
  nonce: "1",
  shard: 0,
  epoch: 1,
};

describe("withLastUsed", () => {
  it("records a successful sign, at most once per interval per key", async () => {
    let t = 1_000;
    const touch = vi.fn<(id: string, at: Date) => Promise<void>>(() => Promise.resolve());
    const s = withLastUsed({ sign: () => Promise.resolve("0xsig") }, touch, {
      now: () => t,
      everyMs: 60_000,
    });
    await expect(s.sign(input)).resolves.toBe("0xsig");
    t += 30_000;
    await s.sign(input);
    await s.sign({ ...input, apiKeyId: "k2" });
    t += 31_000;
    await s.sign(input);
    expect(touch.mock.calls.map((c) => c[0])).toEqual(["k1", "k2", "k1"]);
  });

  it("does not record a failed sign", async () => {
    const touch = vi.fn<(id: string, at: Date) => Promise<void>>(() => Promise.resolve());
    const failing: SignerApi = { sign: () => Promise.reject(new Error("no")) };
    await expect(withLastUsed(failing, touch).sign(input)).rejects.toThrow("no");
    expect(touch).not.toHaveBeenCalled();
  });

  it("a failed write does not fail the sign", async () => {
    const onError = vi.fn();
    const s = withLastUsed(
      { sign: () => Promise.resolve("0xsig") },
      () => Promise.reject(new Error("db")),
      { onError },
    );
    await expect(s.sign(input)).resolves.toBe("0xsig");
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalled();
  });
});
