import type { ReactNode } from "react";

import { cx } from "../lib/cx";
import type { DataStatus, Timestamp } from "../lib/data-state";

import { Button } from "./button";
import { Skeleton } from "./skeleton";
import { StaleBadge } from "./stale-badge";

export interface MetricCardProps {
  label: string;
  status: DataStatus;
  /** Giá trị đã format. Dùng khi `status` là `ready`. */
  value?: ReactNode;
  /** Hiện khi `status` là `empty`, ví dụ "Not available" (không bao giờ hiện 0). */
  emptyLabel: string;
  hint?: ReactNode;
  errorLabel?: string;
  retryLabel?: string;
  onRetry?: () => void;
  stale?: { label: string; updatedAt?: Timestamp };
  className?: string;
}

export function MetricCard({
  label,
  status,
  value,
  emptyLabel,
  hint,
  errorLabel,
  retryLabel,
  onRetry,
  stale,
  className,
}: MetricCardProps) {
  return (
    <section
      aria-busy={status === "loading" || undefined}
      className={cx(
        "flex min-w-0 flex-col gap-2 rounded-tile border border-border bg-surface p-4",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-muted">{label}</h3>
        {status === "ready" && stale ? (
          <StaleBadge
            label={stale.label}
            {...(stale.updatedAt ? { updatedAt: stale.updatedAt } : {})}
          />
        ) : null}
      </div>
      {status === "loading" ? <Skeleton className="h-8 w-28" /> : null}
      {status === "empty" ? (
        <p className="text-base font-semibold text-muted">{emptyLabel}</p>
      ) : null}
      {status === "error" ? (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-neg-ink">{errorLabel}</p>
          {retryLabel && onRetry ? (
            <Button variant="secondary" onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
      {status === "ready" ? (
        <p className="break-words text-2xl font-bold text-ink tabular-nums">{value}</p>
      ) : null}
      {hint && status === "ready" ? <div className="text-xs text-ink-2">{hint}</div> : null}
    </section>
  );
}
