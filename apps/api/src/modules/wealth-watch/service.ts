import { sodexAccounts, wealthWatch, type Db } from "@drift/db";
import { AppError, ErrorCode, type WealthWatchState } from "@drift/shared";
import { and, desc, eq } from "drizzle-orm";

import { audit, AuditAction } from "../../lib/audit";
import { markSideEffect } from "../../lib/idempotency";

// Cảnh báo SoDEX Wealth (#594, DEC-404): công tắc "Alerts" ở Portfolio › My Wealth. Bật = một dòng `wealth_watch` gắn
// với tài khoản SoDEX đang kết nối; scheduler đọc dữ liệu Wealth công khai theo master wallet. Không token, không chữ ký.
// Tắt, ngắt SoDEX, xoá tài khoản: xoá dòng (gồm mọi mốc đã lưu).

/** Lỗi đọc liên tiếp từ mức này thì trạng thái báo "delayed". */
export const WEALTH_WATCH_DELAYED_AFTER = 3;

const OFF: WealthWatchState = { status: "off", lastCheckedAt: null, delayed: false };

async function connectedAccount(db: Db, userId: string) {
  const [account] = await db
    .select({ id: sodexAccounts.id })
    .from(sodexAccounts)
    .where(and(eq(sodexAccounts.userId, userId), eq(sodexAccounts.status, "connected")))
    .orderBy(desc(sodexAccounts.createdAt))
    .limit(1);
  return account ?? null;
}

/** `GET /api/v1/wealth/watch`: trạng thái công tắc lấy từ backend (quy tắc 6). */
export async function getWealthWatchState(db: Db, userId: string): Promise<WealthWatchState> {
  const [row] = await db.select().from(wealthWatch).where(eq(wealthWatch.userId, userId)).limit(1);
  if (row === undefined) return OFF;
  // Dòng gắn với tài khoản SoDEX cũ (đổi ví): coi như tắt; scheduler sẽ xoá.
  const account = await connectedAccount(db, userId);
  if (account?.id !== row.sodexAccountId) return OFF;
  return {
    status: "active",
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    delayed: row.consecutiveErrors >= WEALTH_WATCH_DELAYED_AFTER,
  };
}

/** `POST /api/v1/wealth/watch`: bật. Đã bật cho đúng tài khoản thì giữ nguyên mốc (không báo lại lịch sử). */
export async function enableWealthWatch(
  db: Db,
  userId: string,
  now: Date,
  ip: string | null,
): Promise<WealthWatchState> {
  const account = await connectedAccount(db, userId);
  if (account === null)
    throw new AppError(ErrorCode.sodexAccountNotFound, "Connect your SoDEX account first.");
  const [current] = await db
    .select({ sodexAccountId: wealthWatch.sodexAccountId })
    .from(wealthWatch)
    .where(eq(wealthWatch.userId, userId))
    .limit(1);
  if (current?.sodexAccountId !== account.id) {
    markSideEffect();
    // Lượt đầu của scheduler chỉ đặt mốc, không báo lịch sử cũ.
    const values = {
      sodexAccountId: account.id,
      baselinePending: true,
      fundMarks: {},
      execMarks: {},
      hasPlans: false,
      plansCheckedAt: null,
      nextCheckAt: now,
      lastCheckedAt: null,
      consecutiveErrors: 0,
      lastErrorCode: null,
    };
    await db
      .insert(wealthWatch)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: wealthWatch.userId, set: values });
    await audit(db, { userId, action: AuditAction.wealthWatchEnabled, target: account.id, ip });
  }
  return getWealthWatchState(db, userId);
}

export type WealthWatchRemoveReason = "user" | "sodex_disconnect" | "account_deleted";

/** Xoá dòng `wealth_watch` của user (tắt, ngắt SoDEX, xoá tài khoản). Idempotent; ghi audit khi có dòng bị xoá. */
export async function removeWealthWatch(
  db: Pick<Db, "delete" | "insert">,
  userId: string,
  reason: WealthWatchRemoveReason,
  ip: string | null,
): Promise<boolean> {
  const deleted = await db
    .delete(wealthWatch)
    .where(eq(wealthWatch.userId, userId))
    .returning({ userId: wealthWatch.userId });
  if (deleted.length === 0) return false;
  await audit(db, { userId, action: AuditAction.wealthWatchDisabled, metadata: { reason }, ip });
  return true;
}
