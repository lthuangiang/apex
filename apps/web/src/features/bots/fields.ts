import { arbEnterPct, arbRoundTripFeePct, type Strategy } from "@drift/shared";

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
  /** Tính năng đang thử nghiệm: nhãn "Beta" và mục "How it works" (`fields.<label>.how`). */
  beta?: boolean | undefined;
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
// First entry (IMP-01, DEC-91): thay `triggerPrice` (Grid) và `start` / `startLevel` (Spot DCA).
// Grid dùng câu chữ riêng (`grid*`): Neutral chỉ vào khi giá trong khoảng.
const firstEntry = (grid = false): FieldSpec[] => [
  {
    key: "entry",
    ...(grid ? { label: "gridEntry" } : {}),
    group: 3,
    type: enumOf("entry", ["now", "at_price", "in_range"]),
  },
  {
    key: "entryPrice",
    group: 3,
    optional: true,
    type: dec("quote"),
    when: { key: "entry", is: ["at_price"] },
  },
  {
    key: "entryLow",
    ...(grid ? { label: "gridEntryLow" } : {}),
    group: 3,
    optional: true,
    row: "entryRange",
    type: dec("quote"),
    when: { key: "entry", is: ["in_range"] },
  },
  {
    key: "entryHigh",
    group: 3,
    optional: true,
    row: "entryRange",
    type: dec("quote"),
    when: { key: "entry", is: ["in_range"] },
  },
];
// Next cycle (IMP-02): chỉ DCA.
const nextCycle: FieldSpec[] = [
  {
    key: "nextCycle",
    group: 3,
    advanced: true,
    type: enumOf("nextCycle", ["immediately", "after_pullback", "cooldown", "same_as_entry"]),
  },
  {
    key: "pullbackPct",
    group: 3,
    optional: true,
    advanced: true,
    type: dec("%"),
    when: { key: "nextCycle", is: ["after_pullback"] },
  },
  {
    key: "cooldownMinutes",
    group: 3,
    optional: true,
    advanced: true,
    type: { kind: "int", unit: "min" },
    when: { key: "nextCycle", is: ["cooldown"] },
  },
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
    ...firstEntry(true),
    { key: "maxLoss", group: 4, type: dec("quote") },
    spacing,
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
    ...firstEntry(true),
    { key: "maxLoss", group: 4, type: dec("quote") },
    { key: "stopBelow", group: 4, type: dec("quote") },
    marginMode,
    spacing,
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
    ...firstEntry(),
    ...dcaAdvanced,
    ...nextCycle,
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
    ...firstEntry(),
    { key: "stopLossPct", label: "fdcaStopLoss", group: 4, type: dec("%") },
    marginMode,
    ...dcaAdvanced,
    ...nextCycle,
    { key: "maxLoss", group: 4, optional: true, advanced: true, type: dec("quote") },
  ],
  // S12 Copy Trade (DEC-161): thử nghiệm, chỉ cho tài khoản được bật AI Desk. Nguồn leader cố định SoDEX ở v1.
  copy_trade: [
    { key: "leaderSource", group: 2, hidden: true, type: { kind: "text" } },
    {
      key: "leaderAddress",
      label: "copyLeader",
      group: 2,
      locked: true,
      type: { kind: "text", placeholder: "0x…" },
    },
    // Nhiều market (DEC-163): khoá sau khi tạo, lưu trong form dạng "BTC-USD,ETH-USD" (fromConfig / toConfig).
    { key: "markets", group: 2, hidden: true, type: { kind: "text" } },
    {
      key: "direction",
      label: "copyDirection",
      group: 2,
      type: enumOf("copyDirection", ["follow", "inverse"]),
    },
    {
      key: "sizing",
      label: "copySizing",
      group: 3,
      type: enumOf("copySizing", ["fixed", "ratio"]),
    },
    {
      key: "fixedNotional",
      label: "copyFixed",
      group: 3,
      amount: true,
      row: "size",
      when: { key: "sizing", is: ["fixed"] },
      type: dec("quote"),
    },
    {
      key: "ratioPct",
      label: "copyRatio",
      group: 3,
      amount: true,
      row: "size",
      when: { key: "sizing", is: ["ratio"] },
      type: dec("%"),
    },
    { ...leverage, row: undefined, width: undefined },
    { key: "maxNotionalPerTrade", label: "copyMaxPerTrade", group: 4, type: dec("quote") },
    { key: "maxExposure", label: "copyMaxExposure", group: 4, type: dec("quote") },
    { key: "stopLossPct", label: "copySl", group: 4, optional: true, row: "exit", type: dec("%") },
    {
      key: "takeProfitPct",
      label: "copyTp",
      group: 4,
      optional: true,
      row: "exit",
      type: dec("%"),
    },
    { key: "maxLoss", label: "adcaMaxLoss", group: 4, type: dec("quote") },
    marginMode,
    { key: "maxSlippagePct", label: "copySlippage", group: 3, advanced: true, type: dec("%") },
  ],
  // S11 AI Adaptive DCA (DEC-107): thử nghiệm, chỉ cho tài khoản được bật AI Desk.
  adaptive_dca: [
    contract,
    { key: "direction", group: 2, type: enumOf("direction", ["long", "short"]) },
    {
      key: "baseOrder",
      label: "adcaBase",
      group: 3,
      amount: true,
      row: "size",
      type: dec("quote"),
    },
    {
      key: "safetyOrder",
      label: "adcaSafety",
      group: 3,
      amount: true,
      row: "size",
      type: dec("quote"),
    },
    { ...leverage, row: undefined, width: undefined },
    {
      key: "maxSafetyOrders",
      label: "adcaMaxSafety",
      group: 3,
      row: "safety",
      type: { kind: "int" },
    },
    { key: "atrMultiplier", label: "adcaAtr", group: 3, row: "safety", type: dec("×") },
    { key: "takeProfitPct", label: "adcaTp", group: 4, row: "exit", type: dec("%") },
    { key: "hardStopLossPct", label: "adcaHardStop", group: 4, row: "exit", type: dec("%") },
    { key: "maxExposure", label: "adcaMaxExposure", group: 4, type: dec("quote") },
    { key: "maxLoss", label: "adcaMaxLoss", group: 4, type: dec("quote") },
    marginMode,
    { key: "sizeMultiplier", label: "adcaSizeMult", group: 3, advanced: true, type: dec("×") },
    { key: "entryRsi", label: "adcaRsi", group: 3, advanced: true, type: dec() },
    {
      key: "cooldownMinutes",
      label: "adcaCooldown",
      group: 3,
      advanced: true,
      type: { kind: "int", unit: "min" },
    },
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
    // Initial buy (IMP-04, DEC-222): All now (mặc định) hoặc N phần bằng nhau, mỗi giờ một phần; không đổi sau khi tạo.
    {
      key: "initialBuy",
      group: 3,
      locked: true,
      type: enumOf("initialBuy", ["all_now", "over_hours"]),
    },
    {
      key: "initialBuyHours",
      group: 3,
      locked: true,
      type: { kind: "int", unit: "h" },
      when: { key: "initialBuy", is: ["over_hours"] },
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
    // Start at (IMP-03, DEC-91): Now hoặc ngày giờ theo múi giờ trong Settings; không đổi được sau khi tạo.
    { key: "start", group: 3, locked: true, type: enumOf("twapStart", ["now", "at"]) },
    {
      key: "startDate",
      group: 3,
      locked: true,
      row: "startAt",
      type: { kind: "date" },
      when: { key: "start", is: ["at"] },
    },
    {
      key: "startTime",
      group: 3,
      locked: true,
      row: "startAt",
      type: { kind: "time" },
      when: { key: "start", is: ["at"] },
    },
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
  // S9 Volume Maker, form gọn (DEC-99): Market → Order size + Leverage → Stop if I lose → Volume target.
  // Mọi field khác có mặc định (schema + `emptyValues`) và nằm trong Advanced settings.
  volume_maker: [
    {
      key: "market",
      label: "vmContract",
      group: 2,
      locked: true,
      type: { kind: "market", engine: "perps" },
    },
    { key: "orderSize", group: 3, amount: true, row: "capital", type: dec("quote") },
    {
      key: "leverage",
      label: "vmLeverage",
      group: 2,
      amount: true,
      row: "capital",
      width: "narrow",
      type: { kind: "int", unit: "×" },
    },
    { key: "costBudget", group: 4, type: dec("quote") },
    { key: "volumeTarget", group: 4, optional: true, type: dec("quote") },
    // Vị thế tối đa theo số lệnh (DEC-133), dễ hiểu hơn số USDC.
    { key: "maxOrders", group: 3, advanced: true, type: { kind: "int" } },
    // Vị trí báo giá theo mức sổ lệnh (DEC-135), thay khoảng cách bp: tự đúng với mọi market.
    { key: "quoteLevel", group: 3, advanced: true, type: { kind: "int" } },
    // Smart quoting (DEC-144), mặc định tắt: tắt là đúng logic cũ.
    { key: "smartQuoting", group: 3, beta: true, type: { kind: "bool" } },
    // Close only at entry or better / Pause on fast moves (DEC-227), mặc định tắt.
    // BETA (PM chốt sau bản rà soát): chưa chứng minh giảm lỗ, chưa đưa vào "Ways to lower it" cho tới replay v2.
    { key: "closeAtEntry", group: 3, beta: true, type: { kind: "bool" } },
    { key: "pauseOnFastMoves", group: 3, type: { kind: "bool" } },
    { key: "refreshSeconds", group: 3, advanced: true, type: { kind: "int", unit: "s" } },
    {
      key: "inventoryLossStop",
      group: 4,
      advanced: true,
      optional: true,
      type: dec("quote"),
    },
    {
      key: "runUntil",
      group: 4,
      advanced: true,
      type: enumOf("runUntil", ["target_or_budget", "season_end", "date"]),
    },
    {
      key: "untilAt",
      label: "untilAt",
      group: 4,
      advanced: true,
      type: { kind: "date" },
      when: { key: "runUntil", is: ["season_end", "date"] },
    },
    {
      key: "onStop",
      label: "vmOnStop",
      group: 4,
      advanced: true,
      type: enumOf("vmOnStop", ["close_inventory", "keep_position"]),
    },
  ],
  // S10 Volume Farm (DEC-80): chỉ hiện khi admin bật bot khối lượng cho tài khoản.
  volume_farm: [
    contract,
    {
      key: "orderSizeMinUsd",
      label: "vfSizeMin",
      group: 3,
      amount: true,
      row: "size",
      type: dec("quote"),
    },
    {
      key: "orderSizeMaxUsd",
      label: "vfSizeMax",
      group: 3,
      amount: true,
      row: "size",
      type: dec("quote"),
    },
    { ...leverage, label: "vfLeverage", row: "lev" },
    {
      key: "minHoldSecs",
      label: "vfHoldMin",
      group: 3,
      row: "hold",
      type: { kind: "int", unit: "s" },
    },
    {
      key: "maxHoldSecs",
      label: "vfHoldMax",
      group: 3,
      row: "hold",
      type: { kind: "int", unit: "s" },
    },
    { key: "reverseSignal", label: "vfReverse", group: 3, type: { kind: "bool" } },
    // DEC-158: chỉ vào lệnh khi thị trường đi ngang (regime 5 phút SIDEWAY).
    { key: "sidewaysOnly", label: "vfSideways", group: 3, type: { kind: "bool" } },
    // TP USDC / SL % như Volume Farm gốc (DEC-120); early exit dùng mặc định apex của schema, không hiện trên form.
    { key: "tpUsd", label: "vfTp", group: 4, row: "exit", type: dec("quote") },
    // % margin như TP/SL của SoDEX (DEC-126); config cũ theo % giá được quy đổi lúc mở form.
    { key: "slMarginPct", label: "vfSl", group: 4, row: "exit", type: dec("%") },
    { key: "maxLoss", label: "vfMaxLoss", group: 4, type: dec("quote") },
    { key: "volumeTarget", label: "vfVolumeTarget", group: 4, optional: true, type: dec("quote") },
    marginMode,
    {
      key: "cooldownSecs",
      label: "vfCooldown",
      group: 3,
      advanced: true,
      type: { kind: "int", unit: "s" },
    },
    // Stop loss gốc trên SoDEX (DEC-118): bật mặc định, để ngoài Advanced vì là lớp bảo vệ.
    { key: "exchangeStop", label: "vfExchangeStop", group: 3, type: { kind: "bool" } },
    // Khi nào dời stop trên SoDEX về hoà vốn (DEC-143), bội số của phí hoà vốn.
    { key: "stopMoveFees", label: "vfStopMove", group: 3, advanced: true, type: dec("×") },
    { key: "maxSpreadBps", label: "vfMaxSpread", group: 3, advanced: true, type: dec("bp") },
    // Early exit (DEC-130) hiện trong Advanced để sửa bot bằng form không làm mất giá trị Review đề xuất (DEC-131).
    {
      key: "earlyProfitFees",
      label: "vfEarlyFees",
      group: 4,
      advanced: true,
      row: "early",
      type: dec("×"),
    },
    {
      key: "earlyExitSecs",
      label: "vfEarlySecs",
      group: 4,
      advanced: true,
      row: "early",
      type: { kind: "int", unit: "s" },
    },
    { key: "allowTaker", label: "vfAllowTaker", group: 3, advanced: true, type: { kind: "bool" } },
    {
      key: "takerAfter",
      label: "vfTakerAfter",
      group: 3,
      advanced: true,
      type: { kind: "int" },
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
  if (strategy === "twap") {
    // Màn Create thay bằng múi giờ trong Settings khi tải xong hồ sơ.
    out.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  if (strategy === "funding_arb") {
    // DEC-160: funding đủ thu lại phí khứ hồi maker trong 72 giờ (kỳ 1 giờ, builder fee mặc định) ≈ 0.0018%.
    out.enterFundingPct = arbEnterPct(arbRoundTripFeePct({}), 1);
    out.exitFundingPct = "0";
  }
  if (strategy === "rebalancing") {
    out.schedule = "weekly";
    out.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  if (strategy === "volume_maker") {
    // Mặc định DEC-133 (người dùng chọn): lệnh 20 USDC mỗi phía, dừng khi lỗ 10 USDC, giữ tối đa 1 lệnh.
    Object.assign(out, {
      leverage: "5",
      orderSize: "20",
      costBudget: "10",
      maxOrders: "1",
      quoteLevel: "0",
      refreshSeconds: "3",
    });
  }
  if (strategy === "copy_trade") {
    // Mặc định DEC-161 (chọn theo khuyến nghị): 100 USDC mỗi vị thế mới, đòn bẩy 2×, trần vị thế 1.000 USDC.
    Object.assign(out, {
      leaderSource: "sodex",
      direction: "follow",
      sizing: "fixed",
      fixedNotional: "100",
      leverage: "2",
      maxNotionalPerTrade: "200",
      maxExposure: "1000",
      maxLoss: "150",
      marginMode: "isolated",
      maxSlippagePct: "0.3",
    });
  }
  if (strategy === "adaptive_dca") {
    // Mặc định DEC-107 (chọn theo khuyến nghị, chờ duyệt): đòn bẩy 2×, lệnh 100 USDC, trần vị thế 1.000 USDC.
    Object.assign(out, {
      direction: "long",
      baseOrder: "100",
      safetyOrder: "100",
      leverage: "2",
      maxSafetyOrders: "4",
      atrMultiplier: "2",
      takeProfitPct: "1.5",
      hardStopLossPct: "8",
      maxExposure: "1000",
      maxLoss: "150",
      marginMode: "isolated",
      sizeMultiplier: "1.5",
      entryRsi: "45",
      cooldownMinutes: "30",
    });
  }
  if (strategy === "volume_farm") {
    // Mặc định DEC-133 (người dùng chọn): lệnh 100–200 USDC, đòn bẩy 25×, stop loss 10% margin (0.4% giá).
    Object.assign(out, {
      leverage: "25",
      orderSizeMinUsd: "100",
      orderSizeMaxUsd: "200",
      // DEC-130: giữ 180–300 s, không dùng lệnh taker (lượt có chiều taker tốn 326–398 USDC mỗi 1M, maker 213).
      minHoldSecs: "180",
      maxHoldSecs: "300",
      tpUsd: "0.5",
      slMarginPct: "10",
      cooldownSecs: "30",
      maxSpreadBps: "10",
      allowTaker: false,
      takerAfter: "3",
      exchangeStop: true,
      earlyProfitFees: "3",
      earlyExitSecs: "10",
      stopMoveFees: "2",
    });
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
  if (strategy === "copy_trade") {
    const raw = typeof values.markets === "string" ? values.markets : "";
    out.markets = raw
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m !== "");
  }
  if (strategy === "recurring_buy") out.timeZone = values.timeZone;
  if (strategy === "twap" && values.start === "at") out.timeZone = values.timeZone;
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
  legacyEntry(out, config);
  if (strategy === "copy_trade") {
    // Copy Trade (DEC-163): `markets` là mảng tên market, không phải dòng tài sản; config cũ có `market`.
    const ms = Array.isArray(config.markets)
      ? config.markets.filter((m): m is string => typeof m === "string")
      : typeof config.market === "string"
        ? [config.market]
        : [];
    out.markets = ms.join(",");
  }
  if (strategy === "volume_maker" && config.maxOrders === undefined) {
    // Config trước DEC-133: quy vị thế tối đa (USDC) về số lệnh; không đặt thì là 2 lệnh (DEC-100), giữ đúng mức cũ.
    const size = Number(config.orderSize);
    const inv = Number(config.maxInventory);
    out.maxOrders =
      typeof config.maxInventory === "string" && size > 0
        ? String(Math.min(10, Math.max(1, Math.round(inv / size))))
        : "2";
  }
  if (strategy === "volume_farm") {
    // Config scalp cũ (DEC-102) không có TP USDC / SL %: form hiện mặc định apex, giống engine đang chạy (DEC-120).
    if (out.tpUsd === undefined || out.tpUsd === "") out.tpUsd = "0.5";
    // SL cũ theo % giá → % margin (× đòn bẩy), để lưu lại vẫn cắt đúng mức cũ (DEC-126).
    if (typeof config.slPct === "string" && config.slMarginPct === undefined) {
      const lev = Number(config.leverage);
      out.slMarginPct = lev > 0 ? String(Number((Number(config.slPct) * lev).toFixed(2))) : "25";
    }
    if (out.slMarginPct === undefined || out.slMarginPct === "") out.slMarginPct = "25";
    // Config trước DEC-118 không có `exchangeStop`: engine coi là bật, form cũng phải hiện bật.
    if (typeof config.exchangeStop !== "boolean") out.exchangeStop = true;
  }
  return out;
}

/**
 * Config cũ (trước DEC-91) → First entry trên form. Spot DCA `price_at_or_below` giữ đúng hành vi:
 * At price + Next cycle = Same as first entry. Grid `triggerPrice` (cắt qua mức) hiện thành At price:
 * Neutral vẫn là cắt qua; Long / Short lưu lại sẽ thành ≤ / ≥ mức đó. Key cũ không còn trong FIELDS nên
 * `toConfig` bỏ chúng khi lưu.
 */
function legacyEntry(out: FormValues, config: Record<string, unknown>): void {
  if (config.entry !== undefined) return;
  const level = config.start === "price_at_or_below" ? config.startLevel : config.triggerPrice;
  if (typeof level !== "string") return;
  out.entry = "at_price";
  out.entryPrice = level;
  if (config.start === "price_at_or_below" && config.nextCycle === undefined)
    out.nextCycle = "same_as_entry";
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
