import type { ReactNode } from "react";

import { cx } from "../lib/cx";

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Hành động tiếp theo (bắt buộc theo D5 khi có). */
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  return (
    <div
      className={cx(
        "flex flex-col items-center gap-3 rounded-tile bg-surface-2 px-6 py-8 text-center",
        className,
      )}
    >
      {icon ? (
        <span aria-hidden="true" className="text-muted">
          {icon}
        </span>
      ) : null}
      <p className="text-base font-semibold text-ink">{title}</p>
      {description ? <p className="max-w-prose text-sm text-ink-2">{description}</p> : null}
      {action}
    </div>
  );
}
