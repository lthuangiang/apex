import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { idempotencyFingerprint } from "../src/lib/idempotency";
import {
  checkRewardsAud,
  readRewardsJwtClaims,
  rewardsTokenFingerprint,
} from "../src/modules/rewards-watch/claims";

// #558 (DEC-398): đọc claim JWT rewards trước khi lưu ở server. Token mẫu là chuỗi giả, không phải JWT thật.

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: Record<string, unknown>) =>
  `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
const NOW = Date.parse("2026-11-26T08:00:00Z");
const nowS = NOW / 1000;
const FIFTEEN_DAYS = 15 * 24 * 3600;

describe("readRewardsJwtClaims", () => {
  it("reads exp, iat, aud, iss and a short jti", () => {
    const claims = readRewardsJwtClaims(
      jwt({
        exp: nowS + FIFTEEN_DAYS,
        iat: nowS,
        aud: ["rewards", "lottery"],
        iss: "gw",
        jti: "abcdef1234567890",
        sid: "s",
      }),
      NOW,
    );
    expect(claims).toEqual({
      exp: nowS + FIFTEEN_DAYS,
      iat: nowS,
      aud: ["rewards", "lottery"],
      iss: "gw",
      jti8: "abcdef12",
    });
  });

  it("accepts a string aud", () => {
    const c = readRewardsJwtClaims(jwt({ exp: nowS + 7200, aud: "rewards" }), NOW);
    expect(c).toMatchObject({ aud: ["rewards"], iat: null, iss: null, jti8: null });
  });

  it("rejects malformed tokens, missing or near exp and long lifetimes", () => {
    expect(readRewardsJwtClaims("opaque", NOW)).toEqual({ problem: "malformed" });
    expect(readRewardsJwtClaims("a.@@@.c", NOW)).toEqual({ problem: "malformed" });
    expect(readRewardsJwtClaims(`${b64url({})}.${b64url([1])}.s`, NOW)).toEqual({
      problem: "malformed",
    });
    expect(readRewardsJwtClaims(jwt({ aud: "rewards" }), NOW)).toEqual({ problem: "no_exp" });
    expect(readRewardsJwtClaims(jwt({ exp: nowS + 1800 }), NOW)).toEqual({ problem: "expired" });
    expect(readRewardsJwtClaims(jwt({ exp: nowS - 10 }), NOW)).toEqual({ problem: "expired" });
    expect(readRewardsJwtClaims(jwt({ exp: nowS + 30 * 24 * 3600, iat: nowS }), NOW)).toEqual({
      problem: "lifetime_too_long",
    });
  });
});

describe("checkRewardsAud", () => {
  it("requires every aud value to be allowed; empty allowlist rejects everything", () => {
    expect(checkRewardsAud(["rewards"], ["rewards"])).toBeNull();
    expect(checkRewardsAud(["rewards", "lottery"], ["rewards", "lottery", "x"])).toBeNull();
    expect(checkRewardsAud(["rewards", "trade"], ["rewards"])).toBe("aud_not_allowed");
    expect(checkRewardsAud(["rewards"], [])).toBe("aud_not_allowed");
    expect(checkRewardsAud([], ["rewards"])).toBe("aud_missing");
  });
});

describe("idempotency fingerprint of POST /rewards/watch (plan 1.2)", () => {
  const address = "0x00000000000000000000000000000000000000AB";
  const payload = { exp: nowS + FIFTEEN_DAYS, iat: nowS, aud: ["rewards"], jti: "jti-marker-1" };
  const tokenA = `${b64url({ alg: "none" })}.${b64url(payload)}.c2lnLUE`;
  const tokenB = `${b64url({ alg: "none" })}.${b64url(payload)}.c2lnLUI`;
  const request = (token: string) =>
    ({
      method: "POST",
      url: "/api/v1/rewards/watch",
      routeOptions: { url: "/api/v1/rewards/watch" },
      params: {},
      body: { token, address },
    }) as unknown as FastifyRequest;

  it("summarises jti, exp, iat and the wallet, never the token", () => {
    const summary = rewardsTokenFingerprint(tokenA, address);
    expect(summary).toEqual({
      jti: "jti-marker-1",
      exp: payload.exp,
      iat: payload.iat,
      address: address.toLowerCase(),
    });
    const text = JSON.stringify(summary);
    for (const part of tokenA.split(".")) expect(text).not.toContain(part);
    expect(rewardsTokenFingerprint("opaque", address)).toEqual({
      jti: null,
      exp: null,
      iat: null,
      address: address.toLowerCase(),
    });
  });

  it("does not depend on the token itself: same claims, different signature, same hash", () => {
    const a = idempotencyFingerprint(
      request(tokenA),
      "u1",
      rewardsTokenFingerprint(tokenA, address),
    );
    const b = idempotencyFingerprint(
      request(tokenB),
      "u1",
      rewardsTokenFingerprint(tokenB, address),
    );
    expect(a).toBe(b);
    // Cách mặc định (băm body) thì phụ thuộc token: khác nhau.
    expect(idempotencyFingerprint(request(tokenA), "u1")).not.toBe(
      idempotencyFingerprint(request(tokenB), "u1"),
    );
    expect(a).not.toBe(idempotencyFingerprint(request(tokenA), "u1"));
  });
});
