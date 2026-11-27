// @vitest-environment jsdom
import { SODEX_REWARDS_DEFAULT_ORIGIN } from "@drift/shared";
import { UserRejectedRequestError } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetRewardsRateLimit } from "../client";
import { signInToRewards } from "../sign-in";
import {
  clearAllRewardsTokens,
  clearRewardsToken,
  readRewardsToken,
  REWARDS_TOKEN_PREFIX,
  saveRewardsToken,
} from "../token-store";

import { bodyOf, urlOf } from "./fetch-helpers";

// Đăng nhập rewards (#547): sai ví thì không ký, token lưu / xoá đúng. Ví, chữ ký và token đều giả.

const MASTER = "0x3f2a000000000000000000000000000000009c4e";
const OTHER = "0x71b00000000000000000000000000000000022d1";
const CHALLENGE = "sodex.com wants you to sign in\n\n  Nonce: abc  \nIssued At: 2026-11-26";
const FAKE_SIG = "0xsig";
const FAKE_TOKEN = "fake-test-value";

function gateway() {
  return vi.fn<typeof fetch>((input) => {
    const url = urlOf(input);
    const data = url.endsWith("/auth/nonce") ? { message: CHALLENGE } : { accessToken: FAKE_TOKEN };
    return Promise.resolve(
      new Response(JSON.stringify({ code: 0, msg: "success", data }), { status: 200 }),
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", gateway());
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetRewardsRateLimit();
});

describe("signInToRewards", () => {
  it("wrong wallet: asks for nothing and signs nothing", async () => {
    const signMessage = vi.fn(() => Promise.resolve(FAKE_SIG));
    const r = await signInToRewards({ master: MASTER, connected: OTHER, signMessage });
    expect(r).toEqual({ kind: "wrong_wallet", connected: OTHER });
    expect(signMessage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(readRewardsToken(MASTER)).toBeNull();
  });

  it("no SoDEX account or no wallet: stops before any request, never opens a wallet", async () => {
    const signMessage = vi.fn(() => Promise.resolve(FAKE_SIG));
    expect(await signInToRewards({ master: null, connected: MASTER, signMessage })).toEqual({
      kind: "no_sodex",
    });
    expect(await signInToRewards({ master: MASTER, connected: undefined, signMessage })).toEqual({
      kind: "no_wallet",
    });
    expect(signMessage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("signs the exact challenge, verifies with autoSign false and keeps the token per wallet", async () => {
    const signMessage = vi.fn(() => Promise.resolve(FAKE_SIG));
    // Khác hoa thường vẫn là cùng ví.
    const r = await signInToRewards({
      master: MASTER,
      connected: MASTER.toUpperCase().replace("0X", "0x"),
      signMessage,
    });
    expect(r).toEqual({ kind: "signed_in" });
    expect(signMessage).toHaveBeenCalledWith({
      account: MASTER.toUpperCase().replace("0X", "0x"),
      message: CHALLENGE,
    });
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.map(([u]) => urlOf(u))).toEqual([
      `${SODEX_REWARDS_DEFAULT_ORIGIN}/api/v1/auth/nonce`,
      `${SODEX_REWARDS_DEFAULT_ORIGIN}/api/v1/auth/verify`,
    ]);
    expect(JSON.parse(bodyOf(calls[0]?.[1]))).toEqual({ address: MASTER, type: "sign_in" });
    expect(JSON.parse(bodyOf(calls[1]?.[1]))).toEqual({
      address: MASTER,
      type: "sign_in",
      message: CHALLENGE,
      signature: FAKE_SIG,
      autoSign: false,
    });
    expect(readRewardsToken(MASTER)).toBe(FAKE_TOKEN);
    expect(localStorage.getItem(`${REWARDS_TOKEN_PREFIX}${MASTER}`)).toBe(FAKE_TOKEN);
    // DEC-401: chỉ localStorage, không còn bản trong sessionStorage.
    expect(sessionStorage.length).toBe(0);
  });

  it("rejected in the wallet: no verify, no token", async () => {
    const signMessage = vi.fn(() =>
      Promise.reject(new UserRejectedRequestError(new Error("User rejected"))),
    );
    expect(await signInToRewards({ master: MASTER, connected: MASTER, signMessage })).toEqual({
      kind: "rejected",
    });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    expect(readRewardsToken(MASTER)).toBeNull();
  });
});

describe("token store", () => {
  it("clears one wallet, or all except one", () => {
    saveRewardsToken(MASTER, "a");
    saveRewardsToken(OTHER, "b");
    localStorage.setItem("unrelated", "keep");
    clearAllRewardsTokens(MASTER);
    expect(readRewardsToken(MASTER)).toBe("a");
    expect(readRewardsToken(OTHER)).toBeNull();
    clearRewardsToken(MASTER);
    expect(readRewardsToken(MASTER)).toBeNull();
    saveRewardsToken(OTHER, "b");
    clearAllRewardsTokens();
    expect(readRewardsToken(OTHER)).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });

  it("treats blocked storage as signed out", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readRewardsToken(MASTER)).toBeNull();
    spy.mockRestore();
  });
});
