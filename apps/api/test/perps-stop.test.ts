import { AppError } from "@drift/shared";
import { gridStopLimits } from "@drift/strategies";
import { describe, expect, it } from "vitest";

import { assertPerpsStop } from "../src/modules/bots/service";

// Stop phải nằm trước giá thanh lý (isolated, hệ số 90%) cho Futures DCA / AI Adaptive DCA / Futures Grid; Futures Grid
// Short / Neutral bắt buộc Stop above (DEC-237).

const errors = (strategy: string, config: Record<string, unknown>) => {
  try {
    assertPerpsStop(strategy, config);
    return {};
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return (e.details as { fieldErrors: Record<string, string[]> }).fieldErrors;
  }
};

describe("perps stop vs liquidation", () => {
  it("blocks a Futures DCA / AI Adaptive DCA stop past 90% of the isolated liquidation distance", () => {
    expect(
      errors("futures_dca", { marginMode: "isolated", leverage: 20, stopLossPct: "12" }),
    ).toEqual({ stopLossPct: ["Past liquidation at 20× isolated. Use below 4.5%."] });
    expect(
      errors("futures_dca", { marginMode: "isolated", leverage: 20, stopLossPct: "4" }),
    ).toEqual({});
    expect(
      errors("adaptive_dca", { marginMode: "isolated", leverage: 10, hardStopLossPct: "9" }),
    ).toEqual({ hardStopLossPct: ["Past liquidation at 10× isolated. Use below 9%."] });
    // Cross: không chặn (web cảnh báo).
    expect(errors("futures_dca", { marginMode: "cross", leverage: 20, stopLossPct: "12" })).toEqual(
      {},
    );
  });

  it("limits a Futures Grid stop so the loss with every opening level filled stays within 90% of margin", () => {
    const grid = {
      marginMode: "isolated",
      leverage: 10,
      margin: "100",
      lowerPrice: "90",
      upperPrice: "110",
      gridLevels: 5,
      spacing: "arithmetic",
    };
    // Mức 90..110, mỗi mức 2 (1.000 / 5 / 100). Long: 4 mức dưới, TB 97,5, Q 8 → 97,5 − 90 / 8 = 86,25.
    const lim = gridStopLimits({ ...grid, direction: "neutral" }, 10);
    expect(lim.below?.toString()).toBe("86.25");
    // Short: 4 mức trên, TB 102,5 → 102,5 + 11,25 = 113,75.
    expect(lim.above?.toString()).toBe("113.75");
    expect(errors("futures_grid", { ...grid, direction: "long", stopBelow: "86" })).toEqual({
      stopBelow: ["Past liquidation at 10× isolated. Use above 86.25."],
    });
    expect(errors("futures_grid", { ...grid, direction: "long", stopBelow: "87" })).toEqual({});
    expect(
      errors("futures_grid", { ...grid, direction: "short", stopBelow: "80", stopAbove: "114" }),
    ).toEqual({ stopAbove: ["Past liquidation at 10× isolated. Use below 113.75."] });
  });

  it("requires Stop above for a Short or Neutral Futures Grid, even with cross margin", () => {
    for (const direction of ["short", "neutral"])
      expect(
        errors("futures_grid", {
          direction,
          marginMode: "cross",
          leverage: 3,
          stopBelow: "80",
        }),
      ).toEqual({ stopAbove: ["Required."] });
    expect(
      errors("futures_grid", {
        direction: "long",
        marginMode: "cross",
        leverage: 3,
        stopBelow: "80",
      }),
    ).toEqual({});
  });
});
