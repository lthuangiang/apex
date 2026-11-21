import { z } from "zod";

import { dec, Decimal, roundToStep, RoundMode, type DecimalInput } from "../money";
import { decimalStringSchema } from "../schemas";

import { AssetKind, TradeDirection } from "./rules";
import { AssetMode, botVersionConfigSchema, levelAtLeast, type BotVersionConfig } from "./versions";

// Bot `news_signal` trên SoDEX mainnet (#418, #419, DEC-360). Bot tạo mới từ một Signal research
// version mà user thấy được (version của team hoặc My versions), chạy tiền thật. Bot paper cá nhân là My versions (#423),
// không thuộc file này. Hàm ở đây thuần, không I/O; API (lúc tạo / lưu) và engine (`#load`, `#execute`) dùng chung.

/** Trần size mỗi lệnh của bot mainnet (USDC), cho tới khi có quyết định khác. */
export const NEWS_SIGNAL_LIVE_MAX_USDC = "200";
/** Đòn bẩy cố định của bot mainnet. */
export const NEWS_SIGNAL_LEVERAGE = 1;
/** Tín hiệu cũ hơn ngần này (tính từ lúc tín hiệu được ghi) thì bỏ với `SIGNAL_STALE`. */
export const NEWS_SIGNAL_TTL_MS = 120_000;
/** Trượt giá thêm cho lệnh vào limit IOC, ngoài nửa spread (phần trăm của giá giữa). */
export const NEWS_SIGNAL_ENTRY_SLIPPAGE_PCT = "0.2";

const sizeSchema = decimalStringSchema
  .refine((v) => dec(v).gt(0), "Must be above 0")
  .refine((v) => dec(v).lte(NEWS_SIGNAL_LIVE_MAX_USDC), "Above the 200 USDC cap");

/**
 * Config của một bot `news_signal` mainnet: config đầy đủ của version (chép từ version gốc) cộng các trường của bot. Size
 * mỗi lệnh ≤ `NEWS_SIGNAL_LIVE_MAX_USDC`, đòn bẩy luôn 1. Max open trades / Max new trades per day dùng đúng các trường
 * của version (người tạo bot chọn).
 */
export const newsSignalConfigSchema = botVersionConfigSchema.extend({
  sizeUsdc: sizeSchema,
  leverage: z.literal(NEWS_SIGNAL_LEVERAGE),
});
export type NewsSignalConfig = z.infer<typeof newsSignalConfigSchema>;

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
