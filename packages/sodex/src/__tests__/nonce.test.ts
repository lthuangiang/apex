import { describe, expect, it } from "vitest";

import { MonotonicNonceSource } from "../signing/nonce";

const A = "0x1563915e194D8CfBA1943570603F7606A3115508";
const B = "0x3d4595c8742d0a58173a9963c05755b59a8f8256";

describe("MonotonicNonceSource", () => {
  it("uses the clock and stays strictly increasing within the same ms", () => {
    const nonces = new MonotonicNonceSource(() => 1_760_373_925_000);
    expect([nonces.next(A), nonces.next(A), nonces.next(A)]).toEqual([
      1_760_373_925_000n,
      1_760_373_925_001n,
      1_760_373_925_002n,
    ]);
  });

  it("tracks each address separately", () => {
    const nonces = new MonotonicNonceSource(() => 1000);
    nonces.next(A);
    nonces.next(A);
    expect(nonces.next(B)).toBe(1000n);
  });

  it("does not go backwards when the clock does", () => {
    let now = 5000;
    const nonces = new MonotonicNonceSource(() => now);
    nonces.next(A);
    now = 4000;
    expect(nonces.next(A)).toBe(5001n);
  });

  it("throws instead of reusing a nonce at the upper window edge", () => {
    const day = 24 * 60 * 60 * 1000;
    let now = 2 * day;
    const nonces = new MonotonicNonceSource(() => now);
    nonces.next(A);
    now = day + 1; // đồng hồ lùi gần một ngày: nonce kế tiếp = 2 ngày + 1 ≥ now + 1 ngày
    expect(() => nonces.next(A)).toThrow(RangeError);
  });
});
