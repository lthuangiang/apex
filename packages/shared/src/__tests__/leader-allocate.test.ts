import { describe, expect, it } from "vitest";

import { allocateCopy, depthWithin, type BookLevel } from "../leader-stats";

// DEC-163 mục 9: tổng copy ≤ 50% độ sâu sổ SoDEX phía đối diện trong khoảng Max price move.

const asks: BookLevel[] = [
  ["100", "10"], // 1.000
  ["100.2", "10"], // 1.002
  ["101", "100"], // ngoài 0,3%
];

describe("depthWithin", () => {
  it("counts only levels inside the price window on the side a buy would take", () => {
    expect(depthWithin(asks, "buy", "100", "0.3").toString()).toBe("2002");
    expect(
      depthWithin(
        [
          ["99.8", "10"],
          ["99", "10"],
        ],
        "sell",
        "100",
        "0.3",
      ).toString(),
    ).toBe("998");
  });
});

describe("allocateCopy", () => {
  it("returns no allowances when every copy fits in half the depth", () => {
    expect(
      allocateCopy(
        [
          { botId: "a", desired: "500", maxSlippagePct: "0.3" },
          { botId: "b", desired: "500", maxSlippagePct: "0.3" },
        ],
        asks,
        "buy",
        "100",
      ),
    ).toBeNull();
  });

  it("scales every bot down in proportion when copies exceed half the depth", () => {
    // Một nửa 2.002 = 1.001; nhu cầu 3.000 → tỷ lệ 0,333…
    expect(
      allocateCopy(
        [
          { botId: "a", desired: "2000", maxSlippagePct: "0.3" },
          { botId: "b", desired: "1000", maxSlippagePct: "0.5" },
        ],
        asks,
        "buy",
        "100",
      ),
    ).toEqual({ a: "667.33", b: "333.66" });
  });

  it("measures depth with the tightest price window among the bots", () => {
    const r = allocateCopy(
      [
        { botId: "a", desired: "800", maxSlippagePct: "0.1" },
        { botId: "b", desired: "800", maxSlippagePct: "2" },
      ],
      asks,
      "buy",
      "100",
    );
    // 0,1% chỉ thấy mức 100 (1.000) → trần 500.
    expect(r).toEqual({ a: "250", b: "250" });
  });

  it("gives nothing when the book is empty in the window", () => {
    expect(
      allocateCopy([{ botId: "a", desired: "100", maxSlippagePct: "0.3" }], [], "buy", "100"),
    ).toEqual({ a: "0" });
  });
});
