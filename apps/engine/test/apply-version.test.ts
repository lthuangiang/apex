import { describe, expect, it } from "vitest";

import { settleAppliedState, versionAppliedWhy, versionWaitWhy } from "../src/engine";

// DEC-304: state sau khi ghi version mới, khi fill có thể tới đúng lúc ghi.
describe("settleAppliedState", () => {
  const written = { phase: "idle", ledger: { position: "0" } };

  it("keeps the written state when nothing changed during the write", () => {
    const after = { phase: "idle", ledger: { position: "0" } };
    expect(settleAppliedState(after, { old: true }, written)).toEqual({
      state: after,
      save: false,
    });
  });

  it("keeps the state with the position and saves it again when a fill opened one during the write", () => {
    const current = { phase: "open", ledger: { position: "-0.0919" } };
    expect(settleAppliedState(null, current, written)).toEqual({ state: current, save: true });
  });

  it("saves again when a fill changed the fresh state during the write", () => {
    const after = { phase: "idle", ledger: { position: "0.00001" } };
    expect(settleAppliedState(after, {}, written)).toEqual({ state: after, save: true });
  });
});

// #223: câu Decisions khi hoãn / áp version.
describe("version Decisions lines", () => {
  it("keeps the approved Volume Farm line and uses the general line for other strategies", () => {
    expect(versionWaitWhy("volume_farm", 3)).toBe(
      "Waits until the open trade closes; v3 keeps managing it. No orders were cancelled.",
    );
    expect(versionWaitWhy("futures_dca", 3)).toBe(
      "Waits for an order in flight to finish or the open position to close; v3 keeps managing the bot until then. No orders were cancelled.",
    );
  });

  it("says when the new version kept the open position", () => {
    expect(versionAppliedWhy(4, true)).toBe(
      "Cancelled 4 orders and kept the open position; new orders for it follow on the next price.",
    );
    expect(versionAppliedWhy(0, false)).toBe(
      "Cancelled 0 orders; new orders follow on the next price.",
    );
  });
});
