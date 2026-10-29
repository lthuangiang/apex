import { formatDecimal, isNegative, isZero } from "@drift/shared";

import { cx } from "../lib/cx";

export interface PnLValueProps {
  /** Chuỗi thập phân từ API; `null` khi backend không trả (quy tắc 1.8). */
  value: string | null;
  locale: string;
  /** Hiện khi `value` null, ví dụ "Not available". Không bao giờ hiện 0. */
  missingLabel: string;
  /** Hậu tố hiển thị, ví dụ " USDC" hoặc "%". */
  suffix?: string;
  maximumFractionDigits?: number;
  className?: string;
}

/** Lãi/lỗ: dấu + mũi tên + màu, để trạng thái không chỉ thể hiện bằng màu. */
export function PnLValue({
  value,
  locale,
  missingLabel,
  suffix = "",
  maximumFractionDigits = 2,
  className,
}: PnLValueProps) {
  if (value === null) {
    return <span className={cx("text-muted", className)}>{missingLabel}</span>;
  }
  const zero = isZero(value);
  const negative = isNegative(value);
  const text = formatDecimal(value, {
    locale,
    maximumFractionDigits,
    signDisplay: "exceptZero",
  });
  return (
    <span
      data-sign={zero ? "zero" : negative ? "negative" : "positive"}
      className={cx(
        "inline-flex items-center gap-1 font-semibold tabular-nums",
        zero ? "text-ink-2" : negative ? "text-neg-ink" : "text-pos",
        className,
      )}
    >
      {zero ? null : <span aria-hidden="true">{negative ? "▼" : "▲"}</span>}
      {text}
      {suffix}
    </span>
  );
}
