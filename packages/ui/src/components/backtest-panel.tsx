import { useId } from "react";

import { cx } from "../lib/cx";
import type { DataStatus, Timestamp } from "../lib/data-state";

import { Button } from "./button";
import { EmptyState } from "./empty-state";
import { ErrorState } from "./error-state";
import { Skeleton } from "./skeleton";
import { StaleBadge } from "./stale-badge";

export interface BacktestMetric {
  label: string;
  /** Giá trị đã format; `null` thì hiện `missingLabel`, không hiện 0. */
  value: string | null;
}

export interface BacktestPanelProps {
  title: string;
  /** Câu nói rõ đây là mô phỏng, không phải dự báo (DEC-11). Luôn hiển thị. */
  disclaimer: string;
  /**
   * `empty`: chưa chạy. `loading`: đang chạy. `ready`: có kết quả.
   * `stale` đi kèm `ready` khi tham số đã đổi sau lần chạy.
   */
  status: DataStatus;
  runLabel: string;
  onRun: () => void;
  /** Market không có dữ liệu backtest; nút chạy bị khoá và hiện lý do. */
  unavailableReason?: string;
  emptyTitle: string;
  emptyDescription?: string;
  progress?: { label: string; percent: number };
  errorTitle: string;
  errorDescription?: string;
  metrics?: readonly BacktestMetric[];
  missingLabel: string;
  stale?: { label: string; updatedAt?: Timestamp };
  className?: string;
}

export function BacktestPanel({
  title,
  disclaimer,
  status,
  runLabel,
  onRun,
  unavailableReason,
  emptyTitle,
  emptyDescription,
  progress,
  errorTitle,
  errorDescription,
  metrics = [],
  missingLabel,
  stale,
  className,
}: BacktestPanelProps) {
  const id = useId();
  const progressLabelId = `${id}-progress`;
  const reasonId = `${id}-unavailable`;
  const running = status === "loading";
  const unavailable = unavailableReason !== undefined;

  return (
    <section
      aria-label={title}
      aria-busy={running || undefined}
      className={cx(
        "flex flex-col gap-4 rounded-card border border-border bg-surface p-5",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-ink">{title}</h2>
        {status === "ready" && stale ? (
          <StaleBadge
            label={stale.label}
            {...(stale.updatedAt ? { updatedAt: stale.updatedAt } : {})}
          />
        ) : null}
      </div>
      <p className="text-xs font-medium text-ink-2">{disclaimer}</p>

      {unavailable ? (
        <p
          id={reasonId}
          className="rounded-tile bg-surface-2 px-4 py-3 text-sm font-medium text-ink-2"
        >
          {unavailableReason}
        </p>
      ) : null}

      {!unavailable && status === "empty" ? (
        <EmptyState
          title={emptyTitle}
          {...(emptyDescription ? { description: emptyDescription } : {})}
        />
      ) : null}

      {!unavailable && running ? (
        <div className="flex flex-col gap-2">
          {progress ? (
            <>
              <div className="flex justify-between text-xs font-semibold text-ink-2">
                <span id={progressLabelId}>{progress.label}</span>
                <span>{Math.round(progress.percent)}%</span>
              </div>
              <div
                role="progressbar"
                aria-labelledby={progressLabelId}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress.percent)}
                className="h-2 overflow-hidden rounded-full bg-surface-2"
              >
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${String(Math.min(100, Math.max(0, progress.percent)))}%` }}
                />
              </div>
            </>
          ) : null}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        </div>
      ) : null}

      {!unavailable && status === "error" ? (
        <ErrorState
          title={errorTitle}
          {...(errorDescription ? { description: errorDescription } : {})}
        />
      ) : null}

      {!unavailable && status === "ready" ? (
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className="flex min-w-0 flex-col gap-1 rounded-tile bg-surface-2 p-3"
            >
              <dt className="text-xs font-semibold text-muted">{metric.label}</dt>
              <dd
                className={cx(
                  "break-words text-base font-bold tabular-nums",
                  metric.value === null ? "text-muted" : "text-ink",
                )}
              >
                {metric.value ?? missingLabel}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div>
        <Button
          variant="tonal"
          onClick={onRun}
          pending={running}
          disabled={unavailable}
          {...(unavailable ? { "aria-describedby": reasonId } : {})}
        >
          {runLabel}
        </Button>
      </div>
    </section>
  );
}
