import { cx } from "../lib/cx";

export type ChecklistStatus = "pass" | "fail" | "pending";

export interface ChecklistRowProps {
  status: ChecklistStatus;
  /** Nhãn chữ của trạng thái cho trình đọc màn hình, ví dụ "Passed". */
  statusLabel: string;
  label: string;
  detail?: string;
  /** Link sửa khi kiểm tra không đạt. */
  fix?: { label: string; href: string };
  className?: string;
}

const ICON: Record<ChecklistStatus, { symbol: string; className: string }> = {
  pass: { symbol: "✓", className: "bg-pos-bg text-pos" },
  fail: { symbol: "✕", className: "bg-neg-bg text-neg-ink" },
  pending: { symbol: "…", className: "bg-surface-2 text-muted" },
};

export function ChecklistRow({
  status,
  statusLabel,
  label,
  detail,
  fix,
  className,
}: ChecklistRowProps) {
  const icon = ICON[status];
  return (
    <div data-status={status} className={cx("flex items-start gap-3 py-2", className)}>
      <span
        aria-hidden="true"
        className={cx(
          "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold",
          icon.className,
        )}
      >
        {icon.symbol}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-semibold text-ink">
          <span className="sr-only">{statusLabel}: </span>
          {label}
        </p>
        {detail ? <p className="text-xs text-ink-2">{detail}</p> : null}
      </div>
      {status === "fail" && fix ? (
        <a
          href={fix.href}
          className="inline-flex min-h-tap shrink-0 items-center text-sm font-semibold text-accent-ink underline underline-offset-2"
        >
          {fix.label}
        </a>
      ) : null}
    </div>
  );
}
