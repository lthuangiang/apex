import { describe, expect, it } from "vitest";

import { settleAppliedState } from "../src/engine";

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
