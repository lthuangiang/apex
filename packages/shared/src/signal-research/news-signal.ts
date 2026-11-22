import { z } from "zod";

import { liquidationDistance, type MarginTier } from "../desk/needs-you";
import { dec, Decimal, roundToStep, RoundMode, type DecimalInput } from "../money";
import { decimalStringSchema } from "../schemas";

import { AssetKind, TradeDirection } from "./rules";
import { AssetMode, botVersionConfigSchema, levelAtLeast, type BotVersionConfig } from "./versions";

// Bot `news_signal` trên SoDEX mainnet (#418, #419, DEC-360). Bot tạo mới từ một Signal research
// version mà user thấy được (version của team hoặc My versions), chạy tiền thật. Bot paper cá nhân là My versions (#423),
// không thuộc file này. Hàm ở đây thuần, không I/O; API (lúc tạo / lưu) và engine (`#load`, `#execute`) dùng chung.

/** Trần size mỗi lệnh của bot mainnet (USDC), cho tới khi có quyết định khác. */
export const NEWS_SIGNAL_LIVE_MAX_USDC = "200";
/** Đòn bẩy mặc định của bot mainnet (bot cũ không có trường `leverage` đọc là mức này). */
export const NEWS_SIGNAL_LEVERAGE = 1;
/** Các mức đòn bẩy người dùng chọn được (#458, người dùng duyệt 2026-11-22), luôn isolated. */
export const NEWS_SIGNAL_LEVERAGES = [1, 5, 10, 20] as const;
export type NewsSignalLeverage = (typeof NEWS_SIGNAL_LEVERAGES)[number];
/** Khoảng tới giá thanh lý phải ≥ ngần này × khoảng tới SL (#458): bù phần ước tính bỏ qua phí và funding (DEC-172). */
export const NEWS_SIGNAL_LIQ_SL_MULTIPLE = "1.5";
/**
 * Tỷ lệ ký quỹ duy trì dự phòng khi SoDEX không trả `marginTiers` của market (#458). Bảo thủ: BTC là 1.25% (DEC-172),
 * altcoin nhỏ thường cao hơn; MMR cao hơn đưa giá thanh lý lại gần, nên bỏ nhiều tín hiệu hơn chứ không ít hơn.
 */
export const NEWS_SIGNAL_FALLBACK_MMR = "0.05";
/** Tín hiệu cũ hơn ngần này (tính từ lúc tín hiệu được ghi) thì bỏ với `SIGNAL_STALE`. */
export const NEWS_SIGNAL_TTL_MS = 120_000;
/** Trượt giá thêm cho lệnh vào limit IOC, ngoài nửa spread (phần trăm của giá giữa). */
export const NEWS_SIGNAL_ENTRY_SLIPPAGE_PCT = "0.2";

const sizeSchema = decimalStringSchema
  .refine((v) => dec(v).gt(0), "Must be above 0")
  .refine((v) => dec(v).lte(NEWS_SIGNAL_LIVE_MAX_USDC), "Above the 200 USDC cap");

/**
 * Config của một bot `news_signal` mainnet: config đầy đủ của version (chép từ version gốc) cộng các trường của bot. Size
 * mỗi lệnh (giá trị vị thế, không phải ký quỹ) ≤ `NEWS_SIGNAL_LIVE_MAX_USDC` ở mọi mức đòn bẩy. Đòn bẩy 1 / 5 / 10 / 20,
 * isolated (#458); bot cũ không có trường đọc là 1. Max open trades / Max new trades per day dùng đúng các trường của
 * version (người tạo bot chọn).
 */
export const newsSignalConfigSchema = botVersionConfigSchema.extend({
  sizeUsdc: sizeSchema,
  leverage: z
    .union(
      NEWS_SIGNAL_LEVERAGES.map((l) => z.literal(l)) as [
        z.ZodLiteral<1>,
        z.ZodLiteral<5>,
        z.ZodLiteral<10>,
        z.ZodLiteral<20>,
      ],
    )
    .default(NEWS_SIGNAL_LEVERAGE),
});
export type NewsSignalConfig = z.infer<typeof newsSignalConfigSchema>;

/**
 * Mã engine chặn lệnh mở của bot news trước khi gửi (#419 engine A/B1). Chiến lược ghi đúng mã này vào `close_reason` của
 * lệnh vào bị chặn (không phải `ENTRY_NOT_FILLED`). `NEWS_ORDER_INVALID`: không phải limit IOC Perps có giá;
 * `NEWS_CAP_EXCEEDED`: giá × khối lượng vượt `NEWS_SIGNAL_LIVE_MAX_USDC`; `NEWS_ACCESS_OFF`: bot chỉ được quản lý lệnh đang
 * mở (chủ bot mất quyền / công tắc tắt); `BOT_NOT_RUNNING`; `LEVERAGE_NOT_SET`.
 */
export const NewsEntryBlock = {
  orderInvalid: "NEWS_ORDER_INVALID",
  capExceeded: "NEWS_CAP_EXCEEDED",
  accessOff: "NEWS_ACCESS_OFF",
  botNotRunning: "BOT_NOT_RUNNING",
  leverageNotSet: "LEVERAGE_NOT_SET",
} as const;
export type NewsEntryBlock = (typeof NewsEntryBlock)[keyof typeof NewsEntryBlock];
export const isNewsEntryBlock = (code: string): code is NewsEntryBlock =>
  (Object.values(NewsEntryBlock) as string[]).includes(code);

/** Tín hiệu đã quá `NEWS_SIGNAL_TTL_MS` chưa (đúng bằng TTL vẫn còn hạn). */
export function newsSignalStale(signalAt: Date, now: Date): boolean {
  return now.getTime() - signalAt.getTime() > NEWS_SIGNAL_TTL_MS;
}

/**
 * Giá trần của lệnh vào limit IOC: mid ± (nửa spread + `NEWS_SIGNAL_ENTRY_SLIPPAGE_PCT`% của mid), tức mua tối đa
 * ask + 0.2% mid, bán tối thiểu bid − 0.2% mid. Làm tròn theo tick về phía ít trượt hơn (mua làm tròn xuống, bán làm tròn
 * lên), nên trượt giá không bao giờ vượt mức đã ghi. Thiếu giá hoặc sổ lệnh vô lý (bid ≤ 0, ask < bid) → null: không vào.
 */
export function newsEntryLimitPrice(input: {
  direction: TradeDirection;
  bid: DecimalInput | null;
  ask: DecimalInput | null;
  tickSize: DecimalInput;
}): Decimal | null {
  if (input.bid === null || input.ask === null) return null;
  const bid = dec(input.bid);
  const ask = dec(input.ask);
  if (!bid.gt(0) || ask.lt(bid)) return null;
  const mid = bid.add(ask).div(2);
  const offset = ask.sub(bid).div(2).add(mid.mul(NEWS_SIGNAL_ENTRY_SLIPPAGE_PCT).div(100));
  if (input.direction === TradeDirection.long)
    return roundToStep(mid.add(offset), input.tickSize, RoundMode.down);
  const price = roundToStep(mid.sub(offset), input.tickSize, RoundMode.up);
  return price.gt(0) ? price : null;
}

type Assets = BotVersionConfig["assets"];

/** Version cho phép `market` không. Không biết loại tài sản → phải được phép ở cả crypto lẫn stock (chặt hơn). */
function versionAllows(v: Assets, market: string, kind: AssetKind | null): boolean {
  if (v.mode === AssetMode.only) return v.markets.includes(market);
  if (v.mode === AssetMode.except && v.markets.includes(market)) return false;
  return kind === null ? v.crypto && v.stocks : kind === AssetKind.stock ? v.stocks : v.crypto;
}

/** Tập market của bot nằm trong tập của version (bot chỉ được thu hẹp). */
function assetsNarrow(v: Assets, b: Assets, kindOf: (market: string) => AssetKind | null): boolean {
  if (b.mode === AssetMode.only) return b.markets.every((m) => versionAllows(v, m, kindOf(m)));
  // Bot All / All except là tập mở: version Only these (tập đóng) luôn hẹp hơn.
  if (v.mode === AssetMode.only) return false;
  if ((b.crypto && !v.crypto) || (b.stocks && !v.stocks)) return false;
  if (v.mode === AssetMode.all) return true;
  // Version All except: mọi market version loại mà bot có thể cho phép thì bot cũng phải loại.
  return v.markets.every((m) => {
    if (b.mode === AssetMode.except && b.markets.includes(m)) return true;
    const k = kindOf(m);
    if (k === null) return !b.crypto && !b.stocks;
    return k === AssetKind.stock ? !b.stocks : !b.crypto;
  });
}

/**
 * Bot có chỉ thu hẹp version gốc không (DEC-360): Markets chỉ được thu hẹp (mọi market bot cho phép
 * thì version cũng cho phép), Min level chỉ được nâng. `kindOf`: loại tài sản của một market SoDEX, null khi không biết
 * (khi đó coi như có thể là cả hai, nên chặt hơn). Bằng nhau là hợp lệ. Gọi ở API (tạo, lưu) và ở engine lúc nạp bot.
 */
export function narrowsVersion(
  version: Pick<BotVersionConfig, "assets" | "minLevel">,
  bot: Pick<BotVersionConfig, "assets" | "minLevel">,
  kindOf: (market: string) => AssetKind | null = () => null,
): boolean {
  return (
    levelAtLeast(bot.minLevel, version.minLevel) && assetsNarrow(version.assets, bot.assets, kindOf)
  );
}

/**
 * Chốt thanh lý trước khi vào lệnh (#458): khoảng tới giá thanh lý isolated ước tính phải ≥ `NEWS_SIGNAL_LIQ_SL_MULTIPLE` ×
 * khoảng tới SL. Khoảng thanh lý theo công thức DEC-172 (`liquidationDistance`, bậc `marginTiers` của SoDEX chọn theo
 * notional = giá trần × khối lượng): chỉ là ước tính, bỏ qua phí và funding, nên giá thanh lý thật gần giá vào hơn; hệ số
 * 1.5× để bù phần đó. Thiếu bậc margin thì dùng `NEWS_SIGNAL_FALLBACK_MMR`, không khấu trừ (`fallback = true`). 1× luôn
 * đạt (ký quỹ bằng giá trị vị thế). `slPct`: khoảng SL theo % giá (ví dụ "6" = 6%).
 */
export function newsLiquidationCheck(input: {
  side: "long" | "short";
  leverage: number;
  slPct: DecimalInput;
  notional: DecimalInput;
  tiers: readonly MarginTier[] | undefined;
}): { ok: boolean; distance: Decimal | null; fallback: boolean } {
  if (input.leverage <= 1) return { ok: true, distance: null, fallback: false };
  const fallback = input.tiers === undefined || input.tiers.length === 0;
  const tiers: readonly MarginTier[] = fallback
    ? [
        {
          maxNotionalValue: "1000000000000000",
          maintenanceMarginRate: NEWS_SIGNAL_FALLBACK_MMR,
          maxLeverage: input.leverage,
          maintenanceDeduction: "0",
        },
      ]
    : (input.tiers ?? []);
  const distance = liquidationDistance({
    tiers,
    leverage: input.leverage,
    notional: dec(input.notional).toString(),
    side: input.side,
  });
  // Notional vượt mọi bậc (không thể với trần 200 USDC) thì không biết khoảng thanh lý: không vào.
  if (distance === null) return { ok: false, distance: null, fallback };
  const sl = dec(input.slPct).div(100);
  return { ok: distance.gte(sl.mul(NEWS_SIGNAL_LIQ_SL_MULTIPLE)), distance, fallback };
}
