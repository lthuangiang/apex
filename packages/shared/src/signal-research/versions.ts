import { z } from "zod";

import { dec, Decimal } from "../money";
import { decimalStringSchema } from "../schemas";

import {
  AssetKind,
  NEWS_RULES,
  SIGNAL_CATALYSTS,
  SignalLevel,
  SignalReason,
  TradeDirection,
  type SignalCatalyst,
} from "./rules";

// News bot version (#299, #303, DEC-328): bước Filter + Decide của lane tin tức chạy riêng cho từng version đang chạy.
// Classifier (Collect → Normalize → Understand) vẫn chạy một lần mỗi bài, dùng chung. Config của một version là bất biến:
// mỗi lần lưu là một dòng mới ở `signal_bot_versions`. Hàm ở đây thuần, không I/O.

/** Số dư giả mỗi version bắt đầu (USDC). */
export const VERSION_START_BALANCE = "10000";
/** Tối đa ngần này version chạy cùng lúc (DEC-328 mục 1). */
export const MAX_RUNNING_VERSIONS = 3;

export const SignalBotVersionStatus = {
  running: "running",
  paused: "paused",
  stopped: "stopped",
  retired: "retired",
} as const;
export type SignalBotVersionStatus =
  (typeof SignalBotVersionStatus)[keyof typeof SignalBotVersionStatus];
export const SIGNAL_BOT_VERSION_STATUSES = Object.values(SignalBotVersionStatus) as [
  SignalBotVersionStatus,
  ...SignalBotVersionStatus[],
];

export const AssetMode = { all: "all", only: "only", except: "except" } as const;
export type AssetMode = (typeof AssetMode)[keyof typeof AssetMode];

export const OppositeNewsPolicy = { keep: "keep", close: "close" } as const;
export type OppositeNewsPolicy = (typeof OppositeNewsPolicy)[keyof typeof OppositeNewsPolicy];

/** Lý do một lệnh bị chặn và chỉ theo dõi giả định (shadow, ngoài balance). */
export const ShadowReason = {
  limitOpen: SignalReason.limitOpen,
  limitDay: SignalReason.limitDay,
  noBalance: SignalReason.noBalance,
} as const;
export type ShadowReason = (typeof ShadowReason)[keyof typeof ShadowReason];

const positiveDecimal = decimalStringSchema.refine((v) => dec(v).gt(0), "Must be above 0");
const levelSchema = z.enum([SignalLevel.high, SignalLevel.medium, SignalLevel.low]);
const catalystSchema = z.enum(SIGNAL_CATALYSTS as [SignalCatalyst, ...SignalCatalyst[]]);

/** Một loại tin trong version: bật / tắt và giữ tối đa (giờ). Chiều luôn do loại tin quyết định (`NEWS_RULES`). */
export const versionNewsTypeSchema = z.object({
  enabled: z.boolean(),
  maxHoldHours: z
    .number()
    .int()
    .min(1)
    .max(7 * 24),
});

export const versionAssetsSchema = z
  .object({
    mode: z.enum([AssetMode.all, AssetMode.only, AssetMode.except]),
    /** Market SoDEX ("SOL-USD"); chỉ dùng ở `only` / `except`. */
    markets: z.array(z.string().regex(/^[A-Z0-9]+-USD$/)).max(200),
    /** Bỏ qua ở `only` (checkbox ẩn): danh sách đã chọn đúng từng market. */
    crypto: z.boolean(),
    stocks: z.boolean(),
  })
  .refine((a) => a.mode !== AssetMode.only || a.markets.length > 0, {
    message: "Pick at least one asset",
    path: ["markets"],
  })
  .refine((a) => a.mode === AssetMode.only || a.crypto || a.stocks, {
    message: "Pick crypto, stocks or both",
    path: ["crypto"],
  });

/**
 * Config của một News bot version (DEC-328). Tiền và bội số là chuỗi thập phân. Loại tin không có trong `news` = tắt (để
 * config cũ vẫn parse được khi thêm loại tin mới). `maxSourceDelayMinutes` không vượt mức của classifier
 * (`NEWS_RULES.maxSourceDelayMinutes`): bài trễ hơn đã bị bỏ trước Claude, chung cho mọi version.
 */
export const botVersionConfigSchema = z.object({
  news: z.partialRecord(catalystSchema, versionNewsTypeSchema),
  minLevel: levelSchema,
  maxSourceDelayMinutes: z.number().int().min(1).max(NEWS_RULES.maxSourceDelayMinutes),
  sizeUsdc: positiveDecimal.refine((v) => dec(v).lte(VERSION_START_BALANCE), "Above the balance"),
  tpMultiple: positiveDecimal,
  slMultiple: positiveDecimal,
  /** ≥ 1: dưới 1 thì phí lớn hơn TP. */
  minTpCostMultiple: decimalStringSchema.refine((v) => dec(v).gte(1), "At least 1"),
  assets: versionAssetsSchema,
  maxOpenTrades: z.number().int().min(1).max(1000),
  /** null = Off. Đếm theo ngày UTC, chỉ lệnh thật (không tính shadow). */
  maxNewTradesPerDay: z.number().int().min(1).max(1000).nullable(),
  onOppositeNews: z.enum([OppositeNewsPolicy.keep, OppositeNewsPolicy.close]),
});
export type BotVersionConfig = z.infer<typeof botVersionConfigSchema>;

/** Max open trades mặc định = balance ÷ size, làm tròn xuống, ít nhất 1. */
export function defaultMaxOpenTrades(sizeUsdc: string): number {
  const n = new Decimal(VERSION_START_BALANCE).div(dec(sizeUsdc)).floor().toNumber();
  return Math.max(1, Math.min(1000, n));
}

/**
 * Config của version mốc (Baseline): đúng các tham số quyết định của `NEWS_RULES` hiện tại (news-v3 lúc migration 0047):
 * mọi loại tin bật với giữ tối đa của bảng quy tắc, mọi level, nguồn trễ ≤ 30 phút, 500 USDC, TP 1.5×, SL 0.75×,
 * TP ≥ 2× chi phí, mọi tài sản, Max open trades 20, không giới hạn ngày, Keep khi có tin ngược chiều. Migration seed
 * đúng giá trị này (test so sánh).
 */
export function baselineVersionConfig(): BotVersionConfig {
  const news: BotVersionConfig["news"] = {};
  for (const c of SIGNAL_CATALYSTS)
    news[c] = { enabled: true, maxHoldHours: NEWS_RULES.catalysts[c].maxHoldHours };
  return {
    news,
    minLevel: SignalLevel.low,
    maxSourceDelayMinutes: NEWS_RULES.maxSourceDelayMinutes,
    sizeUsdc: NEWS_RULES.sizeUsdc,
    tpMultiple: NEWS_RULES.tpMultiple,
    slMultiple: NEWS_RULES.slMultiple,
    minTpCostMultiple: NEWS_RULES.minTpCostMultiple,
    assets: { mode: AssetMode.all, markets: [], crypto: true, stocks: true },
    maxOpenTrades: defaultMaxOpenTrades(NEWS_RULES.sizeUsdc),
    maxNewTradesPerDay: null,
    onOppositeNews: OppositeNewsPolicy.keep,
  };
}

/** Giữ tối đa (giờ) của loại tin trong version; null = loại tin tắt. */
export function versionHoldHours(cfg: BotVersionConfig, catalyst: SignalCatalyst): number | null {
  const t = cfg.news[catalyst];
  return t?.enabled === true ? t.maxHoldHours : null;
}

const LEVEL_RANK: Record<SignalLevel, number> = { low: 0, medium: 1, high: 2 };

export function levelAtLeast(level: SignalLevel, min: SignalLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[min];
}

/** Tài sản có được version giao dịch không (chế độ All / Only these / All except + Crypto / Stocks). */
export function assetAllowed(
  assets: BotVersionConfig["assets"],
  market: string,
  kind: AssetKind,
): boolean {
  if (assets.mode === AssetMode.only) return assets.markets.includes(market);
  const kindOk = kind === AssetKind.stock ? assets.stocks : assets.crypto;
  if (!kindOk) return false;
  return assets.mode === AssetMode.all || !assets.markets.includes(market);
}

export function oppositeDirection(d: TradeDirection): TradeDirection {
  return d === TradeDirection.long ? TradeDirection.short : TradeDirection.long;
}

/**
 * Số dư giả còn dùng được của một version = 10 000 + Σ kết quả sau phí của lệnh đã đóng − Σ size của lệnh đang mở.
 * Lệnh shadow không bao giờ tính.
 */
export function availableBalance(input: {
  closedResultUsdc: Decimal;
  openSizeUsdc: Decimal;
}): Decimal {
  return new Decimal(VERSION_START_BALANCE).add(input.closedResultUsdc).sub(input.openSizeUsdc);
}

/**
 * Giới hạn chặn một tín hiệu đã qua Filter (theo thứ tự: Max open trades, Max new trades per day, số dư giả); null = vào
 * lệnh thật.
 */
export function limitBlock(input: {
  cfg: Pick<BotVersionConfig, "maxOpenTrades" | "maxNewTradesPerDay" | "sizeUsdc">;
  openTrades: number;
  openedToday: number;
  available: Decimal;
}): ShadowReason | null {
  if (input.openTrades >= input.cfg.maxOpenTrades) return ShadowReason.limitOpen;
  if (input.cfg.maxNewTradesPerDay !== null && input.openedToday >= input.cfg.maxNewTradesPerDay)
    return ShadowReason.limitDay;
  if (input.available.lt(dec(input.cfg.sizeUsdc))) return ShadowReason.noBalance;
  return null;
}
