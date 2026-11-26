import { costPerMillion, type VolumeMakerState } from "@drift/strategies";
import { describe, expect, it } from "vitest";

import { runFacts, type RunInput, type StoppedRun } from "../src/stopped-run";
import { compactUsd, durationText } from "../src/stopped-run-render";
import { renderTelegram, type RenderRow } from "../src/telegram-render";

// Tin `bot_stopped` dừng đúng kế hoạch có khối số liệu phiên (#566, mẫu duyệt 2026-11-26). Không cần Postgres.

const APP = "https://desklabs.test";
const BOT = "6f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const H = 3_600_000;

const ledger = (o: Partial<Record<string, string>> = {}) => ({
  position: "0",
  avgCost: "0",
  realized: "0",
  fees: "0",
  funding: "0",
  ...o,
});

/** State Market Making tối thiểu (chỉ các field `costUsed` / `costPerMillion` đọc). */
const mmState = (o: Record<string, unknown> = {}) => ({
  mid: null,
  volume: "1240000",
  makerVolume: "1000000",
  ledger: ledger({ fees: "20", realized: "-5" }),
  ...o,
});
const vbState = (o: Record<string, unknown> = {}) => ({
  volume: "52000",
  trades: 10,
  wins: 6,
  ledger: ledger({ realized: "4", fees: "6.5", funding: "0.1" }),
  ...o,
});

const input = (o: Partial<RunInput>): RunInput => ({
  strategy: "volume_maker",
  engine: "perps",
  market: "ETH-USD",
  state: mmState(),
  config: { costBudget: "25", volumeTarget: "2000000" },
  fills: 120,
  runningSince: new Date(0),
  runningUntil: new Date(6 * H + 12 * 60_000),
  stopWhy: null,
  ...o,
});

const row = (
  data: Record<string, unknown>,
  run: StoppedRun | null,
  botName: string | null = "ETH Market Making",
): RenderRow => ({ type: "bot_stopped", data: { botId: BOT, ...data }, botName, run });

const render = (data: Record<string, unknown>, run: StoppedRun | null, botName?: string | null) =>
  renderTelegram([row(data, run, botName)], APP);

describe("planned stop: the approved message", () => {
  it("Market Making cost limit: ✅ title, Volume / Cost (limit) / CPM / Ran in <pre>, Open Trading Agent", () => {
    // Đúng số của mẫu: cost 25 trên $1.24M → 20.16 / $1M (dưới 100 nên 2 chữ số).
    const m = render({ reasonCode: "BUDGET_DONE" }, runFacts(input({})));
    expect(m.text).toBe(
      [
        "✅ <b>ETH Market Making stopped: cost limit reached</b>",
        "",
        "<pre>Volume   $1.24M",
        "Cost     −25.00 USDC ▼ (limit 25.00)",
        "CPM      20.16 per $1M",
        "Ran      6h 12m</pre>",
      ].join("\n"),
    );
    expect(m.button).toEqual({ text: "Open Trading Agent", url: `${APP}/agent/${BOT}` });
  });

  it("CPM is the same number as the Trading Agent (costPerMillion of the runtime state)", () => {
    const st = mmState({ volume: "124000", ledger: ledger({ fees: "20", realized: "-5" }) });
    const run = runFacts(input({ state: st }));
    expect(run.costPerMillion).toBe(costPerMillion(st as unknown as VolumeMakerState));
    expect(run.costPerMillion).toBe("201.61");
    expect(render({ reasonCode: "BUDGET_DONE" }, run).text).toContain("CPM      201.61 per $1M");
  });

  it.each([
    ["BUDGET_DONE", "volume_maker", null, "cost limit reached"],
    ["MAX_CYCLES", "volume_maker", "Volume target 2000000 reached.", "volume target reached"],
    ["MAX_CYCLES", "volume_maker", "Run time ended.", "end time reached"],
    ["MAX_CYCLES", "volume_farm", null, "volume target reached"],
    ["BUDGET_DONE", "twap", null, "budget used"],
    ["BUDGET_DONE", "recurring_buy", null, "budget used"],
    ["MAX_CYCLES", "spot_dca", null, "max cycles reached"],
    ["TAKE_PROFIT", "spot_grid", null, "take profit reached"],
    ["TAKE_PROFIT", "rebalancing", null, "take profit reached"],
  ])("%s on %s (%s) → '%s'", (code, strategy, why, label) => {
    const state =
      strategy === "volume_maker" ? mmState() : strategy === "volume_farm" ? vbState() : {};
    const run = runFacts(input({ strategy, state, stopWhy: why }));
    const m = render({ reasonCode: code }, run);
    expect(m.text.split("\n")[0]).toBe(`✅ <b>ETH Market Making stopped: ${label}</b>`);
    expect(m.button.text).toBe("Open Trading Agent");
  });

  it("Market Making MAX_CYCLES without the stop log falls back to volume vs target, then 'target reached'", () => {
    const reached = runFacts(input({ state: mmState({ volume: "2000000" }) }));
    expect(render({ reasonCode: "MAX_CYCLES" }, reached).text).toContain(
      "stopped: volume target reached",
    );
    const short = runFacts(input({}));
    expect(render({ reasonCode: "MAX_CYCLES" }, short).text).toContain("stopped: end time reached");
    const none = runFacts(input({ state: null }));
    expect(render({ reasonCode: "MAX_CYCLES" }, none).text).toContain("stopped: target reached");
  });

  it("without any facts (bot restarted before sending) only the ✅ title with the generic reason", () => {
    expect(render({ reasonCode: "BUDGET_DONE" }, null).text).toBe(
      "✅ <b>ETH Market Making stopped: budget used</b>",
    );
  });
});

describe("CPM only for Market Making and Volume Builder", () => {
  it("Volume Builder: Volume, PnL with the max loss as limit, CPM, Ran", () => {
    const run = runFacts(
      input({ strategy: "volume_farm", state: vbState(), config: { maxLoss: "50" } }),
    );
    expect(render({ reasonCode: "MAX_CYCLES" }, run).text).toBe(
      [
        "✅ <b>ETH Market Making stopped: volume target reached</b>",
        "",
        "<pre>Volume   $52K",
        "PnL      −2.60 USDC ▼ (limit 50.00)",
        "CPM      50 per $1M",
        "Ran      6h 12m</pre>",
      ].join("\n"),
    );
  });

  it("other strategies: PnL (spot quote unit) and Ran, no Volume, no CPM", () => {
    const run = runFacts(
      input({
        strategy: "spot_grid",
        engine: "spot",
        market: "vBTC_vUSDC",
        state: { ledger: ledger({ realized: "12.5", fees: "1.2" }) },
        config: {},
      }),
    );
    expect(run.costPerMillion).toBeNull();
    const text = render({ reasonCode: "TAKE_PROFIT" }, run).text;
    expect(text).toBe(
      [
        "✅ <b>ETH Market Making stopped: take profit reached</b>",
        "",
        "<pre>PnL      +11.30 USDC ▲",
        "Ran      6h 12m</pre>",
      ].join("\n"),
    );
    expect(text).not.toContain("CPM");
    expect(text).not.toContain("Volume");
  });
});

describe("a missing number drops only its line, never 0", () => {
  const lines = (run: StoppedRun) =>
    render({ reasonCode: "BUDGET_DONE" }, run)
      .text.replace(/<\/?pre>/g, "")
      .split("\n")
      .slice(2)
      .map((l) => l.split(" ")[0]);

  it("no volume yet → no CPM line (volume 0 is a real number and stays, like the Trading Agent)", () => {
    const run = runFacts(input({ state: mmState({ volume: "0" }) }));
    expect(run.costPerMillion).toBeNull();
    expect(lines(run)).toEqual(["Volume", "Cost", "Ran"]);
  });
  it("no Running event or no stop event → no Ran line", () => {
    expect(lines(runFacts(input({ runningSince: null })))).toEqual(["Volume", "Cost", "CPM"]);
    expect(lines(runFacts(input({ runningUntil: null })))).toEqual(["Volume", "Cost", "CPM"]);
  });
  it("no cost budget in the config → Cost without '(limit …)'", () => {
    const text = render({ reasonCode: "BUDGET_DONE" }, runFacts(input({ config: null }))).text;
    expect(text).toContain("Cost     −25.00 USDC ▼\n");
    expect(text).not.toContain("(limit");
  });
  it("no runtime state → no Volume, Cost or CPM; Ran stays", () => {
    expect(lines(runFacts(input({ state: null })))).toEqual(["Ran"]);
  });
  it("no fills → no PnL line (Trading Agent shows 'No fills yet')", () => {
    const run = runFacts(
      input({ strategy: "spot_dca", state: { ledger: ledger() }, config: {}, fills: 0 }),
    );
    expect(run.pnl).toBeNull();
    expect(render({ reasonCode: "MAX_CYCLES" }, run).text).not.toContain("PnL");
  });
  it("Volume Builder without max loss → PnL without limit", () => {
    const run = runFacts(input({ strategy: "volume_farm", state: vbState(), config: {} }));
    expect(render({ reasonCode: "MAX_CYCLES" }, run).text).toContain("PnL      −2.60 USDC ▼\nCPM");
  });
  it("every number missing → title only", () => {
    const run = runFacts(input({ state: null, runningSince: null }));
    expect(render({ reasonCode: "BUDGET_DONE" }, run).text).toBe(
      "✅ <b>ETH Market Making stopped: cost limit reached</b>",
    );
  });
});

describe("safety and other kinds of stop", () => {
  it("escapes the bot name", () => {
    const m = render({ reasonCode: "BUDGET_DONE" }, runFacts(input({})), `<b>x</b> & "y"`);
    expect(m.text.split("\n")[0]).toBe(
      `✅ <b>&lt;b&gt;x&lt;/b&gt; &amp; "y" stopped: cost limit reached</b>`,
    );
  });

  it("fake-money bots keep the fake-money message, no numbers", () => {
    const m = render({ reasonCode: "BUDGET_DONE", paper: true }, runFacts(input({})));
    expect(m.text).toBe(
      "🧪 <b>Fake-money test ETH Market Making stopped</b>\nNo real money was used.",
    );
    expect(m.button.url).toBe(`${APP}/desk`);
  });

  it.each(["STOP_LOSS", "EMERGENCY_HALT"])(
    "incident stop %s keeps the old warning style",
    (code) => {
      const m = render({ reasonCode: code }, null);
      expect(m.text.startsWith("⏹ <b>ETH Market Making stopped</b>\n")).toBe(true);
      expect(m.text).not.toContain("<pre>");
      expect(m.button.text).toBe("Review in DeskLabs");
    },
  );

  it("merged with other bot problems, the planned stop is one ✅ line", () => {
    const m = renderTelegram(
      [
        row({ reasonCode: "BUDGET_DONE" }, runFacts(input({}))),
        { type: "bot_paused", data: { botId: BOT, reasonCode: "ORDER_REJECTED" }, botName: "B" },
      ],
      APP,
    );
    expect(m.text.split("\n")[1]).toBe("• ✅ ETH Market Making stopped: cost limit reached");
  });
});

describe("formatting helpers", () => {
  it("compact volume rounds down", () => {
    expect(compactUsd("1249999")).toBe("$1.24M");
    expect(compactUsd("310000")).toBe("$310K");
    expect(compactUsd("850.567")).toBe("$850.56");
    expect(compactUsd("2500000000")).toBe("$2.5B");
  });
  // Cùng bộ ví dụ với packages/shared và web (Trading Agent): chuỗi CPM trong tin = chuỗi trên Trading Agent.
  it.each([
    ["201.61", "201.61"],
    ["201.6", "201.6"],
    ["50", "50"],
    ["20.16", "20.16"],
    ["0", "0"],
    ["1234.5", "1,234.5"],
    ["21778.85", "21,778.85"],
    ["3.456", "3.46"],
  ])("CPM %s → '%s per $1M' (Trading Agent format)", (v, text) => {
    const run: StoppedRun = {
      strategy: "volume_maker",
      volume: null,
      volumeTarget: null,
      cost: null,
      pnl: null,
      costPerMillion: v,
      ranMs: null,
      stopDetail: null,
    };
    expect(render({ reasonCode: "BUDGET_DONE" }, run).text).toContain(
      `<pre>CPM      ${text} per $1M</pre>`,
    );
  });
  it("duration like the Trading Agent runtime", () => {
    expect(durationText(6 * H + 12 * 60_000)).toBe("6h 12m");
    expect(durationText(5 * 60_000)).toBe("0h 05m");
    expect(durationText(27 * H)).toBe("1d 3h");
  });
});
