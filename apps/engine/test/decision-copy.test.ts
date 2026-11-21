import { isNotSentReject } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { NO_REAL_POSITION, unknownGaveUpWhy } from "../src/engine";

// #260: câu Decisions không khẳng định điều DeskLabs chưa kiểm (quy tắc 1.8).

describe("Decisions copy (#260)", () => {
  it("given-up unknown order: written before trades are read, so it never claims there are no trades", () => {
    const why = unknownGaveUpWhy("vf:3:in:0");
    expect(why).toBe(
      "vf:3:in:0: SoDEX accepted it, but it is no longer in the order history, so DeskLabs can't confirm how much of it filled. Check this bot's position on SoDEX.",
    );
    expect(why).not.toMatch(/no trades/);
  });

  it("the reduce-only order the engine drops for a zero real position counts as never sent", () => {
    expect(isNotSentReject(NO_REAL_POSITION)).toBe(true);
  });
});
