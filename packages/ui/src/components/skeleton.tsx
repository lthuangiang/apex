import { cx } from "../lib/cx";

export interface SkeletonProps {
  className?: string;
}

/** Khối chờ tải (trạng thái loading, docs/DESIGN.md D5). Ẩn với trình đọc màn hình. */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cx("block rounded-control bg-surface-2 motion-safe:animate-pulse", className)}
    />
  );
}
