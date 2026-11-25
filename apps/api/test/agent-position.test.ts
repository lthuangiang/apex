import { BotState, botDetailSchema } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { holdOf, positionOf } from "../src/modules/bots/service";

// #527: vị thế theo sổ của bot cho ô Open orders, thời gian giữ của Volume Builder cho ô Last decision. Hàm thuần (không
// DB): chỉ đọc state engine đã lưu và giá khớp gần nhất đã có.

const ledger = (position: string, avgCost = "1666.2") => ({
  ledger: { position, avgCost, realized: "0", fees: "0", funding: "0" },
});
const marks = { "ETH-USD": "1667" };

describe("positionOf (#527)", () => {
  it("long and short from the bot's own ledger, unrealized = signed qty × (price − avg entry), before fees", () => {
    expect(
      positionOf("volume_farm", ledger("0.0332"), marks, "ETH-USD", BotState.running, false),
    ).toEqual({
      shown: true,
      position: {
        side: "long",
        qty: "0.0332",
        value: "55.31784",
        avgEntry: "1666.2",
        markPrice: "1667",
        unrealizedPnl: "0.02656",
      },
    });
    const short = positionOf(
      "volume_maker",
      ledger("-0.0426", "1668"),
      { "ETH-USD": "1670.6" },
      "ETH-USD",
      BotState.paused,
      false,
    );
    expect(short.position).toMatchObject({ side: "short", qty: "0.0426", value: "71.0568" });
    expect(short.position?.unrealizedPnl).toBe("-0.11076");
  });

  it("no price (missing or expired md:last) → markPrice and unrealized null, never 0", () => {
    const r = positionOf("spot_dca", ledger("1", "100"), {}, "ETH-USD", BotState.running, false);
    expect(r.position).toMatchObject({ markPrice: null, unrealizedPnl: null, value: "100" });
  });

  it("flat bot shows the tile lines with no position", () => {
    expect(positionOf("twap", ledger("0"), marks, "ETH-USD", BotState.running, false)).toEqual({
      shown: true,
      position: null,
    });
  });

  it("keeps the tile as before for multi-ledger bots, bots without a ledger, stopped bots and a position mismatch", () => {
    const hidden = { shown: false, position: null };
    for (const s of ["news_signal", "funding_arb", "rebalancing"])
      expect(positionOf(s, ledger("1"), marks, "ETH-USD", BotState.running, false)).toEqual(hidden);
    const multiCopy = {
      markets: {
        "ETH-USD": { ledger: ledger("1").ledger },
        "BTC-USD": { ledger: ledger("0").ledger },
      },
    };
    expect(positionOf("copy_trade", multiCopy, marks, "ETH-USD", BotState.running, false)).toEqual(
      hidden,
    );
    expect(
      positionOf("spot_grid", { levels: [] }, marks, "ETH-USD", BotState.running, false),
    ).toEqual(hidden);
    expect(
      positionOf("volume_farm", ledger("1"), marks, "ETH-USD", BotState.stopped, false),
    ).toEqual(hidden);
    expect(
      positionOf("volume_farm", ledger("1"), marks, "ETH-USD", BotState.running, true),
    ).toEqual(hidden);
  });
});

describe("holdOf (#527)", () => {
  const at = Date.parse("2026-11-25T10:00:00Z");
  it("Volume Builder: hold seconds of this cycle, opened / hold-until once the entry filled", () => {
    expect(
      holdOf(
        "volume_farm",
        { phase: "entering", holdSecs: 172, openedAt: null, holdUntil: null },
        BotState.running,
      ),
    ).toEqual({ phase: "entering", holdSecs: 172, openedAt: null, holdUntil: null });
    expect(
      holdOf(
        "volume_farm",
        { phase: "open", holdSecs: 172, openedAt: at, holdUntil: at + 172_000 },
        BotState.running,
      ),
    ).toEqual({
      phase: "open",
      holdSecs: 172,
      openedAt: "2026-11-25T10:00:00Z",
      holdUntil: "2026-11-25T10:02:52Z",
    });
  });

  it("null when idle, for other strategies, when the bot is stopped, or with an unreadable state", () => {
    expect(holdOf("volume_farm", { phase: "idle", holdSecs: null }, BotState.running)).toBeNull();
    expect(
      holdOf("volume_maker", { phase: "open", holdSecs: 10, openedAt: at }, BotState.running),
    ).toBeNull();
    expect(
      holdOf("volume_farm", { phase: "open", holdSecs: 10, openedAt: at }, BotState.stopped),
    ).toBeNull();
    expect(holdOf("volume_farm", null, BotState.running)).toBeNull();
    expect(holdOf("volume_farm", { phase: "open", holdSecs: "10" }, BotState.running)).toBeNull();
  });

  it("an older API response without the new fields still parses (defaults)", () => {
    const d = botDetailSchema.shape;
    expect(d.positionShown.parse(undefined)).toBe(false);
    expect(d.position.parse(undefined)).toBeNull();
    expect(d.pendingOrder.parse(undefined)).toBeNull();
    expect(d.hold.parse(undefined)).toBeNull();
  });
});
