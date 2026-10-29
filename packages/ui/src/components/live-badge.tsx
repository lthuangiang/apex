import { cx } from "../lib/cx";

export interface LiveBadgeProps {
  /** Ví dụ "LIVE · MAINNET". Câu chữ lấy từ i18n của app. */
  label: string;
  className?: string;
}

/** Badge LIVE: nền đỏ đặc (mục 12, UI). */
export function LiveBadge({ label, className }: LiveBadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full bg-neg px-2.5 py-1 text-xs font-bold tracking-wide text-white",
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-white" />
      {label}
    </span>
  );
}
