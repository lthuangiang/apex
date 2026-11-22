/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BOT_KEY,
  initialMode,
  loadMode,
  MODE_KEY,
  pickBot,
  readStored,
  writeStored,
} from "../research/mode-memory";

// #457: thứ tự chế độ (query → localStorage → Paper), storage lỗi / rỗng, bot đã nhớ không còn trong danh sách.

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/signal-research");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("initialMode", () => {
  it("query first, then the remembered mode, then Paper", () => {
    expect(initialMode("?bots=mainnet", "paper")).toBe("mainnet");
    expect(initialMode("?bots=paper", "mainnet")).toBe("paper");
    expect(initialMode("", "mainnet")).toBe("mainnet");
    expect(initialMode("", null)).toBe("paper");
  });

  it("ignores junk in the query and in storage", () => {
    expect(initialMode("?bots=live", "mainnet")).toBe("mainnet");
    expect(initialMode("?bots=", "junk")).toBe("paper");
  });
});

describe("loadMode", () => {
  it("reads the URL and localStorage", () => {
    window.localStorage.setItem(MODE_KEY, "mainnet");
    expect(loadMode()).toBe("mainnet");
    window.history.replaceState(null, "", "/signal-research?bots=paper");
    expect(loadMode()).toBe("paper");
  });

  it("is Paper when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(loadMode()).toBe("paper");
  });
});

describe("readStored / writeStored", () => {
  it("round-trips and removes", () => {
    writeStored(BOT_KEY, "b1");
    expect(readStored(BOT_KEY)).toBe("b1");
    writeStored(BOT_KEY, null);
    expect(readStored(BOT_KEY)).toBeNull();
  });

  it("never throws when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(readStored(MODE_KEY)).toBeNull();
    expect(() => {
      writeStored(MODE_KEY, "mainnet");
    }).not.toThrow();
  });
});

describe("pickBot", () => {
  const bots = [{ id: "a" }, { id: "b" }];
  it("keeps the remembered bot when it is still listed", () => {
    expect(pickBot(bots, "b")?.id).toBe("b");
  });
  it("falls back to the first bot when the remembered one is gone", () => {
    expect(pickBot(bots, "deleted")?.id).toBe("a");
    expect(pickBot(bots, null)?.id).toBe("a");
  });
  it("is null with no bots", () => {
    expect(pickBot([], "a")).toBeNull();
  });
});
