import type { ReactNode } from "react";

import { cx } from "../lib/cx";
import type { DataStatus, Timestamp } from "../lib/data-state";

import { EmptyState, type EmptyStateProps } from "./empty-state";
import { ErrorState, type ErrorStateProps } from "./error-state";
import { Skeleton } from "./skeleton";
import { StaleBadge } from "./stale-badge";

export interface DataRegionProps {
  /** Tên vùng cho trình đọc màn hình. */
  label: string;
  status: DataStatus;
  empty: EmptyStateProps;
  error: ErrorStateProps;
  stale?: { label: string; updatedAt?: Timestamp };
  /** Skeleton riêng; mặc định là 3 dòng. */
  loading?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** Bao một vùng dữ liệu bất đồng bộ với đủ loading / empty / error / stale (D5). */
export function DataRegion({
  label,
  status,
  empty,
  error,
  stale,
  loading,
  children,
  className,
}: DataRegionProps) {
  return (
    <section
      aria-label={label}
      aria-busy={status === "loading" || undefined}
      className={cx("flex min-w-0 flex-col gap-3", className)}
    >
      {status === "ready" && stale ? (
        <div>
          <StaleBadge
            label={stale.label}
            {...(stale.updatedAt ? { updatedAt: stale.updatedAt } : {})}
          />
        </div>
      ) : null}
      {status === "loading"
        ? (loading ?? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
            </div>
          ))
        : null}
      {status === "empty" ? <EmptyState {...empty} /> : null}
      {status === "error" ? <ErrorState {...error} /> : null}
      {status === "ready" ? children : null}
    </section>
  );
}
