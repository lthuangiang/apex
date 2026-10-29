import { useRef } from "react";

/**
 * Radix chỉ trả focus về `Dialog.Trigger`. Dialog của DRIFT thường được mở từ ngoài
 * (open có điều khiển), nên ghi lại phần tử đang focus lúc mở và trả focus về đó khi đóng
 * (docs/DESIGN.md, Accessibility).
 */
export function useReturnFocus() {
  const previous = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      const active = document.activeElement;
      previous.current = active instanceof HTMLElement ? active : null;
    },
    onCloseAutoFocus: (event: Event) => {
      const target = previous.current;
      if (target?.isConnected) {
        event.preventDefault();
        target.focus();
      }
      previous.current = null;
    },
  };
}
