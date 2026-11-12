import type { DeskRecordView, WhatIfView } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { leverageChange, optionValues, pickGain, recordChip, shownFix, usedRatio } from "../bplus";

// AI Desk B+ (DEC-166): thẻ trang chủ hiện đúng phương án Desk AI chọn, không bịa số; nhãn thành tích theo kết quả đo.

type Option = WhatIfView["options"][number];
const outcome = (net: string) => ({
  trades: 40,
  net,
  closedBySodex: 0,
  worstTrade: "-1",
  marginPerTrade: "5",
});
const opt = (key: Option["key"], net: string | null, leverage: number | null = 10): Option => ({
  key,
  patch: {},
  outcome: net === null ? null : outcome(net),
  unavailable: net === null ? "not_enough_trades" : null,
  display: { leverage, stopPct: "2.5" },
});
const whatif = (options: Option[], pick: WhatIfView["pick"]): WhatIfView => ({
  id: "00000000-0000-4000-8000-000000000001",
  itemId: "00000000-0000-4000-8000-000000000002",
  botId: "00000000-0000-4000-8000-000000000003",
  bot: { name: "BTC Farm", strategy: "volume_farm", market: "BTC-USD", state: "running" },
  rule: "liquidation_before_stop",
  status: "done",
  source: "replay",
  windowFrom: "2026-11-05T00:00:00.000Z",
  windowTo: "2026-11-12T00:00:00.000Z",
  botVersion: 1,
  options,
  pick,
  error: null,
});

describe("home what-if", () => {
  it("shows Desk AI's pick next to keep, or the first fix with a result", () => {
    const w = whatif(
      [opt("keep", "-4.95"), opt("lower_leverage", "-3.10"), opt("tighter_stop", "-4.40")],
      { key: "tighter_stop", reason: "safer_best_result" },
    );
    expect(shownFix(w)?.key).toBe("tighter_stop");
    expect(shownFix({ ...w, pick: { key: "keep", reason: "keep_is_better" } })?.key).toBe(
      "lower_leverage",
    );
    expect(shownFix(whatif([opt("keep", "-1"), opt("lower_leverage", null)], null))).toBeNull();
  });

  it("puts the real leverage and stop in words and leaves them empty when unknown", () => {
    expect(optionValues(opt("lower_leverage", "-1"))).toEqual({ leverage: "10", stop: "2.5" });
    expect(optionValues({ ...opt("keep", "-1"), display: null })).toEqual({
      leverage: "",
      stop: "",
    });
  });

  it("says how much better the pick did than keeping it", () => {
    const w = whatif([opt("keep", "-4.95"), opt("review_settings", "-3.10")], {
      key: "review_settings",
      reason: "better_result",
    });
    expect(pickGain(w)).toBe("1.85");
    expect(pickGain({ ...w, pick: null })).toBeNull();
  });
});

describe("track record row", () => {
  const row = (r: Partial<DeskRecordView["rows"][number]>): DeskRecordView["rows"][number] => ({
    id: "00000000-0000-4000-8000-000000000004",
    botId: "00000000-0000-4000-8000-000000000003",
    botName: "BTC Farm",
    rule: "liquidation_before_stop",
    option: "lower_leverage",
    changes: [{ key: "leverage", from: "40", to: "10" }],
    appliedAt: "2026-11-01T00:00:00.000Z",
    dueAt: "2026-11-08T00:00:00.000Z",
    checkedAt: null,
    status: "measuring",
    verdict: null,
    after: null,
    old: null,
    source: null,
    error: null,
    canSwitchBack: false,
    switchedBackVersion: null,
    ...r,
  });

  it("labels each fix from its measured result, worse ones included", () => {
    expect(recordChip(row({}))).toBe("measuring");
    expect(recordChip(row({ status: "done", verdict: "made_worse" }))).toBe("made_worse");
    expect(recordChip(row({ status: "done", verdict: "no_clear_effect" }))).toBe("no_clear_effect");
    expect(recordChip(row({ status: "unavailable" }))).toBe("unavailable");
  });

  it("writes the leverage change only for a leverage fix", () => {
    expect(leverageChange(row({}))).toEqual({ from: "40", to: "10" });
    expect(leverageChange(row({ option: "tighter_stop" }))).toBeNull();
    expect(leverageChange(row({ changes: [] }))).toBeNull();
  });
});

describe("goal gauge", () => {
  it("fills the meter by used over limit and never invents a value", () => {
    expect(usedRatio({ limit: "500", used: "75" })).toBe(0.15);
    expect(usedRatio({ limit: "500", used: "900" })).toBe(1);
    expect(usedRatio({ limit: "500", used: null })).toBeNull();
    expect(usedRatio({ limit: "0", used: "5" })).toBeNull();
  });
});
