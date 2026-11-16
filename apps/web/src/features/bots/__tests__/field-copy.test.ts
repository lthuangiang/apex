import { describe, expect, it } from "vitest";

import en from "../../../../messages/en.json";
import {
  hintOf,
  howBaseOf,
  labelKeyOf,
  mmNumbers,
  optionalKeyOf,
  optionKeyOf,
  rendered,
} from "../field-copy";
import { emptyValues, FIELDS, fromConfig, toConfig, type FieldSpec } from "../fields";

// Câu chữ field theo chiến lược (DEC-TBD-mm-form-copy): bản riêng của Market Making thắng, chiến lược khác giữ
// nguyên câu chữ chung; số trong hint theo giá trị đang có trên form, ô trống thì bỏ số.

const get = (key: string): unknown =>
  key
    .split(".")
    .reduce<unknown>(
      (o, k) =>
        typeof o === "object" && o !== null ? (o as Record<string, unknown>)[k] : undefined,
      en.createBot,
    );
const has = (key: string) => get(key) !== undefined;
/** Thay `{x}` như ICU đơn giản (đủ cho các câu ở đây). */
const text = (key: string, params: Record<string, string> = {}) =>
  String(get(key)).replace(/\{(\w+)\}/g, (_m, k: string) => params[k] ?? `{${k}}`);

const mm = (key: string): FieldSpec => {
  const f = FIELDS.volume_maker.find((x) => x.key === key);
  if (f === undefined) throw new Error(key);
  return f;
};
const mmValues = (over: Record<string, string | boolean> = {}) => ({
  ...emptyValues("volume_maker"),
  market: "BTC-USD",
  ...over,
});

describe("per-strategy field copy", () => {
  it("Market Making labels come from fieldsByStrategy", () => {
    const label = (k: string) => text(labelKeyOf("volume_maker", mm(k), has));
    expect(label("costBudget")).toBe("Stop when costs reach");
    expect(label("volumeTarget")).toBe("Stop after this much volume");
    expect(label("runUntil")).toBe("Also stop at");
    expect(label("maxOrders")).toBe("Max position");
    expect(label("quoteLevel")).toBe("Where to quote");
    expect(label("onStop")).toBe("When the bot stops");
    // Không có bản riêng → nhãn chung.
    expect(label("orderSize")).toBe("Order size per side");
    expect(label("inventoryLossStop")).toBe("Position loss limit");
    expect(label("refreshSeconds")).toBe("Refresh every");
  });

  it("other strategies render exactly as before (shared copy)", () => {
    for (const [strategy, list] of Object.entries(FIELDS)) {
      if (strategy === "volume_maker") continue;
      for (const f of list) {
        const shared = `fields.${f.label ?? f.key}`;
        expect(labelKeyOf(strategy, f, has)).toBe(`${shared}.label`);
        expect(hintOf(strategy, f, {}, has)).toEqual({ key: `${shared}.hint`, params: {} });
        expect(howBaseOf(strategy, f, has)).toBe(
          has(`${shared}.how.intro`) ? `${shared}.how` : null,
        );
        expect(optionalKeyOf(strategy, f, "unit", has)).toBeNull();
        expect(optionalKeyOf(strategy, f, "placeholder", has)).toBeNull();
        if (f.type.kind === "enum")
          for (const o of f.type.options)
            expect(optionKeyOf(strategy, f, f.type.optionsKey, o, has)).toBe(
              `options.${f.type.optionsKey}.${o}`,
            );
      }
    }
    // Ví dụ cụ thể: Volume Farm dùng chung field Volume target nhưng không nhận câu chữ của Market Making.
    const vf = FIELDS.volume_farm.find((f) => f.key === "volumeTarget");
    expect(vf).toBeDefined();
    if (vf !== undefined)
      expect(text(labelKeyOf("volume_farm", vf, has))).toBe(
        en.createBot.fields.vfVolumeTarget.label,
      );
  });

  it("Market Making options, units and placeholders", () => {
    const opt = (k: string, o: string) => {
      const f = mm(k);
      if (f.type.kind !== "enum") throw new Error(k);
      return text(optionKeyOf("volume_maker", f, f.type.optionsKey, o, has));
    };
    expect(opt("runUntil", "target_or_budget")).toBe("No end time");
    expect(opt("runUntil", "season_end")).toBe("End of the SoPoints season");
    expect(opt("runUntil", "date")).toBe("A date I choose");
    expect(opt("onStop", "close_inventory")).toBe("Close the position");
    expect(opt("onStop", "keep_position")).toBe("Keep the position");
    const unit = (k: string) => optionalKeyOf("volume_maker", mm(k), "unit", has);
    expect(text(unit("maxOrders") ?? "")).toBe("orders");
    expect(text(unit("quoteLevel") ?? "")).toBe("steps back");
    expect(unit("orderSize")).toBeNull();
    const ph = (k: string) => optionalKeyOf("volume_maker", mm(k), "placeholder", has);
    expect(text(ph("volumeTarget") ?? "")).toBe("100,000");
    expect(text(ph("inventoryLossStop") ?? "")).toBe("0.5");
  });

  it("How it works: kept for Market Making fields that have one", () => {
    expect(howBaseOf("volume_maker", mm("costBudget"), has)).toBe("fields.costBudget.how");
    expect(howBaseOf("volume_maker", mm("smartQuoting"), has)).toBe("fields.smartQuoting.how");
    // Ghi chú nhắc nhãn mới "Stop when costs reach".
    const own = howBaseOf("volume_maker", mm("inventoryLossStop"), has);
    expect(own).toBe("fieldsByStrategy.volume_maker.inventoryLossStop.how");
    expect(text(`${own ?? ""}.note`)).toContain("Stop when costs reach");
    expect(howBaseOf("volume_maker", mm("orderSize"), has)).toBeNull();
  });
});

describe("Market Making hints use the current form values", () => {
  const hint = (
    k: string,
    values: Record<string, string | boolean>,
    base: string | null = "BTC",
  ) => {
    const h = hintOf("volume_maker", mm(k), mmValues(values), has, base);
    return text(h.key, h.params);
  };

  it("interpolates order size, cost limit and max orders", () => {
    expect(hint("orderSize", { orderSize: "20" })).toBe(
      "Each quote is this size. At 20 USDC the bot keeps a 20 USDC buy order and a 20 USDC sell order in the order book.",
    );
    expect(hint("orderSize", { orderSize: "1,500" })).toBe(
      "Each quote is this size. At 1,500 USDC the bot keeps a 1,500 USDC buy order and a 1,500 USDC sell order in the order book.",
    );
    expect(hint("costBudget", { costBudget: "10" })).toBe(
      "Everything this run costs you: fees plus trading losses, closed and still open. At 10 USDC the bot stops once the run has cost 10 USDC. You get a warning at 8 USDC.",
    );
    expect(hint("maxOrders", { orderSize: "25" })).toBe(
      "How much the bot may hold, counted in orders, 1–10. 1 = up to 25 USDC; 3 = up to 75 USDC. When it is full, the bot only posts the order that closes it.",
    );
    expect(hint("inventoryLossStop", { orderSize: "20" })).toBe(
      "Only the position the bot holds now, not fees or losses already taken. At 0.5 USDC: if the bot holds 20 USDC of BTC and BTC falls 2.5%, the bot stops. Leave empty to rely on Stop when costs reach.",
    );
  });

  it("empty or invalid order size: the sentence without numbers, never 0 or NaN", () => {
    for (const bad of ["", "  ", "abc", "0", "-5"]) {
      for (const [k, v] of [
        ["orderSize", { orderSize: bad }],
        ["maxOrders", { orderSize: bad }],
        ["inventoryLossStop", { orderSize: bad }],
        ["costBudget", { costBudget: bad }],
      ] as const) {
        const s = hint(k, v);
        expect(s).not.toMatch(/\{|NaN|\b0 USDC/);
        expect(s).not.toContain("At ");
      }
    }
    expect(hint("orderSize", { orderSize: "" })).toBe("Each quote is this size.");
    expect(hint("costBudget", { costBudget: "" })).toBe(
      "Everything this run costs you: fees plus trading losses, closed and still open.",
    );
    // Không có market: bỏ ví dụ có tên tài sản.
    expect(hint("inventoryLossStop", { orderSize: "20" }, null)).toBe(
      "Only the position the bot holds now, not fees or losses already taken. Leave empty to rely on Stop when costs reach.",
    );
  });

  it("Smart quoting hint follows the switch", () => {
    expect(hint("smartQuoting", { smartQuoting: true })).toMatch(/^Follows the Binance price/);
    expect(hint("smartQuoting", { smartQuoting: false })).toBe(
      "Off: the bot quotes at the set position and replaces its quotes every refresh. More fills, higher cost per $1M.",
    );
  });

  it("mmNumbers", () => {
    expect(mmNumbers(mmValues({ orderSize: "20", maxOrders: "3" }))).toMatchObject({
      size: "20",
      size3: "60",
      max: "60",
      cut: "0.03",
      lossPct: "2.5",
      budget: "10",
      warn: "8",
    });
    expect(mmNumbers(mmValues({ orderSize: "", maxOrders: "3" }))).toMatchObject({
      size: null,
      max: null,
      cut: null,
    });
  });
});

describe("Position loss limit with Smart quoting", () => {
  const f = mm("inventoryLossStop");

  it("is not rendered while Smart quoting is on, and is rendered when off", () => {
    expect(rendered(f, { smartQuoting: true })).toBe(false);
    expect(rendered(f, { smartQuoting: false })).toBe(true);
    // Config cũ thiếu smartQuoting = tắt.
    expect(rendered(f, {})).toBe(true);
  });

  it("keeps a saved value in the submitted config even when Smart quoting is on", () => {
    const values = fromConfig("volume_maker", {
      market: "BTC-USD",
      orderSize: "20",
      leverage: 5,
      costBudget: "10",
      maxOrders: 1,
      quoteLevel: 0,
      refreshSeconds: 3,
      smartQuoting: true,
      inventoryLossStop: "0.7",
      runUntil: "target_or_budget",
      onStop: "close_inventory",
    });
    expect(values.inventoryLossStop).toBe("0.7");
    expect(toConfig("volume_maker", values).inventoryLossStop).toBe("0.7");
  });
});
