import { describe, expect, it } from "vitest";

import messages from "../../../../messages/en.json";
import { rejectBreakdown } from "../reject-text";

// BD-05: số lệnh bị từ chối được giải thích theo loại; post-only cross là bình thường; giới hạn rủi ro của DeskLabs ghi
// riêng (không phải SoDEX từ chối).

// Câu mẫu đúng như en.json (chỉ có {n}).
const t = (key: "postOnly" | "selfTrade" | "riskLimit" | "other", v: { n: number }) =>
  messages.agent.rejects[key].replace("{n}", String(v.n));

describe("reject breakdown (BD-05)", () => {
  it("keeps the old line when nothing was rejected", () => {
    expect(rejectBreakdown(t, 0, { postOnly: 0, selfTrade: 0, riskLimit: 0 })).toBeNull();
  });

  it("splits post-only crosses, self-trade blocks, risk-limit blocks and other reasons", () => {
    expect(rejectBreakdown(t, 2050, { postOnly: 2000, selfTrade: 23, riskLimit: 4 })).toBe(
      "2000 would have crossed the book (normal for post-only) · 23 blocked to avoid trading with yourself · 4 blocked by your risk limits · 23 refused for other reasons",
    );
    expect(rejectBreakdown(t, 113, { postOnly: 113, selfTrade: 0, riskLimit: 0 })).toBe(
      "113 would have crossed the book (normal for post-only)",
    );
    expect(rejectBreakdown(t, 5, { postOnly: 0, selfTrade: 0, riskLimit: 0 })).toBe(
      "5 refused for other reasons",
    );
  });

  it("uses the app's order status wording for each decision outcome", () => {
    expect(Object.values(messages.agent.outcomes)).toEqual([
      "Filled",
      "Partially filled",
      "Open",
      "Cancelled",
      "Rejected",
      "Unknown",
      "Not placed",
    ]);
  });
});
