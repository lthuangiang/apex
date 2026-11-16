import { describe, expect, it } from "vitest";

import { MID_KEEP_MS, MM_KEEP_MS } from "../mm-cost-store";

// Thời gian giữ dữ liệu chi phí làm market (DEC-278, thay phần retention của DEC-227): `mm_market_hourly`
// 90 ngày để team Ops so chi phí theo giờ trong ngày; `mid_1s` vẫn 48 giờ.

describe("market making data retention", () => {
  it("keeps hourly market cost 90 days and per-second mids 48 hours", () => {
    expect(MM_KEEP_MS).toBe(90 * 24 * 3_600_000);
    expect(MID_KEEP_MS).toBe(48 * 3_600_000);
  });
});
