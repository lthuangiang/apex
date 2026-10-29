import { cx } from "../lib/cx";

export type ConnectionState = "connected" | "connecting" | "disconnected";

export interface ConnectionStatusProps {
  state: ConnectionState;
  /** Câu chữ của trạng thái, ví dụ "Connected". Trạng thái không chỉ thể hiện bằng màu. */
  label: string;
  className?: string;
}

const DOT: Record<ConnectionState, string> = {
  connected: "bg-pos-dot",
  connecting: "bg-warn-bar motion-safe:animate-pulse",
  disconnected: "bg-neg",
};

export function ConnectionStatus({ state, label, className }: ConnectionStatusProps) {
  return (
    <span
      role="status"
      data-state={state}
      className={cx("inline-flex items-center gap-2 text-sm font-medium text-ink-2", className)}
    >
      <span aria-hidden="true" className={cx("size-2 rounded-full", DOT[state])} />
      {label}
    </span>
  );
}
