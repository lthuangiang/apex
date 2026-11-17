import type { bots } from "@drift/db";
import { BotState } from "@drift/shared";
import { sql, type SQL } from "drizzle-orm";

// Vị thế thật trên SoDEX lệch sổ cái của bot (engine ghi `bots.position_mismatch`, DEC-TBD-engine-position-check). Là cờ
// riêng, không ghi đè `needs_attention`: Needs attention hiện khi một trong hai cờ bật, nên lý do khác (grid ra khỏi range,
// fill tìm thấy muộn…) không bị tắt nhầm khi vị thế khớp lại, và "Price back in range" không tắt cảnh báo lệch vị thế.
// Bot đã dừng / archive không còn quản lý vị thế: không tính.

type BotFlags = Pick<typeof bots.$inferSelect, "positionMismatch" | "state" | "needsAttention">;

export function hasPositionMismatch(b: Pick<BotFlags, "positionMismatch" | "state">): boolean {
  if (b.state === BotState.stopped || b.state === BotState.archived) return false;
  return b.positionMismatch != null && Object.keys(b.positionMismatch).length > 0;
}

export function needsAttentionOf(b: BotFlags): boolean {
  return b.needsAttention || hasPositionMismatch(b);
}

/** Cùng điều kiện bằng SQL (đếm Needs attention). */
export function needsAttentionSql(t: typeof bots): SQL<boolean> {
  return sql<boolean>`(${t.needsAttention} or (${t.positionMismatch} is not null and ${t.state} not in ('stopped', 'archived')))`;
}
