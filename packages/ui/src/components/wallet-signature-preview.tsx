import { cx } from "../lib/cx";

export interface SignatureField {
  label: string;
  value: string;
  /** Làm nổi các field người dùng cần đọc kỹ, ví dụ `maxFeeRate`. */
  emphasis?: boolean;
}

export interface WalletSignaturePreviewProps {
  title: string;
  /** Tên action EIP-712, ví dụ `AddAPIKeyWithBuilder`. */
  action: string;
  fields: readonly SignatureField[];
  /** Ghi chú dưới cùng, ví dụ "Withdraw or transfer: never". */
  note?: string;
  className?: string;
}

/**
 * Xem trước nội dung ví sẽ ký. Chỉ hiển thị field công khai; không bao giờ truyền
 * private key, secret hay payload đã ký vào đây (quy tắc 1.9).
 */
export function WalletSignaturePreview({
  title,
  action,
  fields,
  note,
  className,
}: WalletSignaturePreviewProps) {
  return (
    <section
      aria-label={title}
      className={cx(
        "flex flex-col gap-3 rounded-tile border border-border bg-surface-2 p-4",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-ink">{title}</h3>
        <code className="rounded-md bg-surface px-2 py-0.5 text-xs font-semibold text-accent-ink">
          {action}
        </code>
      </div>
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        {fields.map((field) => (
          <div key={field.label} className="contents">
            <dt className="text-muted">{field.label}</dt>
            <dd
              className={cx(
                "break-all text-right font-mono tabular-nums",
                field.emphasis ? "font-bold text-ink" : "text-ink-2",
              )}
            >
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
      {note ? <p className="text-xs font-semibold text-ink-2">{note}</p> : null}
    </section>
  );
}
