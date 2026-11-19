import { z } from "zod";

import { dec, Decimal } from "../money";
import { decimalStringSchema } from "../schemas";

import { ClassifierGateStatus } from "./labels";
import { GATE_MIN_CLOSED, type GateStatus } from "./report";
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

// ── API version (#305): giới hạn hiệu dụng, đoạn đếm, khác biệt với version gốc, cổng của version ─────────────────────

/**
 * Max open trades thực tế: chế độ Only these chỉ giao dịch đúng danh sách và mỗi tài sản tối đa một lệnh, nên giới hạn
 * hiệu dụng = min(Max open trades, số mã trong danh sách) ("Effectively N: one trade per asset").
 */
export function effectiveMaxOpenTrades(
  cfg: Pick<BotVersionConfig, "assets" | "maxOpenTrades">,
): number {
  return cfg.assets.mode === AssetMode.only
    ? Math.min(cfg.maxOpenTrades, new Set(cfg.assets.markets).size)
    : cfg.maxOpenTrades;
}

/**
 * Mốc đầu đoạn đếm hiện tại của một version (DEC-328 mục 2): mốc sau của lúc lưu version và lúc classifier hiện tại bắt
 * đầu chạy. Classifier chưa ghi (null) → lúc lưu version.
 */
export function segmentStart(versionCreatedAt: Date, classifierStartedAt: Date | null): Date {
  return classifierStartedAt === null || classifierStartedAt <= versionCreatedAt
    ? versionCreatedAt
    : classifierStartedAt;
}

type DecimalField = "sizeUsdc" | "tpMultiple" | "slMultiple" | "minTpCostMultiple";

/**
 * Một điểm khác giữa hai config (cấu trúc, không phải câu chữ; web dịch). Loại tin dùng khoá nội bộ như trong config.
 * Danh sách tài sản: `added` / `removed` so theo tập hợp (thứ tự không tính).
 */
export type VersionConfigChange =
  | {
      field: "newsType";
      catalyst: SignalCatalyst;
      from: { enabled: boolean; maxHoldHours: number } | null;
      to: { enabled: boolean; maxHoldHours: number } | null;
    }
  | { field: "minLevel"; from: SignalLevel; to: SignalLevel }
  | { field: "maxSourceDelayMinutes" | "maxOpenTrades"; from: number; to: number }
  | { field: "maxNewTradesPerDay"; from: number | null; to: number | null }
  | { field: DecimalField; from: string; to: string }
  | { field: "onOppositeNews"; from: OppositeNewsPolicy; to: OppositeNewsPolicy }
  | { field: "assetMode"; from: AssetMode; to: AssetMode }
  | {
      field: "assetKinds";
      from: { crypto: boolean; stocks: boolean };
      to: { crypto: boolean; stocks: boolean };
    }
  | { field: "assets"; added: string[]; removed: string[] };

/**
 * Khác biệt của `to` so với `from` (version đã chép từ), theo thứ tự field của config. Số thập phân so theo giá trị
 * ("1.5" = "1.50"). Loại tin vắng mặt = tắt, nên "vắng" và "tắt" khác nhau chỉ khi giữ tối đa khác.
 */
export function diffVersionConfig(
  from: BotVersionConfig,
  to: BotVersionConfig,
): VersionConfigChange[] {
  const out: VersionConfigChange[] = [];
  for (const c of SIGNAL_CATALYSTS) {
    const a = from.news[c] ?? null;
    const b = to.news[c] ?? null;
    const aOn = a?.enabled === true;
    const bOn = b?.enabled === true;
    if (aOn !== bOn || (aOn && bOn && a.maxHoldHours !== b.maxHoldHours))
      out.push({ field: "newsType", catalyst: c, from: a, to: b });
  }
  if (from.minLevel !== to.minLevel)
    out.push({ field: "minLevel", from: from.minLevel, to: to.minLevel });
  if (from.maxSourceDelayMinutes !== to.maxSourceDelayMinutes)
    out.push({
      field: "maxSourceDelayMinutes",
      from: from.maxSourceDelayMinutes,
      to: to.maxSourceDelayMinutes,
    });
  for (const f of ["sizeUsdc", "tpMultiple", "slMultiple", "minTpCostMultiple"] as const)
    if (!dec(from[f]).eq(dec(to[f]))) out.push({ field: f, from: from[f], to: to[f] });
  if (from.maxOpenTrades !== to.maxOpenTrades)
    out.push({ field: "maxOpenTrades", from: from.maxOpenTrades, to: to.maxOpenTrades });
  if (from.maxNewTradesPerDay !== to.maxNewTradesPerDay)
    out.push({
      field: "maxNewTradesPerDay",
      from: from.maxNewTradesPerDay,
      to: to.maxNewTradesPerDay,
    });
  if (from.onOppositeNews !== to.onOppositeNews)
    out.push({ field: "onOppositeNews", from: from.onOppositeNews, to: to.onOppositeNews });
  if (from.assets.mode !== to.assets.mode)
    out.push({ field: "assetMode", from: from.assets.mode, to: to.assets.mode });
  if (from.assets.crypto !== to.assets.crypto || from.assets.stocks !== to.assets.stocks)
    out.push({
      field: "assetKinds",
      from: { crypto: from.assets.crypto, stocks: from.assets.stocks },
      to: { crypto: to.assets.crypto, stocks: to.assets.stocks },
    });
  const was = new Set(from.assets.markets);
  const now = new Set(to.assets.markets);
  const added = [...now].filter((m) => !was.has(m)).sort();
  const removed = [...was].filter((m) => !now.has(m)).sort();
  if (added.length > 0 || removed.length > 0) out.push({ field: "assets", added, removed });
  return out;
}

/** Kiểm tra thêm bật khi đã thử nhiều hơn ngần này version (DEC-328 mục 1). */
export const EXTRA_CHECK_AFTER_VERSIONS = 3;
/** Version qua cổng khi kiểm tra thêm bật phải lặp lại kết quả trên ngần này lệnh đóng tiếp theo. */
export const VERSION_REPEAT_TRADES = 100;

/**
 * Số version đã thử = số News bot version đã lưu (Baseline + version team tạo, mọi trạng thái, kể cả đã dừng / retired).
 * Rules v1 / v2 (trước khi có version) không tính (DEC-331; PM chốt ở review #324).
 */
export function versionsTriedOf(versions: readonly unknown[]): number {
  return versions.length;
}

export function extraCheckOn(versionsTried: number): boolean {
  return versionsTried > EXTRA_CHECK_AFTER_VERSIONS;
}

export const VersionGateStatus = {
  collecting: "collecting",
  waitsForLabels: "waits_for_labels",
  passes: "passes",
  fails: "fails",
  needsRepeat: "needs_repeat",
  notCounted: "not_counted",
} as const;
export type VersionGateStatus = (typeof VersionGateStatus)[keyof typeof VersionGateStatus];
export const VERSION_GATE_STATUSES = Object.values(VersionGateStatus) as [
  VersionGateStatus,
  ...VersionGateStatus[],
];

export interface VersionGate {
  status: VersionGateStatus;
  /**
   * Kiểm tra thêm: số lệnh đếm được (theo thứ tự đóng) lúc version lần đầu qua cổng; null khi chưa qua hoặc kiểm tra
   * thêm tắt.
   */
  firstPassAt: number | null;
  /** Kiểm tra thêm: tiến độ lặp lại (`closed` / `needed` lệnh sau lần qua đầu); null khi chưa qua hoặc tắt. */
  repeat: { closed: number; needed: number } | null;
}

/**
 * Trạng thái cổng của một News bot version, trên các lệnh đã đóng của đoạn đếm hiện tại (classifier hiện tại, mở sau
 * `segmentStart`), xếp theo giờ đóng. `gateOf(from, to)` = cổng (`gateStatus`) trên lệnh [from, to) của dãy đó.
 *
 * 1. Classifier hiện tại chưa qua cổng nhãn: `underPrecision` / `unknown` → `not_counted`; `needsLabels` →
 *    `waits_for_labels` khi đoạn hiện tại đã có lệnh đóng (sẽ tính khi đủ nhãn) hoặc version chưa có lệnh đóng nào; còn
 *    lại (mọi lệnh đóng đều thuộc classifier cũ chưa qua) → `not_counted`.
 * 2. Kiểm tra thêm tắt (đã thử ≤ 3 version): cổng trên mọi lệnh của đoạn: `collecting` / `fails` / `passes`.
 * 3. Kiểm tra thêm bật (> 3 version): < 100 lệnh → `collecting`. Lần qua đầu = tiền tố ngắn nhất k ≥ 100 mà cổng trên
 *    [0, k) qua. Không có → `fails`. Có: chưa đủ 100 lệnh đóng sau k → `needs_repeat`; đủ: cổng trên riêng [k, k + 100)
 *    qua → `passes`, không → `fails`. Lần lặp lại cố định là 100 lệnh NGAY SAU lần qua đầu, không trượt theo lệnh mới.
 */
export function versionGateStatus(input: {
  classifier: ClassifierGateStatus;
  /** Mọi lệnh thật đã đóng của version (mọi classifier). */
  closed: number;
  /** Lệnh đã đóng của đoạn đếm hiện tại (= số lệnh `gateOf` nhận). */
  segmentClosed: number;
  versionsTried: number;
  gateOf: (from: number, to: number) => GateStatus;
}): VersionGate {
  const none = { firstPassAt: null, repeat: null };
  if (input.classifier !== ClassifierGateStatus.passed) {
    if (input.classifier !== ClassifierGateStatus.needsLabels)
      return { status: VersionGateStatus.notCounted, ...none };
    return {
      status:
        input.segmentClosed > 0 || input.closed === 0
          ? VersionGateStatus.waitsForLabels
          : VersionGateStatus.notCounted,
      ...none,
    };
  }
  const n = input.segmentClosed;
  if (!extraCheckOn(input.versionsTried)) {
    const g = input.gateOf(0, n);
    return {
      status:
        g === "passing"
          ? VersionGateStatus.passes
          : g === "failing"
            ? VersionGateStatus.fails
            : VersionGateStatus.collecting,
      ...none,
    };
  }
  if (n < GATE_MIN_CLOSED) return { status: VersionGateStatus.collecting, ...none };
  let first: number | null = null;
  for (let k = GATE_MIN_CLOSED; k <= n; k += 1)
    if (input.gateOf(0, k) === "passing") {
      first = k;
      break;
    }
  if (first === null) return { status: VersionGateStatus.fails, ...none };
  const after = n - first;
  const repeat = { closed: Math.min(after, VERSION_REPEAT_TRADES), needed: VERSION_REPEAT_TRADES };
  if (after < VERSION_REPEAT_TRADES)
    return { status: VersionGateStatus.needsRepeat, firstPassAt: first, repeat };
  return {
    status:
      input.gateOf(first, first + VERSION_REPEAT_TRADES) === "passing"
        ? VersionGateStatus.passes
        : VersionGateStatus.fails,
    firstPassAt: first,
    repeat,
  };
}
