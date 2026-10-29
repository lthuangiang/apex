import { Clock } from "lucide-react";

import { cx } from "../lib/cx";
import type { Timestamp } from "../lib/data-state";

export interface StaleBadgeProps {
  /** Ví dụ "Stale". */
  label: string;
  updatedAt?: Timestamp;
  className?: string;
}

/** Trạng thái stale: badge + thời điểm cập nhật (docs/DESIGN.md D5). */
export function StaleBadge({ label, updatedAt, className }: StaleBadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full bg-warn-bg px-2.5 py-1 text-xs font-semibold text-warn",
        className,
      )}
    >
      <Clock aria-hidden="true" className="size-3.5" strokeWidth={2} />
      {label}
      {updatedAt ? (
        <>
          <span aria-hidden="true">·</span>
          <time dateTime={updatedAt.dateTime}>{updatedAt.text}</time>
        </>
      ) : null}
    </span>
  );
}
