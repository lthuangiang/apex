import { assertNever, BotState, isTransitionalBotState, type ReasonCode } from "@drift/shared";

import { cx } from "../lib/cx";

export interface StatusPillProps {
  state: BotState;
  /** Câu chữ của trạng thái, ví dụ "Running" hoặc "Pausing…". */
  label: string;
  reason?: ReasonCode;
  /** Câu chữ của reason code, hiển thị cạnh trạng thái. */
  reasonLabel?: string;
  needsAttention?: boolean;
  needsAttentionLabel?: string;
  className?: string;
}

type Tone = "pos" | "warn" | "neutral" | "accent";

function toneOf(state: BotState): Tone {
  switch (state) {
    case BotState.running:
      return "pos";
    case BotState.paused:
      return "warn";
    case BotState.starting:
    case BotState.pausing:
    case BotState.resuming:
    case BotState.stopping:
      return "accent";
    case BotState.draft:
    case BotState.stopped:
    case BotState.archived:
      return "neutral";
    default:
      return assertNever(state);
  }
}

const TONE: Record<Tone, string> = {
  pos: "bg-pos-bg text-pos",
  warn: "bg-warn-bg text-warn",
  neutral: "bg-surface-2 text-ink-2",
  accent: "bg-accent-tint text-accent-ink",
};

const DOT: Record<Tone, string> = {
  pos: "bg-pos-dot",
  warn: "bg-warn-bar",
  neutral: "bg-muted",
  accent: "bg-accent motion-safe:animate-pulse",
};

/** Trạng thái bot từ backend, kèm reason code khi bị pause/stop (quy tắc 1.6). */
export function StatusPill({
  state,
  label,
  reason,
  reasonLabel,
  needsAttention = false,
  needsAttentionLabel,
  className,
}: StatusPillProps) {
  const tone = toneOf(state);
  return (
    <span className={cx("inline-flex flex-wrap items-center gap-1.5", className)}>
      <span
        data-state={state}
        aria-busy={isTransitionalBotState(state) || undefined}
        className={cx(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
          TONE[tone],
        )}
      >
        <span aria-hidden="true" className={cx("size-1.5 rounded-full", DOT[tone])} />
        {label}
      </span>
      {reason && reasonLabel ? (
        <span data-reason={reason} className="text-xs font-medium text-ink-2">
          {reasonLabel}
        </span>
      ) : null}
      {needsAttention && needsAttentionLabel ? (
        <span className="rounded-full bg-warn-bg px-2 py-0.5 text-xs font-semibold text-warn">
          {needsAttentionLabel}
        </span>
      ) : null}
    </span>
  );
}
