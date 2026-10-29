import { BotState, REASON_CODE_META, type ReasonCode } from "./enums";

// State machine của bot (DOMAIN.md mục 7.1–7.2). Hàm thuần: trả về trạng thái mới hoặc null nếu
// chuyển không hợp lệ. Lệnh của người dùng chỉ đưa bot vào trạng thái chuyển tiếp; engine xác nhận mới
// sang trạng thái cuối (quy tắc 1.6).

export const BotCommand = {
  start: "start",
  pause: "pause",
  resume: "resume",
  stop: "stop",
  archive: "archive",
} as const;
export type BotCommand = (typeof BotCommand)[keyof typeof BotCommand];

/** Người dùng (qua api) yêu cầu. */
export function applyCommand(state: BotState, command: BotCommand): BotState | null {
  switch (command) {
    case BotCommand.start:
      return state === BotState.draft ? BotState.starting : null;
    case BotCommand.pause:
      return state === BotState.running ? BotState.pausing : null;
    case BotCommand.resume:
      return state === BotState.paused ? BotState.resuming : null;
    case BotCommand.stop:
      return state === BotState.running || state === BotState.paused ? BotState.stopping : null;
    case BotCommand.archive:
      return state === BotState.stopped ? BotState.archived : null;
  }
}

export const EngineEvent = {
  /** SoDEX đã ack lệnh đầu tiên (start) hoặc engine đã chạy lại (resume). */
  confirmedRunning: "confirmed_running",
  confirmedPaused: "confirmed_paused",
  confirmedStopped: "confirmed_stopped",
  /** Lệnh đầu tiên lúc start bị từ chối hết. */
  startFailed: "start_failed",
} as const;
export type EngineEvent = (typeof EngineEvent)[keyof typeof EngineEvent];

/** Engine xác nhận. */
export function applyEngineEvent(state: BotState, event: EngineEvent): BotState | null {
  switch (event) {
    case EngineEvent.confirmedRunning:
      return state === BotState.starting || state === BotState.resuming ? BotState.running : null;
    case EngineEvent.confirmedPaused:
      return state === BotState.pausing ||
        state === BotState.running ||
        state === BotState.resuming ||
        state === BotState.starting
        ? BotState.paused
        : null;
    case EngineEvent.confirmedStopped:
      return state === BotState.stopping ||
        state === BotState.running ||
        state === BotState.paused ||
        state === BotState.starting
        ? BotState.stopped
        : null;
    case EngineEvent.startFailed:
      return state === BotState.starting ? BotState.paused : null;
  }
}

/** Bot (hoặc mọi bot của account) bị pause / stop theo reason code (DOMAIN.md mục 7.2). */
export function applyReason(state: BotState, reason: ReasonCode): BotState | null {
  const outcome = REASON_CODE_META[reason].outcome;
  const active: BotState[] = [
    BotState.starting,
    BotState.running,
    BotState.pausing,
    BotState.resuming,
  ];
  if (outcome === BotState.paused) return active.includes(state) ? BotState.paused : null;
  return active.includes(state) || state === BotState.paused || state === BotState.stopping
    ? BotState.stopped
    : null;
}

/** Trạng thái mà engine phải chạy runner. */
export const ENGINE_ACTIVE_STATES: readonly BotState[] = [
  BotState.starting,
  BotState.running,
  BotState.pausing,
  BotState.resuming,
  BotState.stopping,
];
