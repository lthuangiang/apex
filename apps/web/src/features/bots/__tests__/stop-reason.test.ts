import { ReasonCode } from "@drift/shared";
import { describe, expect, it } from "vitest";

import en from "../../../../messages/en.json";
import { stopReasonKey, type StopReasonInput } from "../stop-reason";

// Nhãn lý do dừng của Market Making (artboard StopReasons, DEC-TBD-mm-form-copy). Mã thật lấy từ `guards` của
// packages/strategies/src/volume-maker: BUDGET_DONE (costBudget), STOP_LOSS (inventoryLossStop), MAX_CYCLES
// (volumeTarget hoặc runUntil).

const reasons = en.reasons as Record<string, string>;
const label = (i: StopReasonInput) => reasons[stopReasonKey(i)];
const mm = (over: Partial<StopReasonInput>): StopReasonInput => ({
  reasonCode: ReasonCode.maxCycles,
  strategy: "volume_maker",
  ...over,
});

describe("stop reason labels", () => {
  it("cost limit and position loss limit", () => {
    expect(label(mm({ reasonCode: ReasonCode.budgetDone }))).toBe("Stopped: cost limit reached");
    expect(label(mm({ reasonCode: ReasonCode.stopLoss }))).toBe(
      "Stopped: position loss limit reached",
    );
  });

  it("volume target reached when the traded volume is at or past the target", () => {
    expect(
      label(
        mm({ volume: { volume: "100000", volumeTarget: "100000" }, config: { runUntil: "date" } }),
      ),
    ).toBe("Stopped: volume target reached");
    expect(label(mm({ volume: { volume: "120500.5", volumeTarget: "100000" } }))).toBe(
      "Stopped: volume target reached",
    );
  });

  it("end time reached when the volume is below the target or there is no target", () => {
    expect(label(mm({ volume: { volume: "5000", volumeTarget: "100000" } }))).toBe(
      "Stopped: end time reached",
    );
    expect(label(mm({ volume: { volume: "5000", volumeTarget: null } }))).toBe(
      "Stopped: end time reached",
    );
    // Không có khối lượng, nhưng config chỉ có end time.
    expect(label(mm({ config: { runUntil: "season_end" } }))).toBe("Stopped: end time reached");
    expect(label(mm({ config: { runUntil: "date", untilAt: 1 } }))).toBe(
      "Stopped: end time reached",
    );
  });

  it("uses the API stopDetail first (bot list)", () => {
    expect(label(mm({ stopDetail: "volume_target" }))).toBe("Stopped: volume target reached");
    expect(label(mm({ stopDetail: "end_time" }))).toBe("Stopped: end time reached");
    expect(label(mm({ stopDetail: null }))).toBe("Stopped: target reached");
    // stopDetail chỉ áp dụng cho MAX_CYCLES.
    expect(label(mm({ reasonCode: ReasonCode.budgetDone, stopDetail: "end_time" }))).toBe(
      "Stopped: cost limit reached",
    );
  });

  it("a volume target of 0 or junk counts as not set", () => {
    expect(label(mm({ config: { runUntil: "date", volumeTarget: "0" } }))).toBe(
      "Stopped: end time reached",
    );
    expect(label(mm({ config: { runUntil: "date", volumeTarget: 0 } }))).toBe(
      "Stopped: end time reached",
    );
    expect(label(mm({ config: { runUntil: "target_or_budget", volumeTarget: "abc" } }))).toBe(
      "Stopped: target reached",
    );
  });

  it("volume target from config when it is the only possible cause", () => {
    expect(label(mm({ config: { runUntil: "target_or_budget", volumeTarget: "50000" } }))).toBe(
      "Stopped: volume target reached",
    );
  });

  it("generic label when the data cannot tell (never a wrong specific claim)", () => {
    // Bot list: chỉ có strategy.
    expect(label(mm({}))).toBe("Stopped: target reached");
    // Có cả target và end time, không có khối lượng.
    expect(label(mm({ config: { runUntil: "date", volumeTarget: "50000" } }))).toBe(
      "Stopped: target reached",
    );
  });

  it("other codes of Market Making keep the shared label", () => {
    expect(label(mm({ reasonCode: ReasonCode.builderFeeRevoked }))).toBe(
      reasons.BUILDER_FEE_REVOKED,
    );
  });

  it("Volume Farm and other strategies keep today's labels", () => {
    expect(label({ reasonCode: ReasonCode.maxCycles, strategy: "volume_farm" })).toBe(
      "Stopped: volume target reached",
    );
    expect(label({ reasonCode: ReasonCode.budgetDone, strategy: "volume_farm" })).toBe(
      reasons.BUDGET_DONE,
    );
    expect(label({ reasonCode: ReasonCode.maxCycles, strategy: "spot_dca" })).toBe(
      "Stopped: max cycles reached",
    );
    expect(label({ reasonCode: ReasonCode.stopLoss, strategy: "spot_grid" })).toBe(
      "Stopped: stop loss reached",
    );
    expect(label({ reasonCode: ReasonCode.budgetDone, strategy: "twap" })).toBe(
      "Stopped: budget used",
    );
    // Stats gộp mọi chiến lược: không có strategy.
    expect(label({ reasonCode: ReasonCode.stopLoss })).toBe("Stopped: stop loss reached");
  });
});
