import { botSummarySchema, type BotSummary } from "@drift/shared";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_FILTERS,
  groupOf,
  liveOrder,
  pickerView,
  shortId,
  stateCounts,
  type PickerFilters,
} from "../bot-picker";

// Bộ chọn bot của Trading Agent (docs/mockups/agent-selector, DEC-TBD-agent-selector): nhóm, thứ tự, lọc, tìm.

let n = 0;
function bot(over: Partial<BotSummary> = {}): BotSummary {
  n += 1;
  return botSummarySchema.parse({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: `Bot ${String(n)}`,
    strategy: "volume_maker",
    market: "BTC-USD",
    engine: "perps",
    state: "running",
    reasonCode: null,
    needsAttention: false,
    activeVersion: 1,
    netPnl: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
    ...over,
  });
}
const text = {
  market: (b: { market: string }) => b.market,
  strategy: (b: { strategy: string }) =>
    b.strategy === "volume_maker" ? "Market Making" : "Spot Grid",
};
const view = (bots: BotSummary[], f: Partial<PickerFilters> = {}) =>
  pickerView(bots, { ...DEFAULT_FILTERS, ...f }, text);
const names = (bots: readonly BotSummary[]) => bots.map((b) => b.name);

describe("bot picker", () => {
  const attnPaused = bot({ name: "attn paused", state: "paused", needsAttention: true });
  const runOld = bot({ name: "run old", updatedAt: "2026-11-01T00:00:00.000Z" });
  const runNew = bot({ name: "run new", updatedAt: "2026-11-12T00:00:00.000Z" });
  const starting = bot({ name: "starting", state: "starting" });
  const pausing = bot({ name: "pausing", state: "pausing" });
  const stopping = bot({ name: "stopping", state: "stopping" });
  const stopped = bot({
    name: "stopped",
    state: "stopped",
    strategy: "spot_grid",
    market: "vETH_vUSDC",
    engine: "spot",
  });
  // Dừng đúng kế hoạch (đủ volume target): không "Needs attention" dù cờ còn bật (MM-01).
  const planned = bot({
    name: "planned",
    state: "stopped",
    reasonCode: "MAX_CYCLES",
    needsAttention: true,
  });
  const archived = bot({ name: "archived", state: "archived" });
  const draft = bot({ name: "draft", state: "draft" });
  const all = [
    stopped,
    archived,
    draft,
    runOld,
    pausing,
    planned,
    runNew,
    attnPaused,
    starting,
    stopping,
  ];

  it("short id is ·· plus the last 8 characters", () => {
    expect(shortId("6b1f0c2e-9d44-4a51-8e7f-a1b2c3f0a9d21")).toBe("··3f0a9d21");
  });

  it("groups: Needs attention → Running (incl. starting) → Paused (incl. pausing, stopping); stopped collapsed", () => {
    const v = view(all);
    expect(v.groups.map((g) => g.key)).toEqual(["attention", "running", "paused"]);
    expect(names(v.groups[0]?.bots ?? [])).toEqual(["attn paused"]);
    expect(names(v.groups[1]?.bots ?? [])).toEqual(["run new", "starting", "run old"]);
    expect(names(v.groups[2]?.bots ?? [])).toEqual(["pausing", "stopping"]);
    expect(v.hiddenStopped).toBe(2);
    expect(groupOf(planned)).toBe("stopped");
    expect(groupOf(draft)).toBeNull();
  });

  it("Show N stopped bots opens the Stopped group last; archived and draft never show under Live", () => {
    const v = view(all, { showStopped: true });
    expect(v.groups.map((g) => g.key)).toEqual(["attention", "running", "paused", "stopped"]);
    expect(v.hiddenStopped).toBe(0);
    expect(names(v.flat)).not.toContain("archived");
    expect(names(v.flat)).not.toContain("draft");
  });

  it("same name: newest createdAt first", () => {
    const a = bot({
      name: "BTC MM",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-11-15T00:00:00.000Z",
    });
    const b = bot({
      name: "BTC MM",
      createdAt: "2026-11-02T00:00:00.000Z",
      updatedAt: "2026-11-03T00:00:00.000Z",
    });
    expect(view([a, b]).flat.map((x) => x.id)).toEqual([b.id, a.id]);
  });

  it("Archived filter shows only archived bots", () => {
    const v = view(all, { state: "archived" });
    expect(v.groups.map((g) => g.key)).toEqual(["archived"]);
    expect(names(v.flat)).toEqual(["archived"]);
    expect(v.hiddenStopped).toBe(0);
  });

  it("search opens every state except Archived and looks at name, market, strategy and id", () => {
    expect(names(view(all, { query: "stopp" }).flat)).toEqual(["stopping", "stopped"]);
    expect(names(view(all, { query: "eth" }).flat)).toEqual(["stopped"]);
    expect(names(view(all, { query: "spot grid" }).flat)).toEqual(["stopped"]);
    expect(names(view(all, { query: runOld.id.slice(-8) }).flat)).toEqual(["run old"]);
    expect(view(all, { query: "archived" }).flat).toEqual([]);
    expect(view(all, { query: "xrp" }).groups).toEqual([]);
  });

  it("strategy and market filters", () => {
    expect(names(view(all, { strategy: "spot_grid", showStopped: true }).flat)).toEqual([
      "stopped",
    ]);
    const asset = (m: string) => (m === "vETH_vUSDC" ? "ETH" : "BTC");
    const v = pickerView(
      all,
      { ...DEFAULT_FILTERS, market: "ETH", showStopped: true },
      text,
      asset,
    );
    expect(names(v.flat)).toEqual(["stopped"]);
  });

  it("counts per State chip", () => {
    expect(stateCounts(all)).toEqual({ live: 6, running: 3, paused: 3, stopped: 2, archived: 1 });
  });

  it("live order (Previous / Next and /agent) follows the groups", () => {
    expect(names(liveOrder(all))).toEqual([
      "attn paused",
      "run new",
      "starting",
      "run old",
      "pausing",
      "stopping",
    ]);
  });
});
