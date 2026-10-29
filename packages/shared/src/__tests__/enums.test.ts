import { describe, expect, it } from "vitest";

import { assertNever } from "../assert";
import {
  BotState,
  REASON_CODE_META,
  ReasonCode,
  ReasonScope,
  isTransitionalBotState,
} from "../enums";

describe("enums", () => {
  it("marks only in-flight states as transitional", () => {
    expect(isTransitionalBotState(BotState.starting)).toBe(true);
    expect(isTransitionalBotState(BotState.stopping)).toBe(true);
    expect(isTransitionalBotState(BotState.running)).toBe(false);
    expect(isTransitionalBotState(BotState.paused)).toBe(false);
  });

  it("pauses every bot of the account when builder fee is revoked", () => {
    expect(REASON_CODE_META[ReasonCode.builderFeeRevoked]).toEqual({
      outcome: BotState.paused,
      scope: ReasonScope.account,
    });
  });

  it("stops rather than pauses on stop loss and take profit", () => {
    expect(REASON_CODE_META[ReasonCode.stopLoss].outcome).toBe(BotState.stopped);
    expect(REASON_CODE_META[ReasonCode.takeProfit].outcome).toBe(BotState.stopped);
  });

  it("has metadata for every reason code", () => {
    expect(Object.keys(REASON_CODE_META).sort()).toEqual(Object.values(ReasonCode).sort());
  });

  it("throws from assertNever when reached at runtime", () => {
    expect(() => assertNever("x" as never)).toThrow("Unexpected value: x");
  });
});
