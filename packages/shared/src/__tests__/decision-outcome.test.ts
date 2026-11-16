import { describe, expect, it } from "vitest";

import { decisionOutcome, NORMAL_REJECT_CODES, outcomeOrder } from "../api/bots";

// BD-02: kết quả của một quyết định theo trạng thái thật của các lệnh nó đặt. BD-05: mã reject bình thường.

const o = (status: string, filledSize = "0") => ({ status, filledSize });

describe("decision outcome (BD-02)", () => {
  it("is unknown to the page (null) when no order was found", () => {
    expect(decisionOutcome([])).toBeNull();
  });

  it("says Filled only when every order filled, Partially filled otherwise", () => {
    expect(decisionOutcome([o("filled", "1")])).toBe("filled");
    expect(decisionOutcome([o("filled", "1"), o("filled", "2")])).toBe("filled");
    expect(decisionOutcome([o("partially_filled", "0.5")])).toBe("partly_filled");
    expect(decisionOutcome([o("filled", "1"), o("cancelled")])).toBe("partly_filled");
    // Huỷ sau khi đã khớp một phần vẫn là đã khớp một phần.
    expect(decisionOutcome([o("cancelled", "0.2")])).toBe("partly_filled");
  });

  it("orders the rest Open, Unknown, Cancelled, Rejected, Not placed", () => {
    expect(decisionOutcome([o("open"), o("rejected")])).toBe("open");
    expect(decisionOutcome([o("unknown"), o("cancelled")])).toBe("unknown");
    expect(decisionOutcome([o("cancelled"), o("rejected")])).toBe("cancelled");
    expect(decisionOutcome([o("rejected"), o("not_placed")])).toBe("rejected");
    expect(decisionOutcome([o("not_placed")])).toBe("not_placed");
  });

  it("says Unknown whenever an order is unknown, even next to a fill (it may have filled)", () => {
    expect(decisionOutcome([o("filled", "1"), o("unknown")])).toBe("unknown");
    expect(decisionOutcome([o("open"), o("unknown")])).toBe("unknown");
  });

  it("never says Filled when some of the decision's orders are missing", () => {
    // Quyết định đặt 2 lệnh, chỉ tìm thấy 1 (đã khớp đủ).
    expect(decisionOutcome([o("filled", "1")], 2)).toBe("partly_filled");
    expect(decisionOutcome([o("filled", "1")], 1)).toBe("filled");
  });
});

describe("normal reject codes (BD-05)", () => {
  it("are SoDEX's post-only cross and self-trade block, nothing else", () => {
    expect(Object.values(NORMAL_REJECT_CODES).sort()).toEqual(["PostOnly", "SELF_TRADE_BLOCKED"]);
  });
});

describe("outcome order (BD-02 links)", () => {
  const p = (clOrdId: string, status: string, filledSize = "0") => ({
    clOrdId,
    status,
    filledSize,
  });
  it("links to the order that matches the outcome, else the first one", () => {
    const list = [p("a", "cancelled"), p("b", "filled", "1"), p("c", "unknown")];
    expect(outcomeOrder(list, "unknown")).toBe("c");
    expect(outcomeOrder(list, "partly_filled")).toBe("b");
    expect(outcomeOrder([p("a", "cancelled"), p("b", "partially_filled")], "open")).toBe("b");
    expect(outcomeOrder([p("a", "cancelled")], "rejected")).toBe("a");
  });
  it("is null without orders or outcome", () => {
    expect(outcomeOrder([], "filled")).toBeNull();
    expect(outcomeOrder([p("a", "filled", "1")], null)).toBeNull();
  });
});
