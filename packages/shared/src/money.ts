import DecimalBase from "decimal.js";

// CODING_STANDARDS C9: precision 40, không dùng float cho tiền/giá/khối lượng.
// Clone riêng để không đổi cấu hình global của decimal.js cho package khác.
export const Decimal = DecimalBase.clone({ precision: 40, rounding: DecimalBase.ROUND_HALF_UP });
export type Decimal = InstanceType<typeof Decimal>;

/** Chuỗi số thập phân như API trả về (CODING_STANDARDS C7): "129948.11", "-0.5". */
export const DECIMAL_STRING_PATTERN = /^-?(0|[1-9]\d*)(\.\d+)?$/;

export type DecimalInput = string | Decimal;

export function dec(value: DecimalInput): Decimal {
  if (typeof value === "string") {
    if (!DECIMAL_STRING_PATTERN.test(value)) {
      throw new RangeError(`Invalid decimal string: ${JSON.stringify(value)}`);
    }
    return new Decimal(value);
  }
  return value;
}

export function add(a: DecimalInput, b: DecimalInput): Decimal {
  return dec(a).plus(dec(b));
}

export function sub(a: DecimalInput, b: DecimalInput): Decimal {
  return dec(a).minus(dec(b));
}

export function mul(a: DecimalInput, b: DecimalInput): Decimal {
  return dec(a).times(dec(b));
}

export function div(a: DecimalInput, b: DecimalInput): Decimal {
  const divisor = dec(b);
  if (divisor.isZero()) {
    throw new RangeError("Division by zero");
  }
  return dec(a).dividedBy(divisor);
}

export function sum(values: readonly DecimalInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new Decimal(0));
}

export function eq(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).equals(dec(b));
}

export function gt(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).greaterThan(dec(b));
}

export function gte(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).greaterThanOrEqualTo(dec(b));
}

export function lt(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).lessThan(dec(b));
}

export function lte(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).lessThanOrEqualTo(dec(b));
}

export function isZero(a: DecimalInput): boolean {
  return dec(a).isZero();
}

export function isNegative(a: DecimalInput): boolean {
  const d = dec(a);
  return d.isNegative() && !d.isZero();
}

export const RoundMode = { down: "down", up: "up", nearest: "nearest" } as const;
export type RoundMode = (typeof RoundMode)[keyof typeof RoundMode];

/**
 * Làm tròn theo bội số của `step` (tick cho giá, lot cho khối lượng).
 * Đây là một trong hai chỗ được phép làm tròn (CODING_STANDARDS C9).
 */
export function roundToStep(value: DecimalInput, step: DecimalInput, mode: RoundMode): Decimal {
  const s = dec(step);
  if (!s.isPositive() || s.isZero()) {
    throw new RangeError("Step must be greater than 0");
  }
  const units = dec(value).dividedBy(s);
  const rounding =
    mode === RoundMode.down
      ? Decimal.ROUND_FLOOR
      : mode === RoundMode.up
        ? Decimal.ROUND_CEIL
        : Decimal.ROUND_HALF_UP;
  return units.toDecimalPlaces(0, rounding).times(s);
}

/** Chuỗi thập phân không dùng ký hiệu mũ, để trả qua API hoặc lưu `numeric`. */
export function toDecimalString(value: DecimalInput): string {
  const d = dec(value);
  return d.isZero() ? "0" : d.toFixed();
}
