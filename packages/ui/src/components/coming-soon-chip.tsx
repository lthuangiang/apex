import { cx } from "../lib/cx";

export interface ComingSoonChipProps {
  /** Ví dụ "Paper · Coming soon". Câu chữ tự nói lý do bị disable (mục 12, UI). */
  label: string;
  className?: string;
}

export function ComingSoonChip({ label, className }: ComingSoonChipProps) {
  return (
    <span
      aria-disabled="true"
      className={cx(
        "inline-flex cursor-not-allowed items-center rounded-full border border-dashed border-border-input bg-surface-2 px-2.5 py-1 text-xs font-semibold text-muted",
        className,
      )}
    >
      {label}
    </span>
  );
}
