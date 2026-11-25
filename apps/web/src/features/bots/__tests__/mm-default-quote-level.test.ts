import { VM_NEW_BOT_QUOTE_LEVEL } from "@drift/strategies/client";
import { describe, expect, it } from "vitest";

import { emptyValues, fromConfig } from "../fields";

// #536 (DEC-395): bot Market Making MỚI mặc định "Where to quote" = 2; màn Edit giữ giá trị đã lưu, config cũ thiếu
// `quoteLevel` (báo giá theo distanceBp) vẫn hiện 0 như trước.

describe("Market Making Where to quote default (#536)", () => {
  it("a new bot starts at 2 ticks back", () => {
    expect(VM_NEW_BOT_QUOTE_LEVEL).toBe(2);
    expect(emptyValues("volume_maker").quoteLevel).toBe("2");
  });

  it("Edit of an old config without quoteLevel still shows 0, not the new-bot default", () => {
    const old = {
      market: "BTC-USD",
      orderSize: "20",
      distanceBp: "1",
      costBudget: "10",
      maxOrders: 1,
    };
    expect(fromConfig("volume_maker", old).quoteLevel).toBe("0");
  });

  it("Edit keeps the saved value (0 stays 0, 3 stays 3)", () => {
    const base = { market: "BTC-USD", orderSize: "20", costBudget: "10", maxOrders: 1 };
    expect(fromConfig("volume_maker", { ...base, quoteLevel: 0 }).quoteLevel).toBe("0");
    expect(fromConfig("volume_maker", { ...base, quoteLevel: 3 }).quoteLevel).toBe("3");
  });
});
