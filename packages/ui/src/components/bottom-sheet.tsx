import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

import { cx } from "../lib/cx";
import { useReturnFocus } from "../lib/use-return-focus";

export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Nhãn nhỏ đứng cạnh tiêu đề (ví dụ "Mainnet" của drawer How it works, #454); không thuộc tên của dialog. */
  titleAside?: ReactNode;
  description?: string;
  children: ReactNode;
  /** Nút chính ghim ở đáy, có safe-area padding (docs/DESIGN.md, Responsive). */
  footer?: ReactNode;
  /** Dưới 768px chiếm toàn màn hình (ví dụ panel thông báo); từ 768px vẫn là dialog giữa màn hình. */
  fullScreen?: boolean;
  /** Có thì hiện nút × ở góc tiêu đề, tên đọc là chuỗi này (ví dụ "Close"). */
  closeLabel?: string;
  /** Từ 768px: dialog rộng (tới 64rem) cho bảng nhiều cột, thay vì 32rem. */
  wide?: boolean;
  /**
   * Từ 768px: sheet bám cạnh phải, cao hết màn hình (tới 48rem), cho form dài (ví dụ tạo News bot version, #306).
   * Dưới 768px giống `fullScreen`.
   */
  side?: boolean;
  /** Esc: gọi `event.preventDefault()` để không đóng (ví dụ khi một danh sách bên trong đang mở và Esc chỉ đóng nó). */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
}

const overlayClass = "fixed inset-0 z-50 bg-ink/40";

const sideClass =
  "fixed z-50 flex flex-col gap-4 overflow-y-auto bg-surface p-5 shadow-xl inset-0 max-h-dvh pt-[calc(1.25rem+env(safe-area-inset-top))] pb-[calc(1.25rem+env(safe-area-inset-bottom))] md:inset-y-4 md:left-auto md:right-4 md:max-h-[calc(100dvh-2rem)] md:w-full md:max-w-3xl md:rounded-card md:p-6";

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
  titleAside,
  description,
  children,
  footer,
  fullScreen = false,
  closeLabel,
  wide = false,
  side = false,
  onEscapeKeyDown,
}: BottomSheetProps) {
  const returnFocus = useReturnFocus();
  const heading =
    titleAside === undefined ? (
      <Dialog.Title className="text-lg font-bold text-ink">{title}</Dialog.Title>
    ) : (
      <div className="flex flex-wrap items-center gap-2.5">
        <Dialog.Title className="text-lg font-bold text-ink">{title}</Dialog.Title>
        {titleAside}
      </div>
    );
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlayClass} />
        <Dialog.Content
          className={cx(
            side
              ? sideClass
              : // cx không gộp class trùng: thay hẳn bề rộng tối đa thay vì thêm class thứ hai.
                wide
                ? dialogContentClass.replace("md:max-w-lg", "md:max-w-5xl")
                : dialogContentClass,
            !side &&
              fullScreen &&
              "max-md:top-0 max-md:max-h-dvh max-md:rounded-none max-md:pt-[calc(1.25rem+env(safe-area-inset-top))]",
          )}
          {...returnFocus}
          {...(onEscapeKeyDown === undefined ? {} : { onEscapeKeyDown })}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          {closeLabel === undefined ? (
            heading
          ) : (
            <div className="flex items-start justify-between gap-3">
              {heading}
              <Dialog.Close
                aria-label={closeLabel}
                className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-lg text-ink"
              >
                <span aria-hidden="true">×</span>
              </Dialog.Close>
            </div>
          )}
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
