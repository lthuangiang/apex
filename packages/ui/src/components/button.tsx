import type { ButtonHTMLAttributes } from "react";

import { cx } from "../lib/cx";

export type ButtonVariant = "primary" | "secondary" | "tonal" | "danger" | "dark";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Đang chờ backend: nút bị disable để chống double submit (mục 12). */
  pending?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-ink",
  secondary: "border border-border-input bg-surface text-ink hover:bg-surface-2",
  tonal: "bg-accent-tint text-accent-ink hover:bg-border",
  danger: "bg-neg text-white hover:bg-neg-ink",
  dark: "bg-ink text-white hover:bg-ink-2",
};

export function Button({
  variant = "primary",
  pending = false,
  disabled,
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled === true || pending}
      aria-busy={pending || undefined}
      className={cx(
        "inline-flex min-h-tap items-center justify-center gap-2 rounded-control px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        VARIANT[variant],
        // Chưa đủ điều kiện (không phải đang chờ backend): xám trung tính, không mang màu của variant (UI_REVIEW E7).
        "disabled:not-aria-busy:border-transparent disabled:not-aria-busy:bg-surface-2 disabled:not-aria-busy:text-muted disabled:not-aria-busy:opacity-100",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
