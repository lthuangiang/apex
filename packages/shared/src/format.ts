import { feeRateToPercent } from "./fees";
import { DECIMAL_STRING_PATTERN, dec, type DecimalInput } from "./money";

// Format chỉ dùng ở tầng hiển thị (CODING_STANDARDS C9, mục 12).
// Mọi hàm trả `null` khi thiếu dữ liệu; UI hiện "Not provided" / "Not available",
// không bao giờ hiện 0 (quy tắc 1.8).

export interface NumberFormatOptions {
  locale: string;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  signDisplay?: "auto" | "always" | "exceptZero" | "negative" | "never";
  notation?: "standard" | "compact";
}

type Maybe<T> = T | null | undefined;

// `Intl.NumberFormat.format` nhận chuỗi thập phân chính xác (ES2023), không đi qua float.
function isNumericLiteral(value: string): value is `${number}` {
  return DECIMAL_STRING_PATTERN.test(value);
}

function intlFormat(value: DecimalInput, options: Intl.NumberFormatOptions, locale: string) {
  const fixed = dec(value).toFixed();
  if (!isNumericLiteral(fixed)) {
    throw new RangeError(`Cannot format ${fixed}`);
  }
  return new Intl.NumberFormat(locale, options).format(fixed);
}

export function formatDecimal(
  value: Maybe<DecimalInput>,
  options: NumberFormatOptions,
): string | null {
  if (value === null || value === undefined) return null;
  const notation = options.notation ?? "standard";
  const intlOptions: Intl.NumberFormatOptions = {
    signDisplay: options.signDisplay ?? "auto",
    notation,
  };
  if (options.minimumFractionDigits !== undefined) {
    intlOptions.minimumFractionDigits = options.minimumFractionDigits;
  }
  // Mặc định hiện đủ chữ số của giá trị thật; dạng compact dùng mặc định của Intl.
  const maxDigits = options.maximumFractionDigits ?? (notation === "standard" ? 20 : undefined);
  if (maxDigits !== undefined) {
    intlOptions.maximumFractionDigits = maxDigits;
  }
  return intlFormat(value, intlOptions, options.locale);
}

/** `value` là phần trăm thô, ví dụ "12.5" → "12.5%". */
export function formatPercent(
  value: Maybe<DecimalInput>,
  options: NumberFormatOptions,
): string | null {
  const formatted = formatDecimal(value, options);
  return formatted === null ? null : `${formatted}%`;
}

/** Tỷ lệ phí theo phần mười bp, ví dụ 50 → "0.05%". */
export function formatFeeRate(rate: Maybe<number>, locale: string): string | null {
  if (rate === null || rate === undefined) return null;
  return formatPercent(feeRateToPercent(rate), { locale, maximumFractionDigits: 4 });
}

const MASK = "••";
const VISIBLE_KEY_CHARS = 4;

/** Key chỉ hiện 4 ký tự cuối, dạng `••4f2a` (quy tắc 1.9). */
export function maskKey(value: Maybe<string>): string | null {
  if (value === null || value === undefined || value.length < VISIBLE_KEY_CHARS) return null;
  return `${MASK}${value.slice(-VISIBLE_KEY_CHARS)}`;
}

/** Thời gian theo múi giờ IANA của người dùng (mục 12: múi giờ). */
export function formatDateTime(
  iso: Maybe<string>,
  options: { locale: string; timeZone: string },
): string | null {
  if (iso === null || iso === undefined) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: options.timeZone,
  }).format(date);
}
