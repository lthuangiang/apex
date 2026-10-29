import type { Strategy } from "@drift/shared";

// Field spec của form tạo/sửa bot (docs/STRATEGIES.md). Nhóm theo artboard Create: 2 = Market,
// 3 = Parameters, 4 = Risk & exits. Key khớp zod schema trong packages/strategies; câu chữ ở
// `createBot.fields.<label>` trong en.json.

export type FieldKind =
  | { kind: "decimal"; unit?: "quote" | "base" | "%" | "×" | "h" | "s" | "min" | "bp" }
  | { kind: "int"; unit?: "×" | "min" | "h" | "s" }
  /** Ngày (UTC 00:00), gửi lên dạng ms. */
  | { kind: "date" }
  /** `numeric`: giá trị gửi lên là số (ví dụ thứ trong tuần 0–6). */
  | { kind: "enum"; options: readonly string[]; optionsKey: string; numeric?: boolean }
  /** Giờ `HH:MM`. */
  | { kind: "time" }
  | { kind: "market"; engine: "spot" | "perps" }
  /** Engine lấy theo field khác (TWAP › Engine). */
  | { kind: "market"; engineKey: string }
  /** Funding Arb: một picker tài sản, tự điền `spotMarket` và `perpMarket` (UI_REVIEW G4). */
  | { kind: "arbAsset" }
  | { kind: "text"; placeholder?: string }
  | { kind: "bool" }
  | { kind: "assets" };

export interface FieldSpec {
  key: string;
  /** Key câu chữ trong `createBot.fields`; mặc định trùng `key`. */
  label?: string;
  group: 2 | 3 | 4;
  optional?: boolean;
  /** Không sửa được sau khi tạo (SCREENS.md mục 8.4). */
  locked?: boolean;
  type: FieldKind;
  /** Giá trị cố định, không sửa được (ví dụ đòn bẩy 1× của Volume Maker). */
  fixed?: string;
  /** Không vẽ ô riêng (field khác điền giá trị), vẫn gửi lên trong config. */
  hidden?: boolean;
  /** Đổi field này thì xoá các field kia (ví dụ đổi Engine thì xoá Market). */
  clears?: readonly string[];
  /** Chỉ hiện khi field khác có giá trị này. */
  when?: { key: string; is: readonly string[] };
  /** Hiện trong nhóm Amount, ngay sau Market (UI_REVIEW G2). */
  amount?: boolean | undefined;
  /** Nằm trong "Advanced settings" (đóng mặc định). */
  advanced?: boolean | undefined;
  /** Field cùng `row` nằm chung một hàng (xuống cột dưới 480 px). */
  row?: string | undefined;
  /** Độ rộng trong hàng: wide = 2/3, narrow = 1/3; mặc định chia đều. */
  width?: "wide" | "narrow" | undefined;
}

const dec = (unit?: "quote" | "base" | "%" | "×" | "h" | "s" | "min" | "bp"): FieldKind =>
  unit === undefined ? { kind: "decimal" } : { kind: "decimal", unit };
const enumOf = (
  optionsKey: string,
  options: readonly string[],
): Extract<FieldKind, { kind: "enum" }> => ({
  kind: "enum",
  options,
  optionsKey,
});

// Bố cục theo UI_REVIEW G2/G3 (DEC-68): Market → Amount (ô vốn ngay sau market) → Strategy → Risk →
// Advanced settings (đóng). `group` giữ nhóm gốc của STRATEGIES.md; `amount` / `advanced` đổi chỗ hiện.
const contract: FieldSpec = {
  key: "market",
  label: "contract",
  group: 2,
  locked: true,
  type: { kind: "market", engine: "perps" },
};
const leverage: FieldSpec = {
  key: "leverage",
  group: 2,
  amount: true,
  row: "capital",
  width: "narrow",
  type: { kind: "int", unit: "×" },
};
const marginMode: FieldSpec = {
  key: "marginMode",
  group: 2,
  advanced: true,
  type: enumOf("marginMode", ["cross", "isolated"]),
};

// Futures DCA dùng câu chữ riêng theo artboard Create-FDCA (`fdca*`, UI_REVIEW G1); Spot DCA giữ key cũ.
const dcaAmount = (futures = false): FieldSpec[] => [
  {
    key: "baseOrder",
    ...(futures ? { label: "fdcaBaseOrder" } : {}),
    group: 3,
    amount: true,
    row: "dca",
    type: dec("quote"),
  },
  {
    key: "safetyOrder",
    ...(futures ? { label: "fdcaSafetyOrder" } : {}),
    group: 3,
    amount: true,
    row: "dca",
    type: dec("quote"),
  },
];
const dcaStrategy = (futures = false): FieldSpec[] => [
  { key: "maxSafetyOrders", group: 3, type: { kind: "int" } },
  {
    key: "firstStepPct",
    ...(futures ? { label: "fdcaFirstStepPct" } : {}),
    group: 3,
    type: dec("%"),
  },
  {
    key: "takeProfitPct",
    label: futures ? "fdcaTakeProfit" : "dcaTakeProfit",
    group: 3,
    type: dec("%"),
  },
];
const dcaAdvanced: FieldSpec[] = [
  { key: "stepMultiplier", group: 3, advanced: true, type: dec("×") },
  { key: "sizeMultiplier", group: 3, advanced: true, type: dec("×") },
];
const range: FieldSpec[] = [
  { key: "lowerPrice", group: 3, row: "range", type: dec("quote") },
  { key: "upperPrice", group: 3, row: "range", type: dec("quote") },
  { key: "gridLevels", group: 3, type: { kind: "int" } },
];
const spacing: FieldSpec = {
  key: "spacing",
  group: 3,
  advanced: true,
  type: enumOf("spacing", ["arithmetic", "geometric"]),
};

export const FIELDS: Record<Strategy, readonly FieldSpec[]> = {
  spot_grid: [
    { key: "market", group: 2, locked: true, type: { kind: "market", engine: "spot" } },
    { key: "investment", group: 3, amount: true, type: dec("quote") },
    ...range,
    { key: "maxLoss", group: 4, type: dec("quote") },
    spacing,
    { key: "triggerPrice", group: 3, optional: true, advanced: true, type: dec("quote") },
    { key: "stopPrice", group: 4, optional: true, advanced: true, type: dec("quote") },
    { key: "takeProfitPct", group: 4, optional: true, advanced: true, type: dec("%") },
    {
      key: "onStop",
      group: 4,
      advanced: true,
      type: enumOf("onStopSpot", ["keep_base", "sell_at_market"]),
    },
  ],
  futures_grid: [
    contract,
    { key: "direction", group: 2, type: enumOf("direction", ["neutral", "long", "short"]) },
    { key: "margin", group: 3, amount: true, row: "capital", width: "wide", type: dec("quote") },
    leverage,
    ...range,
    { key: "maxLoss", group: 4, type: dec("quote") },
    { key: "stopBelow", group: 4, type: dec("quote") },
    marginMode,
    spacing,
    { key: "triggerPrice", group: 3, optional: true, advanced: true, type: dec("quote") },
    { key: "stopAbove", group: 4, optional: true, advanced: true, type: dec("quote") },
    { key: "takeProfitPct", group: 4, optional: true, advanced: true, type: dec("%") },
    {
      key: "onStop",
      group: 4,
      advanced: true,
      type: enumOf("onStopPerps", ["close_at_market", "keep_position"]),
    },
  ],
  spot_dca: [
    { key: "market", group: 2, locked: true, type: { kind: "market", engine: "spot" } },
    ...dcaAmount(),
    ...dcaStrategy(),
    ...dcaAdvanced,
    {
      key: "start",
      group: 3,
      advanced: true,
      type: enumOf("start", ["immediately", "price_at_or_below"]),
    },
    {
      key: "startLevel",
      group: 3,
      optional: true,
      advanced: true,
      type: dec("quote"),
      when: { key: "start", is: ["price_at_or_below"] },
    },
    { key: "stopLossPct", group: 4, optional: true, advanced: true, type: dec("%") },
    { key: "maxCycles", group: 4, optional: true, advanced: true, type: { kind: "int" } },
    { key: "maxLoss", group: 4, optional: true, advanced: true, type: dec("quote") },
  ],
  futures_dca: [
    contract,
    { key: "direction", group: 2, type: enumOf("direction", ["long", "short"]) },
    ...dcaAmount(true),
    { ...leverage, row: undefined, width: undefined },
    // Perp có Short: "move" thay cho "drop" (artboard Create-FDCA, STRATEGIES.md S4).
    ...dcaStrategy(true),
    { key: "stopLossPct", label: "fdcaStopLoss", group: 4, type: dec("%") },
    marginMode,
    ...dcaAdvanced,
    { key: "maxLoss", group: 4, optional: true, advanced: true, type: dec("quote") },
  ],
  recurring_buy: [
    { key: "market", group: 2, locked: true, type: { kind: "market", engine: "spot" } },
    { key: "amountPerBuy", group: 3, amount: true, type: dec("quote") },
    { key: "frequency", group: 3, type: enumOf("frequency", ["daily", "weekly", "monthly"]) },
    // Thứ / ngày + giờ theo múi giờ người dùng (STRATEGIES.md S5 "Mon 09:00"; UI_REVIEW G4).
    {
      key: "dayOfWeek",
      group: 3,
      type: { ...enumOf("dayOfWeek", ["1", "2", "3", "4", "5", "6", "0"]), numeric: true },
      when: { key: "frequency", is: ["weekly"] },
    },
    {
      key: "dayOfMonth",
      group: 3,
      optional: true,
      type: { kind: "int" },
      when: { key: "frequency", is: ["monthly"] },
    },
    { key: "time", group: 3, type: { kind: "time" } },
    { key: "ends", group: 3, type: enumOf("ends", ["after_budget", "after_n_buys", "never"]) },
    {
      key: "totalBudget",
      group: 3,
      optional: true,
      type: dec("quote"),
      when: { key: "ends", is: ["after_budget"] },
    },
    {
      key: "buyCount",
      group: 3,
      optional: true,
      type: { kind: "int" },
      when: { key: "ends", is: ["after_n_buys"] },
    },
    { key: "skipAbovePrice", group: 4, optional: true, advanced: true, type: dec("quote") },
    {
      key: "onLowBalance",
      group: 4,
      advanced: true,
      type: enumOf("onLowBalance", ["skip_and_notify", "pause"]),
    },
  ],
  rebalancing: [
    { key: "quoteAsset", group: 2, locked: true, type: enumOf("quoteAsset", ["USDC", "USDT"]) },
    { key: "investment", group: 3, amount: true, type: dec("quote") },
    { key: "assets", group: 3, type: { kind: "assets" } },
    { key: "rebalanceWhen", group: 3, type: enumOf("rebalanceWhen", ["threshold", "schedule"]) },
    {
      key: "thresholdPct",
      group: 3,
      type: dec("%"),
      when: { key: "rebalanceWhen", is: ["threshold"] },
    },
    // Lịch: 00:00 theo múi giờ người dùng; Weekly = thứ Hai, Monthly = ngày 1 (DEC-67).
    {
      key: "schedule",
      label: "rebalSchedule",
      group: 3,
      type: enumOf("rebalSchedule", ["daily", "weekly", "monthly"]),
      when: { key: "rebalanceWhen", is: ["schedule"] },
    },
    { key: "maxTradePct", group: 4, advanced: true, type: dec("%") },
    {
      key: "stopBelow",
      label: "rebalStopBelow",
      group: 4,
      optional: true,
      advanced: true,
      type: dec("quote"),
    },
    {
      key: "takeProfitPct",
      label: "rebalTakeProfit",
      group: 4,
      optional: true,
      advanced: true,
      type: dec("%"),
    },
  ],
  funding_arb: [
    { key: "asset", group: 2, locked: true, type: { kind: "arbAsset" } },
    {
      key: "spotMarket",
      group: 2,
      locked: true,
      hidden: true,
      type: { kind: "market", engine: "spot" },
    },
    {
      key: "perpMarket",
      group: 2,
      locked: true,
      hidden: true,
      type: { kind: "market", engine: "perps" },
    },
    { key: "investment", group: 3, amount: true, type: dec("quote") },
    { key: "enterFundingPct", group: 3, type: dec("%") },
    { key: "maxLoss", label: "arbMaxLoss", group: 4, type: dec("quote") },
    {
      key: "leverage",
      label: "perpLeverage",
      group: 2,
      advanced: true,
      type: { kind: "int", unit: "×" },
    },
    { key: "exitFundingPct", group: 3, advanced: true, type: dec("%") },
    { key: "maxGapPct", group: 3, advanced: true, type: dec("%") },
    { key: "minMarginRatioPct", group: 4, advanced: true, type: dec("%") },
  ],
  twap: [
    {
      key: "engine",
      group: 2,
      locked: true,
      clears: ["market"],
      type: enumOf("engine", ["spot", "perps"]),
    },
    {
      key: "market",
      label: "twapMarket",
      group: 2,
      locked: true,
      type: { kind: "market", engineKey: "engine" },
    },
    { key: "side", group: 2, type: enumOf("side", ["buy", "sell"]) },
    { key: "totalSize", group: 3, amount: true, type: dec("base") },
    { key: "durationMinutes", group: 3, type: { kind: "int", unit: "min" } },
    { key: "slices", group: 3, type: { kind: "int" } },
    { key: "maxSlippagePct", group: 4, type: dec("%") },
    { key: "priceLimit", group: 3, optional: true, advanced: true, type: dec("quote") },
    {
      key: "reduceOnly",
      group: 3,
      advanced: true,
      type: { kind: "bool" },
      when: { key: "engine", is: ["perps"] },
    },
    {
      key: "onSkip",
      group: 4,
      advanced: true,
      type: enumOf("onSkip", ["add_to_end", "leave_unfilled"]),
    },
  ],
  // S9: khoá bằng VOLUME_MAKER_ENABLED (VOLUME_MAKER.md mục 17.5).
  volume_maker: [
    {
      key: "market",
      label: "vmContract",
      group: 2,
      locked: true,
      type: enumOf("vmMarket", ["BTC-USD", "ETH-USD"]),
    },
    {
      key: "leverage",
      label: "vmLeverage",
      group: 2,
      locked: true,
      fixed: "1",
      type: { kind: "int", unit: "×" },
    },
    { key: "volumeTarget", group: 3, type: dec("quote") },
    { key: "orderSize", group: 3, type: dec("quote") },
    { key: "distanceBp", group: 3, type: dec("bp") },
    { key: "maxInventory", group: 3, type: dec("quote") },
    { key: "refreshSeconds", group: 3, type: { kind: "int", unit: "s" } },
    {
      key: "runUntil",
      group: 3,
      type: enumOf("runUntil", ["season_end", "date", "target_or_budget"]),
    },
    {
      key: "untilAt",
      label: "untilAt",
      group: 3,
      type: { kind: "date" },
      when: { key: "runUntil", is: ["season_end", "date"] },
    },
    { key: "costBudget", group: 4, type: dec("quote") },
    { key: "inventoryLossStop", group: 4, type: dec("quote") },
    {
      key: "onStop",
      label: "vmOnStop",
      group: 4,
      type: enumOf("vmOnStop", ["close_inventory", "keep_position"]),
    },
  ],
};

export type FormValues = Record<string, string | boolean | AssetRow[]>;
export interface AssetRow {
  asset: string;
  market: string;
  weightPct: string;
}

/** Giá trị khởi đầu: chỉ enum có mặc định (lựa chọn đầu); số để trống, không bịa số (quy tắc 1.8). */
export function emptyValues(strategy: keyof typeof FIELDS): FormValues {
  const out: FormValues = {};
  for (const f of FIELDS[strategy]) {
    if (f.fixed !== undefined) out[f.key] = f.fixed;
    else if (f.type.kind === "enum") out[f.key] = f.type.options[0] ?? "";
    else if (f.type.kind === "bool") out[f.key] = false;
    else if (f.type.kind === "assets")
      out[f.key] = [
        { asset: "", market: "", weightPct: "" },
        { asset: "", market: "", weightPct: "" },
      ];
    else out[f.key] = "";
  }
  if (strategy === "recurring_buy") {
    // Mặc định "Weekly, Mon 09:00" theo STRATEGIES.md S5.
    out.frequency = "weekly";
    out.time = "09:00";
    out.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  if (strategy === "rebalancing") {
    out.schedule = "weekly";
    out.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return out;
}

export function visible(f: FieldSpec, values: FormValues): boolean {
  if (f.when === undefined) return true;
  const v = values[f.when.key];
  return typeof v === "string" && f.when.is.includes(v);
}

/** Form → body config: số nguyên thành number, trống + optional thì bỏ, assets bỏ market trống. */
export function toConfig(
  strategy: keyof typeof FIELDS,
  values: FormValues,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS[strategy]) {
    if (!visible(f, values)) continue;
    const v = values[f.key];
    if (f.type.kind === "assets" && Array.isArray(v)) {
      out[f.key] = v.map((r) => ({
        asset: r.asset,
        ...(r.market === "" ? {} : { market: r.market }),
        weightPct: r.weightPct,
      }));
      continue;
    }
    if (f.type.kind === "enum" && f.type.numeric === true && typeof v === "string") {
      out[f.key] = Number(v);
      continue;
    }
    if (typeof v === "boolean") {
      out[f.key] = v;
      continue;
    }
    if (typeof v !== "string") continue;
    const trimmed = v.trim().replace(/,/g, "");
    if (trimmed === "") {
      if (!f.optional) out[f.key] = trimmed;
      continue;
    }
    out[f.key] =
      f.type.kind === "int"
        ? Number(trimmed)
        : f.type.kind === "date"
          ? Date.parse(`${trimmed}T00:00:00Z`)
          : trimmed;
  }
  if (strategy === "recurring_buy") out.timeZone = values.timeZone;
  if (strategy === "rebalancing" && values.rebalanceWhen === "schedule")
    out.timeZone = values.timeZone;
  return out;
}

/** Config đã lưu → giá trị form (màn Edit). */
export function fromConfig(
  strategy: keyof typeof FIELDS,
  config: Record<string, unknown>,
): FormValues {
  const out = emptyValues(strategy);
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === "string" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "number")
      out[k] = FIELDS[strategy].some((f) => f.key === k && f.type.kind === "date")
        ? new Date(v).toISOString().slice(0, 10)
        : String(v);
    else if (Array.isArray(v))
      out[k] = v.map((r: { asset?: string; market?: string; weightPct?: string }) => ({
        asset: r.asset ?? "",
        market: r.market ?? "",
        weightPct: r.weightPct ?? "",
      }));
  }
  return out;
}

export const isLaunched = (s: string): s is keyof typeof FIELDS => Object.hasOwn(FIELDS, s);

/**
 * Giá trị điền sẵn khi mở Create từ "New bot on <market>" ở Watchlist (UI_REVIEW M2, DEC-74).
 * Chỉ chiến lược có đúng một ô market cùng engine; null = chiến lược không dùng được market này.
 */
export function presetMarket(
  strategy: keyof typeof FIELDS,
  market: string,
  engine: "spot" | "perps",
): FormValues | null {
  const f = FIELDS[strategy].find((x) => x.key === "market" && x.type.kind === "market");
  if (f?.type.kind !== "market" || f.hidden === true) return null;
  if ("engineKey" in f.type) return { [f.type.engineKey]: engine, market };
  return f.type.engine === engine ? { market } : null;
}
