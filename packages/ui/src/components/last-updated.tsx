import { cx } from "../lib/cx";
import type { Timestamp } from "../lib/data-state";

export interface LastUpdatedProps {
  /** Ví dụ "Updated". */
  label: string;
  at: Timestamp;
  className?: string;
}

export function LastUpdated({ label, at, className }: LastUpdatedProps) {
  return (
    <span className={cx("text-xs text-muted", className)}>
      {label} <time dateTime={at.dateTime}>{at.text}</time>
    </span>
  );
}
