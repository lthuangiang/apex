import { describe, expect, it } from "vitest";

import {
  decisionDisplayName,
  LEGACY_STOP_DECISIONS,
  MARKET_MAKING_STOPPED,
  MARKET_MAKING_STOPPED_ALL,
  VOLUME_BUILDER_STOPPED,
} from "../api/bots";

// #463: câu Decisions khi chiến lược tự dừng dùng tên sản phẩm; dòng cũ giữ text, chỗ hiển thị / trả ra đổi sang tên mới.

describe("stop decision names (#463)", () => {
  it("maps the old stored names to the product names and leaves the rest alone", () => {
    expect(VOLUME_BUILDER_STOPPED).toBe("Volume Builder stopped");
    expect(MARKET_MAKING_STOPPED).toBe("Market Making stopped");
    expect(decisionDisplayName("Volume Farm stopped")).toBe("Volume Builder stopped");
    expect(decisionDisplayName("Volume Maker stopped")).toBe("Market Making stopped");
    expect(decisionDisplayName("Market Making stopped")).toBe("Market Making stopped");
    expect(decisionDisplayName("Enter long")).toBe("Enter long");
    expect(decisionDisplayName(null)).toBeNull();
    expect(Object.keys(LEGACY_STOP_DECISIONS)).toEqual([
      "Volume Farm stopped",
      "Volume Maker stopped",
    ]);
  });

  it("lists both the new and the old Market Making stop name for text lookups", () => {
    expect(MARKET_MAKING_STOPPED_ALL).toEqual(["Market Making stopped", "Volume Maker stopped"]);
  });
});
