import { useId, type ReactNode } from "react";

import { cx } from "../lib/cx";

export type FieldSourceTone = "ai" | "edited";

export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

export interface FieldProps {
  label: string;
  /** Chip nguồn giá trị: "AI" hoặc "Edited" (docs/DESIGN.md mục 13). */
  source?: { tone: FieldSourceTone; label: string };
  unit?: string;
  hint?: string;
  error?: string;
  /** Lý do field bị khoá; luôn hiển thị, không chỉ làm mờ (mục 12, UI). */
  lockedReason?: string;
  /** Nhận id + aria props để gắn vào input thật. */
  children: (props: FieldControlProps) => ReactNode;
  className?: string;
}

export function Field({
  label,
  source,
  unit,
  hint,
  error,
  lockedReason,
  children,
  className,
}: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const lockedId = `${id}-locked`;
  const unitId = `${id}-unit`;
  const describedBy = [
    unit ? unitId : null,
    hint ? hintId : null,
    lockedReason ? lockedId : null,
    error ? errorId : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-sm font-semibold text-ink">
          {label}
        </label>
        {source ? (
          <span
            data-source={source.tone}
            className={cx(
              "rounded-full px-2 py-0.5 text-[12px] font-semibold",
              source.tone === "ai" ? "bg-accent-tint text-accent-ink" : "bg-surface-2 text-ink-2",
            )}
          >
            {source.label}
          </span>
        ) : null}
      </div>
      {/* Đơn vị nằm bên trong ô (artboard Create): input chừa chỗ bên phải. */}
      <div className={cx("relative min-w-0", unit ? "[&_input]:pr-16" : undefined)}>
        {children({
          id,
          ...(describedBy ? { "aria-describedby": describedBy } : {}),
          ...(error ? { "aria-invalid": true as const } : {}),
        })}
        {unit ? (
          <span
            id={unitId}
            className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-[13px] font-bold text-ink-2"
          >
            {unit}
          </span>
        ) : null}
      </div>
      {hint ? (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {lockedReason ? (
        <p id={lockedId} className="text-xs font-medium text-ink-2">
          {lockedReason}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs font-semibold text-neg-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Input chuẩn dùng trong Field: vùng bấm ≥ 44px, viền đỏ khi `aria-invalid`. */
export const inputClassName =
  "min-h-tap w-full rounded-control border border-border-input bg-surface px-3 text-sm text-ink tabular-nums placeholder:text-muted aria-invalid:border-neg disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted";
