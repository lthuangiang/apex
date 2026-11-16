import { botSummarySchema, BotState, ReasonCode } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { stopDetailOf, summary } from "../src/modules/bots/service";

// Market Making dừng với MAX_CYCLES: API cho biết là đủ volume target hay hết giờ (DEC-TBD-mm-form-copy), để danh
// sách bot hiện đúng nhãn "Stopped: volume target reached" / "Stopped: end time reached".

const MAX = ReasonCode.maxCycles;
const vm = "volume_maker";

describe("stopDetailOf", () => {
  it("volume_target when the session volume reached the target", () => {
    expect(stopDetailOf(vm, MAX, { volumeTarget: "100000" }, { volume: "100000" })).toBe(
      "volume_target",
    );
    expect(
      stopDetailOf(vm, MAX, { volumeTarget: "100000", runUntil: "date" }, { volume: "100250.5" }),
    ).toBe("volume_target");
  });

  it("end_time when the volume is below the target or there is no target", () => {
    expect(
      stopDetailOf(vm, MAX, { volumeTarget: "100000", runUntil: "date" }, { volume: "5000" }),
    ).toBe("end_time");
    expect(stopDetailOf(vm, MAX, { runUntil: "season_end" }, { volume: "5000" })).toBe("end_time");
    expect(stopDetailOf(vm, MAX, { runUntil: "season_end" }, null)).toBe("end_time");
  });

  it("null when it cannot tell or does not apply", () => {
    // Có target, không có state runtime: không khẳng định.
    expect(stopDetailOf(vm, MAX, { volumeTarget: "100000", runUntil: "date" }, null)).toBeNull();
    expect(
      stopDetailOf(
        vm,
        MAX,
        { volumeTarget: "100000", runUntil: "target_or_budget" },
        { volume: "1" },
      ),
    ).toBeNull();
    expect(stopDetailOf(vm, MAX, null, { volume: "1" })).toBeNull();
    expect(
      stopDetailOf(vm, ReasonCode.budgetDone, { runUntil: "date" }, { volume: "1" }),
    ).toBeNull();
    expect(stopDetailOf(vm, null, { runUntil: "date" }, { volume: "1" })).toBeNull();
    expect(stopDetailOf("volume_farm", MAX, { volumeTarget: "1" }, { volume: "5" })).toBeNull();
  });
});

describe("bot summary", () => {
  const row = {
    id: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
    sodexAccountId: "00000000-0000-4000-8000-000000000003",
    name: "BTC Market Making",
    strategy: vm,
    market: "BTC-USD",
    engine: "perps",
    state: BotState.stopped,
    reasonCode: MAX,
    needsAttention: false,
    activeVersionId: null,
    mode: "live",
    createdAt: new Date("2026-11-16T00:00:00Z"),
    updatedAt: new Date("2026-11-16T01:00:00Z"),
  } as unknown as Parameters<typeof summary>[0];
  const config = {
    market: "BTC-USD",
    orderSize: "20",
    leverage: 5,
    costBudget: "10",
    volumeTarget: "50000",
    runUntil: "date",
    untilAt: 1,
  };

  it("carries stopDetail and parses with the shared schema", () => {
    const hit = summary(row, 1, { volume: "50010" }, config);
    expect(hit.stopDetail).toBe("volume_target");
    expect(botSummarySchema.parse(hit).stopDetail).toBe("volume_target");
    expect(summary(row, 1, { volume: "120" }, config).stopDetail).toBe("end_time");
    expect(
      summary({ ...row, reasonCode: null }, 1, { volume: "50010" }, config).stopDetail,
    ).toBeNull();
  });
});
