import { describe, expect, it } from "vitest";

import { leverageConflict, leverageSpecOf, type LeverageSpec } from "../leverage";

// Quy tắc người dùng chốt 2026-10-29 (UI_REVIEW I3): chặn khi có vị thế với thiết lập khác hoặc khi bot DRIFT khác
// chạy cùng symbol với thiết lập khác; chỉ khác cài đặt thì cảnh báo + xác nhận.

const bot: LeverageSpec = { market: "BTC-USD", leverage: 2, marginMode: "isolated" };
const none = { S: [], P: [] };

describe("leverageConflict", () => {
  it("is clear when SoDEX has no setting for the symbol, or the same one", () => {
    expect(leverageConflict(bot, none, [])).toEqual({ kind: "none" });
    expect(
      leverageConflict(bot, { S: [{ s: "BTC-USD", l: 2, m: "ISOLATED" }], P: [] }, []),
    ).toEqual({ kind: "none" });
  });

  it("warns (no block) when only the setting differs and there is no position", () => {
    expect(leverageConflict(bot, { S: [{ s: "BTC-USD", l: 40, m: "CROSS" }], P: [] }, [])).toEqual({
      kind: "changes",
      current: { leverage: 40, marginMode: "cross" },
    });
  });

  it("blocks when an open position uses a different leverage or margin mode", () => {
    const pos = { s: "BTC-USD", sz: "-0.0012", l: 40, m: "CROSS" };
    expect(
      leverageConflict(bot, { S: [{ s: "BTC-USD", l: 40, m: "CROSS" }], P: [pos] }, []),
    ).toEqual({ kind: "position", current: { leverage: 40, marginMode: "cross" } });
    // Khác margin mode, cùng đòn bẩy.
    expect(
      leverageConflict(bot, { S: [{ s: "BTC-USD", l: 2, m: "CROSS" }], P: [{ ...pos, l: 2 }] }, [])
        .kind,
    ).toBe("position");
    // Vị thế ở symbol khác không chặn.
    expect(leverageConflict(bot, { S: [], P: [{ ...pos, s: "ETH-USD" }] }, []).kind).toBe("none");
  });

  it("blocks when another DRIFT bot runs the same symbol with a different setting", () => {
    expect(
      leverageConflict(bot, none, [
        { name: "Grid BTC", spec: { market: "BTC-USD", leverage: 3, marginMode: "isolated" } },
      ]),
    ).toEqual({
      kind: "bot",
      botName: "Grid BTC",
      other: { leverage: 3, marginMode: "isolated" },
    });
    expect(leverageConflict(bot, none, [{ name: "Same", spec: { ...bot } }]).kind).toBe("none");
  });
});

describe("leverageSpecOf", () => {
  it("uses the perp leg for funding arb and cross when no margin mode is set", () => {
    expect(
      leverageSpecOf("funding_arb", "BTC-USD", { leverage: 1, perpMarket: "BTC-USD" }),
    ).toEqual({ market: "BTC-USD", leverage: 1, marginMode: "cross" });
    expect(leverageSpecOf("spot_grid", "vBTC_vUSDC", { investment: "5" })).toBeNull();
  });
});
