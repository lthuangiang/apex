// Lịch macro viết tay cho D1 (#274). DB chưa có lịch macro (SoSoValue `/macro/events` sẽ do collector của #271 ghi), nên
// replay dùng danh sách nhỏ này, có version. CHƯA ĐỐI CHIẾU với nguồn chính thức: ngày FOMC theo lịch họp 2026 của Fed,
// ngày CPI theo lịch công bố 2026 của BLS, Claude chép từ trí nhớ (`verified: false`). Phải kiểm lại trước khi tin kết quả
// D1; khi bảng macro của #271 có dữ liệu thì thay danh sách này bằng bảng đó.
// Giờ: FOMC công bố 14:00 giờ New York, CPI 08:30 giờ New York; đổi sang UTC theo giờ mùa hè Mỹ 2026 (8/3 – 1/11).

export const MACRO_CALENDAR_VERSION = "macro-v1-2026-11-18";

export type MacroKind = "FOMC" | "CPI";

export interface MacroEvent {
  kind: MacroKind;
  /** Giờ công bố (UTC, ISO). */
  at: string;
  verified: boolean;
}

/** Khung tạm ngừng quanh mỗi loại sự kiện: [at − before, at + after). FOMC gồm cả họp báo 30 phút sau. */
export const PAUSE_WINDOW_V1: Readonly<Record<MacroKind, { beforeMs: number; afterMs: number }>> = {
  FOMC: { beforeMs: 30 * 60_000, afterMs: 90 * 60_000 },
  CPI: { beforeMs: 15 * 60_000, afterMs: 60 * 60_000 },
};

export const MACRO_EVENTS_V1: readonly MacroEvent[] = [
  { kind: "FOMC", at: "2026-01-28T19:00:00Z", verified: false },
  { kind: "FOMC", at: "2026-03-18T18:00:00Z", verified: false },
  { kind: "FOMC", at: "2026-04-29T18:00:00Z", verified: false },
  { kind: "FOMC", at: "2026-06-17T18:00:00Z", verified: false },
  { kind: "FOMC", at: "2026-07-29T18:00:00Z", verified: false },
  { kind: "FOMC", at: "2026-09-16T18:00:00Z", verified: false },
  { kind: "FOMC", at: "2026-10-28T18:00:00Z", verified: false },
  { kind: "FOMC", at: "2026-12-09T19:00:00Z", verified: false },
  { kind: "CPI", at: "2026-01-13T13:30:00Z", verified: false },
  { kind: "CPI", at: "2026-02-11T13:30:00Z", verified: false },
  { kind: "CPI", at: "2026-03-11T12:30:00Z", verified: false },
  { kind: "CPI", at: "2026-04-10T12:30:00Z", verified: false },
  { kind: "CPI", at: "2026-05-12T12:30:00Z", verified: false },
  { kind: "CPI", at: "2026-06-10T12:30:00Z", verified: false },
  { kind: "CPI", at: "2026-07-14T12:30:00Z", verified: false },
  { kind: "CPI", at: "2026-08-12T12:30:00Z", verified: false },
  { kind: "CPI", at: "2026-09-11T12:30:00Z", verified: false },
  { kind: "CPI", at: "2026-10-14T12:30:00Z", verified: false },
  { kind: "CPI", at: "2026-11-10T13:30:00Z", verified: false },
  { kind: "CPI", at: "2026-12-10T13:30:00Z", verified: false },
];

export interface PauseWindow {
  kind: MacroKind;
  at: number;
  start: number;
  end: number;
  verified: boolean;
}

/** Các khung tạm ngừng có phần nằm trong [from, to), xếp theo giờ bắt đầu. */
export function pauseWindows(
  from: number,
  to: number,
  events: readonly MacroEvent[] = MACRO_EVENTS_V1,
): PauseWindow[] {
  return events
    .map((e) => {
      const at = Date.parse(e.at);
      const w = PAUSE_WINDOW_V1[e.kind];
      return {
        kind: e.kind,
        at,
        start: at - w.beforeMs,
        end: at + w.afterMs,
        verified: e.verified,
      };
    })
    .filter((w) => w.end > from && w.start < to)
    .sort((a, b) => a.start - b.start);
}

/** `t` nằm trong một khung nào đó (khung xếp theo giờ, số ít: quét tuyến tính). */
export function inWindow(windows: readonly PauseWindow[], t: number): PauseWindow | null {
  return windows.find((w) => t >= w.start && t < w.end) ?? null;
}
