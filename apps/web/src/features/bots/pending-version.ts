import type { BotDetail } from "@drift/shared";

type Version = BotDetail["versions"][number];

/**
 * Version `pending` mới nhất còn mới hơn version active (engine chưa áp; Volume Farm chờ lượt đang mở đóng,
 * DEC-TBD-vf-version-apply). Lấy từ server để Edit / trang bot hiện "Applying v{n}…" cả sau khi tải lại (quy tắc 1.6).
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
