import * as Dialog from "@radix-ui/react-dialog";
import { useId } from "react";

import { useReturnFocus } from "../lib/use-return-focus";

import { dialogContentClass, dialogOverlayClass } from "./bottom-sheet";
import { Button } from "./button";
import { inputClassName } from "./field";

export interface TwoFactorInput {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Danh sách hệ quả cụ thể (docs/DESIGN.md D6). */
  consequencesLabel: string;
  consequences: readonly string[];
  confirmLabel: string;
  cancelLabel: string;
  tone?: "primary" | "danger";
  /** Thao tác nguy hiểm yêu cầu 2FA ở server; đây chỉ là ô nhập. */
  twoFactor?: TwoFactorInput;
  /** Đang chờ backend; nút xác nhận bị khoá, hiện `pendingLabel`. */
  pending?: boolean;
  pendingLabel?: string;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  consequencesLabel,
  consequences,
  confirmLabel,
  cancelLabel,
  tone = "primary",
  twoFactor,
  pending = false,
  pendingLabel,
  onConfirm,
}: ConfirmDialogProps) {
  const id = useId();
  const returnFocus = useReturnFocus();
  const listId = `${id}-consequences`;
  const codeId = `${id}-code`;
  const codeErrorId = `${id}-code-error`;
  const codeMissing = twoFactor?.value.trim() === "";

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // Không đóng giữa chừng khi request đang chờ backend.
        if (!pending) onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClass} />
        <Dialog.Content className={dialogContentClass} aria-describedby={listId} {...returnFocus}>
          <Dialog.Title className="text-lg font-bold text-ink">{title}</Dialog.Title>
          <div id={listId} className="flex flex-col gap-2">
            <p className="text-sm font-semibold text-ink-2">{consequencesLabel}</p>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink">
              {consequences.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          {twoFactor ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={codeId} className="text-sm font-semibold text-ink">
                {twoFactor.label}
              </label>
              <input
                id={codeId}
                inputMode="numeric"
                autoComplete="one-time-code"
                value={twoFactor.value}
                onChange={(event) => {
                  twoFactor.onChange(event.target.value);
                }}
                disabled={pending}
                className={inputClassName}
                {...(twoFactor.error
                  ? { "aria-invalid": true, "aria-describedby": codeErrorId }
                  : {})}
              />
              {twoFactor.error ? (
                <p id={codeErrorId} className="text-xs font-semibold text-neg-ink">
                  {twoFactor.error}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
            <Dialog.Close asChild>
              <Button variant="secondary" disabled={pending}>
                {cancelLabel}
              </Button>
            </Dialog.Close>
            <Button
              variant={tone === "danger" ? "danger" : "primary"}
              pending={pending}
              disabled={codeMissing}
              onClick={onConfirm}
            >
              {pending && pendingLabel ? pendingLabel : confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
