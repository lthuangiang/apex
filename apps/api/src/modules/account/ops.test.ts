import { describe, expect, it } from "vitest";

import { parseOrderRequests, untrackedCount } from "./ops";

// Trang Ops (DEC-276): số đọc từ dòng Decisions có sẵn; dòng không đúng mẫu → null / 0, không đoán.

describe("team ops parsing", () => {
  it("reads requests per minute and the longest quoting gap from the Order requests line", () => {
    expect(
      parseOrderRequests(
        "Last 61 s: 40 requests to SoDEX (new orders and cancels). Longest gap between quotes: 3.0 s.",
      ),
    ).toEqual({ perMinute: "39.3", gapSec: "3.0" });
    // Dòng cũ (trước khi có khoảng dài nhất): chỉ có số request.
    expect(parseOrderRequests("Last 60 s: 30 requests to SoDEX (new orders and cancels).")).toEqual(
      { perMinute: "30", gapSec: null },
    );
    expect(parseOrderRequests(null)).toEqual({ perMinute: null, gapSec: null });
    expect(parseOrderRequests("something else")).toEqual({ perMinute: null, gapSec: null });
  });

  it("counts cancelled untracked orders from the event title", () => {
    expect(untrackedCount("Cancelled 3 untracked orders")).toBe(3);
    expect(untrackedCount("Cancelled 1 untracked order")).toBe(1);
    expect(untrackedCount("Position cut")).toBe(0);
    expect(untrackedCount(null)).toBe(0);
  });
});
