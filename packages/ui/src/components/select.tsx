import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";

import { cx } from "../lib/cx";

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> {
  /** Class của khung ngoài (bề rộng, vị trí trong layout); `<select>` bên trong luôn rộng hết khung. */
  className?: string;
}

/**
 * Ô chọn dùng `<select>` gốc (bàn phím, trình đọc màn hình, danh sách gốc trên mobile) nhưng bỏ kiểu mặc định của trình
 * duyệt (`appearance-none`) và tự vẽ chevron, để Safari / Firefox / Chrome trông giống nhau (#457). Viền 2px `accent`, chữ
 * đậm, cao ≥ 44px như ô Bot / Version của Signal Research. Chevron chỉ để nhìn (`aria-hidden`, không nhận bấm).
 */
export function Select({ className, disabled, children, ...props }: SelectProps) {
  return (
    <span className={cx("relative inline-flex min-w-0 items-center", className)}>
      <select
        {...props}
        disabled={disabled}
        className="min-h-11 w-full min-w-0 cursor-pointer appearance-none rounded-control border-2 border-accent bg-surface py-0 pr-9 pl-3 text-sm font-extrabold text-ink disabled:cursor-not-allowed disabled:opacity-60"
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        size={16}
        strokeWidth={2.4}
        className="pointer-events-none absolute right-3 text-ink-2"
      />
    </span>
  );
}
