import { describe, expect, it } from "vitest";

import { friendlyFieldErrors } from "../field-errors";

describe("field errors from the server (C6)", () => {
  it("replaces zod's default messages with a readable one and keeps spec messages", () => {
    expect(
      friendlyFieldErrors(
        {
          maxLoss: ["Expected a decimal string", "Invalid string: must match pattern /^-?\\d+$/"],
          perpLeverage: ["Invalid input: expected number, received string"],
          lowerPrice: ["Must be below the upper price."],
        },
        "Enter a valid value.",
      ),
    ).toEqual({
      maxLoss: ["Enter a valid value."],
      perpLeverage: ["Enter a valid value."],
      lowerPrice: ["Must be below the upper price."],
    });
  });
});
