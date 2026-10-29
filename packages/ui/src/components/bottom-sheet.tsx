import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

import { cx } from "../lib/cx";
import { useReturnFocus } from "../lib/use-return-focus";

export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Nút chính ghim ở đáy, có safe-area padding (docs/DESIGN.md, Responsive). */
  footer?: ReactNode;
}

const overlayClass = "fixed inset-0 z-50 bg-ink/40";

/**
 * Dialog trên mobile. Dưới 768px là sheet bám đáy; từ 768px là dialog giữa màn hình.
 * Radix giữ focus trong dialog và trả focus về chỗ cũ khi đóng.
 */
export const dialogContentClass =
  "fixed z-50 flex max-h-[90dvh] flex-col gap-4 overflow-y-auto bg-surface p-5 shadow-xl inset-x-0 bottom-0 rounded-t-card pb-[calc(1.25rem+env(safe-area-inset-bottom))] md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:w-full md:max-w-lg md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-card md:pb-5";

export function BottomSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: BottomSheetProps) {
  const returnFocus = useReturnFocus();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlayClass} />
        <Dialog.Content
          className={dialogContentClass}
          {...returnFocus}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <Dialog.Title className="text-lg font-bold text-ink">{title}</Dialog.Title>
          {description ? (
            <Dialog.Description className="text-sm text-ink-2">{description}</Dialog.Description>
          ) : null}
          <div className="flex flex-col gap-4">{children}</div>
          {footer ? (
            <div
              className={cx(
                "sticky bottom-0 flex flex-col gap-2 bg-surface pt-2 md:flex-row md:justify-end",
              )}
            >
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export { overlayClass as dialogOverlayClass };
