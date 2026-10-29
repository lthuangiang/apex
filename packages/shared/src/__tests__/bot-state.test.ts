import { describe, expect, it } from "vitest";

import { applyCommand, applyEngineEvent, applyReason, BotCommand, EngineEvent } from "../bot-state";
import { BotState, REASON_CODE_META, ReasonCode } from "../enums";

describe("bot state machine", () => {
  it("only enters transitional states on user commands", () => {
    expect(applyCommand(BotState.draft, BotCommand.start)).toBe(BotState.starting);
    expect(applyCommand(BotState.running, BotCommand.pause)).toBe(BotState.pausing);
    expect(applyCommand(BotState.paused, BotCommand.resume)).toBe(BotState.resuming);
    expect(applyCommand(BotState.running, BotCommand.stop)).toBe(BotState.stopping);
    expect(applyCommand(BotState.paused, BotCommand.stop)).toBe(BotState.stopping);
    expect(applyCommand(BotState.stopped, BotCommand.archive)).toBe(BotState.archived);
  });

  it("rejects invalid commands", () => {
    expect(applyCommand(BotState.running, BotCommand.start)).toBeNull();
    expect(applyCommand(BotState.paused, BotCommand.pause)).toBeNull();
    expect(applyCommand(BotState.starting, BotCommand.stop)).toBeNull();
    expect(applyCommand(BotState.running, BotCommand.archive)).toBeNull();
  });

  it("moves to final states only on engine confirmation", () => {
    expect(applyEngineEvent(BotState.starting, EngineEvent.confirmedRunning)).toBe(
      BotState.running,
    );
    expect(applyEngineEvent(BotState.resuming, EngineEvent.confirmedRunning)).toBe(
      BotState.running,
    );
    expect(applyEngineEvent(BotState.pausing, EngineEvent.confirmedPaused)).toBe(BotState.paused);
    expect(applyEngineEvent(BotState.stopping, EngineEvent.confirmedStopped)).toBe(
      BotState.stopped,
    );
    expect(applyEngineEvent(BotState.draft, EngineEvent.confirmedRunning)).toBeNull();
    expect(applyEngineEvent(BotState.starting, EngineEvent.startFailed)).toBe(BotState.paused);
  });

  it("applies reason codes by their documented outcome", () => {
    expect(applyReason(BotState.running, ReasonCode.builderFeeRevoked)).toBe(BotState.paused);
    expect(applyReason(BotState.paused, ReasonCode.builderFeeRevoked)).toBeNull();
    expect(applyReason(BotState.running, ReasonCode.stopLoss)).toBe(BotState.stopped);
    expect(applyReason(BotState.paused, ReasonCode.emergencyHalt)).toBe(BotState.stopped);
    expect(applyReason(BotState.stopped, ReasonCode.stopLoss)).toBeNull();
    expect(applyReason(BotState.draft, ReasonCode.botMaxLoss)).toBeNull();
  });

  it("pauses every bot of the account when the API key is unusable (UI_REVIEW H1)", () => {
    expect(REASON_CODE_META[ReasonCode.apiKeyUnusable]).toEqual({
      outcome: BotState.paused,
      scope: "account",
    });
    expect(applyReason(BotState.starting, ReasonCode.apiKeyUnusable)).toBe(BotState.paused);
    expect(applyReason(BotState.running, ReasonCode.apiKeyUnusable)).toBe(BotState.paused);
    expect(applyReason(BotState.paused, ReasonCode.apiKeyUnusable)).toBeNull();
  });
});
