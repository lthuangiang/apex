import { DESK_ITEM_RULES } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { briefNeedsLine } from "../src/modules/desk/ai";

// Prompt báo cáo sáng của AI Desk nhận mọi loại việc Needs you, gồm `bot_needs_attention` (#472).

describe("morning brief needs line", () => {
  it("has a sentence for every rule, including bot_needs_attention", () => {
    for (const rule of DESK_ITEM_RULES) {
      const line = briefNeedsLine([{ botId: "b1", botName: "Bot", rule }]);
      expect(line.startsWith('"Bot" ')).toBe(true);
      expect(line.length).toBeGreaterThan('"Bot" '.length);
    }
    expect(
      briefNeedsLine([{ botId: "b1", botName: "Stock Monitor", rule: "bot_needs_attention" }]),
    ).toBe('"Stock Monitor" needs the user\'s attention: check its recent decisions');
  });

  it("says nothing needs the user when there is no item", () => {
    expect(briefNeedsLine([])).toBe("Nothing needs the user today.");
  });
});
