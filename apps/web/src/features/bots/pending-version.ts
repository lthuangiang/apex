import type { BotDetail } from "@drift/shared";

type Version = BotDetail["versions"][number];

/**
 * Version `pending` mới nhất còn mới hơn version active (engine chưa áp; Volume Farm chờ lượt đang mở đóng,
 * DEC-304). Lấy từ server để Edit / trang bot hiện "Applying v{n}…" cả sau khi tải lại (quy tắc 1.6).
 */
export function pendingVersionOf(versions: readonly Version[]): Version | undefined {
  const active = versions.find((v) => v.status === "active")?.version ?? 0;
  return versions
    .filter((v) => v.status === "pending" && v.version > active)
    .reduce<Version | undefined>(
      (a, v) => (a === undefined || v.version > a.version ? v : a),
      undefined,
    );
}

/** Khoá i18n (`botEdit.*`) của dòng giải thích version đang chờ; null = không cần dòng nào. */
export type PendingNote = "waitingFarm" | "waitingFarmPaused" | "waitingPaused";

/**
 * Dòng giải thích version đang chờ (quy tắc 1.6, DEC-304). Volume Farm chờ lượt đang mở đóng (khác khi
 * bot pause). Chiến lược khác áp trong một nhịp khi bot chạy, nên chỉ cần dòng khi bot pause: áp lúc Resume.
 */
export function pendingNoteOf(strategy: string, state: string): PendingNote | null {
  const paused = state === "paused";
  if (strategy === "volume_farm") return paused ? "waitingFarmPaused" : "waitingFarm";
  return paused ? "waitingPaused" : null;
}
