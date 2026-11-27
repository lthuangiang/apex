// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REWARDS_TOKEN_PREFIX,
  clearAllRewardsTokens,
  clearRewardsToken,
  readRewardsToken,
  saveRewardsToken,
  subscribeRewardsTokens,
} from "../token-store";

// DEC-401 (#584): token rewards ở localStorage theo ví tới khi `exp` hết hạn; quá hạn thì xoá lúc đọc; tab khác ghi /
// xoá thì báo qua sự kiện `storage`; token cũ trong sessionStorage bị dọn một lần; storage hỏng thì như chưa ký.

const MASTER = "0x3f2a000000000000000000000000000000009c4e";
const OTHER = "0x71b00000000000000000000000000000000022d1";

/** JWT giả (không chữ ký thật) với `exp` tính bằng giây. */
function fakeJwt(expSec: number): string {
  const payload = btoa(JSON.stringify({ exp: expSec, sub: "x" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `h.${payload}.s`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const keyOf = (a: string) => `${REWARDS_TOKEN_PREFIX}${a.toLowerCase()}`;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("token store in localStorage", () => {
  it("saves and reads per wallet (lowercase key) in localStorage, not sessionStorage", () => {
    const token = fakeJwt(nowSec() + 3600);
    saveRewardsToken(MASTER.toUpperCase().replace("0X", "0x"), token);
    expect(localStorage.getItem(keyOf(MASTER))).toBe(token);
    expect(sessionStorage.length).toBe(0);
    expect(readRewardsToken(MASTER)).toBe(token);
    expect(readRewardsToken(OTHER)).toBeNull();
    expect(readRewardsToken(null)).toBeNull();
    expect(readRewardsToken("")).toBeNull();
  });

  it("removes a token whose exp has passed and treats it as signed out", async () => {
    saveRewardsToken(MASTER, fakeJwt(nowSec() - 1));
    const listener = vi.fn();
    const off = subscribeRewardsTokens(listener);
    expect(readRewardsToken(MASTER)).toBeNull();
    expect(localStorage.getItem(keyOf(MASTER))).toBeNull();
    // Báo sau (không báo trong lúc render).
    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(listener).toHaveBeenCalled();
    off();
  });

  it("keeps a token that has not expired, or has no readable exp", () => {
    const live = fakeJwt(nowSec() + 60);
    saveRewardsToken(MASTER, live);
    expect(readRewardsToken(MASTER)).toBe(live);
    saveRewardsToken(OTHER, "fake-test-value");
    expect(readRewardsToken(OTHER)).toBe("fake-test-value");
  });

  it("clear one wallet and clear all only touch rewards keys", () => {
    saveRewardsToken(MASTER, "a");
    saveRewardsToken(OTHER, "b");
    localStorage.setItem("desklabs.rewards.seen.x", "keep");
    clearRewardsToken(MASTER);
    expect(readRewardsToken(MASTER)).toBeNull();
    expect(readRewardsToken(OTHER)).toBe("b");
    clearAllRewardsTokens();
    expect(readRewardsToken(OTHER)).toBeNull();
    expect(localStorage.getItem("desklabs.rewards.seen.x")).toBe("keep");
  });
});

describe("sync between tabs", () => {
  it("notifies on a storage event for a rewards key (sign-in or sign-out in another tab)", () => {
    const listener = vi.fn();
    const off = subscribeRewardsTokens(listener);
    window.dispatchEvent(
      new StorageEvent("storage", { key: keyOf(MASTER), newValue: "x", storageArea: localStorage }),
    );
    expect(listener).toHaveBeenCalledTimes(1);
    window.dispatchEvent(
      new StorageEvent("storage", { key: keyOf(MASTER), oldValue: "x", storageArea: localStorage }),
    );
    expect(listener).toHaveBeenCalledTimes(2);
    // localStorage.clear() ở tab khác: key null.
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
    expect(listener).toHaveBeenCalledTimes(3);
    // Key khác không liên quan.
    window.dispatchEvent(new StorageEvent("storage", { key: "theme", storageArea: localStorage }));
    expect(listener).toHaveBeenCalledTimes(3);
    off();
    window.dispatchEvent(new StorageEvent("storage", { key: keyOf(MASTER) }));
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe("legacy sessionStorage tokens", () => {
  it("are removed once on first use, not moved to localStorage", async () => {
    vi.resetModules();
    sessionStorage.setItem(keyOf(MASTER), "old-session-value");
    sessionStorage.setItem("unrelated", "keep");
    const store = await import("../token-store");
    expect(store.readRewardsToken(MASTER)).toBeNull();
    expect(sessionStorage.getItem(keyOf(MASTER))).toBeNull();
    expect(sessionStorage.getItem("unrelated")).toBe("keep");
    expect(localStorage.getItem(keyOf(MASTER))).toBeNull();
  });
});

describe("broken storage", () => {
  it("throwing Storage methods never break the page and read as signed out", () => {
    for (const m of ["getItem", "setItem", "removeItem", "key"] as const)
      vi.spyOn(Storage.prototype, m).mockImplementation(() => {
        throw new Error("blocked");
      });
    expect(() => {
      saveRewardsToken(MASTER, "fake-test-value");
    }).not.toThrow();
    expect(readRewardsToken(MASTER)).toBeNull();
    expect(() => {
      clearRewardsToken(MASTER);
    }).not.toThrow();
    expect(() => {
      clearAllRewardsTokens();
    }).not.toThrow();
  });

  it("a localStorage getter that throws reads as signed out", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => {
      saveRewardsToken(MASTER, "fake-test-value");
    }).not.toThrow();
    expect(readRewardsToken(MASTER)).toBeNull();
    expect(() => {
      clearAllRewardsTokens(MASTER);
    }).not.toThrow();
  });
});
