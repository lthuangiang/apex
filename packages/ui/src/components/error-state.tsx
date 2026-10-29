import { AlertTriangle } from "lucide-react";

import { cx } from "../lib/cx";

import { Button } from "./button";

export interface ErrorStateProps {
  title: string;
  description?: string;
  retryLabel?: string;
  onRetry?: () => void;
  className?: string;
}

/** Trạng thái lỗi: thông báo + thử lại (D5). Lỗi dùng nền đỏ nhạt, không dùng nền đỏ đặc. */
export function ErrorState({
  title,
  description,
  retryLabel,
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cx("flex flex-col items-start gap-3 rounded-tile bg-neg-bg px-5 py-4", className)}
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-neg-ink">
        <AlertTriangle aria-hidden="true" className="size-4" strokeWidth={2} />
        {title}
      </p>
      {description ? <p className="text-sm text-ink-2">{description}</p> : null}
      {retryLabel && onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
