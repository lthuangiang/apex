import { BotState, PLANNED_STOP_REASONS, type BotSummary } from "@drift/shared";

/** Bot dừng đúng kế hoạch (hết budget, đủ volume target, hết giờ): không "Needs attention" (MM-01, như Strategy Lab). */
function plannedStop(b: { state: string; reasonCode: string | null }): boolean {
  return (
    b.state === BotState.stopped &&
    (PLANNED_STOP_REASONS as readonly string[]).includes(b.reasonCode ?? "")
  );
}

// Bộ chọn bot của Trading Agent (docs/mockups/agent-selector, phương án A; DEC-TBD-agent-selector). Phần thuần:
// nhóm, thứ tự, lọc, tìm kiếm. Không I/O, không câu chữ.
//
// Nhóm: Needs attention → Running (gồm Starting / Resuming) → Paused (gồm Pausing / Stopping) → Stopped (thu gọn sau
// "Show N stopped bots"). Archived chỉ hiện ở bộ lọc Archived. Trong nhóm: `updatedAt` mới nhất trước; cùng tên thì
// `createdAt` mới nhất trước. Draft không bao giờ ở đây (DEC-57: draft chỉ nằm ở Strategy Lab).

export type PickerGroup = "attention" | "running" | "paused" | "stopped" | "archived";
export const GROUP_ORDER: readonly PickerGroup[] = [
  "attention",
  "running",
  "paused",
  "stopped",
  "archived",
];
/** Bộ lọc State: Live = mọi bot chưa dừng (Stopped thu gọn), các bộ lọc còn lại theo nhóm trạng thái. */
export type StateFilter = "live" | "running" | "paused" | "stopped" | "archived";
export const STATE_FILTERS: readonly StateFilter[] = [
  "live",
  "running",
  "paused",
  "stopped",
  "archived",
];

export interface PickerFilters {
  query: string;
  state: StateFilter;
  /** `all` hoặc một giá trị `Strategy`. */
  strategy: string;
  /** `all` hoặc tài sản base ("BTC"). */
  market: string;
  /** Đã bấm "Show N stopped bots". */
  showStopped: boolean;
}
export const DEFAULT_FILTERS: PickerFilters = {
  query: "",
  state: "live",
  strategy: "all",
  market: "all",
  showStopped: false,
};

type Bot = Pick<
  BotSummary,
  | "id"
  | "name"
  | "strategy"
  | "market"
  | "marketLabel"
  | "state"
  | "reasonCode"
  | "needsAttention"
  | "createdAt"
  | "updatedAt"
>;

/** `··` + 8 ký tự cuối của uuid, như Bot Monitor (BD-10). */
export function shortId(id: string): string {
  return `··${id.slice(-8)}`;
}

/** Nhóm trạng thái, chưa xét Needs attention. */
function stateGroup(state: BotState): PickerGroup | null {
  switch (state) {
    case BotState.running:
    case BotState.starting:
    case BotState.resuming:
      return "running";
    case BotState.paused:
    case BotState.pausing:
    case BotState.stopping:
      return "paused";
    case BotState.stopped:
      return "stopped";
    case BotState.archived:
      return "archived";
    case BotState.draft:
      return null;
  }
}

/** Cần chú ý: cờ của backend, trừ bot dừng đúng kế hoạch (MM-01) và bot đã archive. */
export function needsAttention(b: Pick<Bot, "needsAttention" | "state" | "reasonCode">): boolean {
  return b.needsAttention && b.state !== BotState.archived && !plannedStop(b);
}

/** Nhóm hiển thị của một bot; null = không có trong bộ chọn (draft). */
export function groupOf(b: Bot): PickerGroup | null {
  const g = stateGroup(b.state);
  if (g === null) return null;
  return needsAttention(b) ? "attention" : g;
}

/** Bot có trong bộ chọn (mọi trạng thái trừ draft). */
export function pickable<T extends Bot>(bots: readonly T[]): T[] {
  return bots.filter((b) => groupOf(b) !== null);
}

/** `updatedAt` mới nhất trước; cùng tên thì `createdAt` mới nhất trước; cuối cùng theo id cho tất định. */
export function compareBots(a: Bot, b: Bot): number {
  const byUpdate = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  if (a.name === b.name) {
    const byCreate = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (byCreate !== 0) return byCreate;
  }
  if (byUpdate !== 0) return byUpdate;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Bot "live" theo thứ tự hiển thị (Needs attention → Running → Paused): dùng cho Previous / Next và `/agent`. */
export function liveOrder<T extends Bot>(bots: readonly T[]): T[] {
  const live: PickerGroup[] = ["attention", "running", "paused"];
  return live.flatMap((g) => bots.filter((b) => groupOf(b) === g).sort(compareBots));
}

/** Trạng thái thuộc bộ lọc State nào. */
function inStateFilter(b: Bot, f: StateFilter): boolean {
  const g = stateGroup(b.state);
  if (f === "live") return g === "running" || g === "paused" || groupOf(b) === "attention";
  return g === f;
}

/** Số bot cho từng chip State. */
export function stateCounts(bots: readonly Bot[]): Record<StateFilter, number> {
  const all = pickable(bots);
  return Object.fromEntries(
    STATE_FILTERS.map((f) => [f, all.filter((b) => inStateFilter(b, f)).length]),
  ) as Record<StateFilter, number>;
}

/** Tài sản base của bot ("BTC" của BTC-USD và vBTC_vUSDC, theo `assetOf`). */
export function baseOf(market: string): string {
  if (market.includes("_")) return market.split("_")[0] ?? market;
  if (market.includes("-")) return market.split("-")[0] ?? market;
  return market;
}

export interface PickerText {
  /** Tên market hiển thị ("BTC-USD", "BTC · ETH · USDC"). */
  market: (b: Bot) => string;
  /** Tên chiến lược ("Market Making"). */
  strategy: (b: Bot) => string;
}

/** Từ nào cũng phải có trong tên, market, chiến lược hoặc id (không phân biệt hoa thường). */
export function matches(b: Bot, query: string, text: PickerText): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [b.name, text.market(b), b.market, text.strategy(b), b.id].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

export interface PickerView<T extends Bot> {
  groups: { key: PickerGroup; bots: T[] }[];
  /** Bot Stopped bị thu gọn (nút "Show N stopped bots"); 0 thì không hiện nút. */
  hiddenStopped: number;
  /** Danh sách phẳng theo thứ tự hiển thị (để di chuyển bằng bàn phím). */
  flat: T[];
}

export function pickerView<T extends Bot>(
  bots: readonly T[],
  f: PickerFilters,
  text: PickerText,
  assetOf: (market: string) => string = baseOf,
): PickerView<T> {
  const searching = f.query.trim() !== "";
  const base = pickable(bots).filter(
    (b) =>
      (f.strategy === "all" || b.strategy === f.strategy) &&
      (f.market === "all" || assetOf(b.market) === f.market) &&
      matches(b, f.query, text),
  );
  const shown = base.filter((b) => {
    if (f.state !== "live") return inStateFilter(b, f.state);
    // Live: mọi trạng thái trừ Archived; Stopped thu gọn trừ khi đã mở hoặc đang tìm.
    if (b.state === BotState.archived) return false;
    if (groupOf(b) === "stopped") return searching || f.showStopped;
    return true;
  });
  const hiddenStopped =
    f.state === "live" && !searching && !f.showStopped
      ? base.filter((b) => groupOf(b) === "stopped").length
      : 0;
  const groups = GROUP_ORDER.map((key) => ({
    key,
    bots: shown.filter((b) => groupOf(b) === key).sort(compareBots),
  })).filter((g) => g.bots.length > 0);
  return { groups, hiddenStopped, flat: groups.flatMap((g) => g.bots) };
}
