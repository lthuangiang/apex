import { sessions, twofaBackupCodes, users } from "@drift/db";
import { AppError, ErrorCode, type SessionItem } from "@drift/shared";
import { and, desc, eq, gt, isNull } from "drizzle-orm";

import { AuditAction, audit } from "../../lib/audit";
import {
  backupCode,
  decryptSecret,
  encryptSecret,
  normalizeBackupCode,
  sha256,
} from "../../lib/crypto";
import { newTotpSecret, totpUri, verifyTotp } from "../../lib/totp";

import type { TwoFactorDeps } from "./two-factor";

// Settings › Security: bật 2FA (QR → mã 6 số → backup code) và quản lý phiên (SCREENS.md mục 8.5).

export const BACKUP_CODE_COUNT = 10;

export async function setupTwoFactor(deps: TwoFactorDeps, userId: string) {
  const [user] = await deps.db
    .select({ email: users.email, enabled: users.twofaEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (user === undefined) throw new AppError(ErrorCode.unauthenticated, "Sign in required.");
  if (user.enabled) {
    throw new AppError(ErrorCode.forbidden, "Two-factor authentication is already enabled.", {
      reason: "already_enabled",
    });
  }
  const secret = newTotpSecret();
  await deps.db
    .update(users)
    .set({ twofaPendingSecret: encryptSecret(secret, deps.totpKey) })
    .where(eq(users.id, userId));
  return { otpauthUri: totpUri(secret, user.email), secret };
}

export async function enableTwoFactor(
  deps: TwoFactorDeps,
  userId: string,
  code: string,
  ip: string | null,
) {
  const [user] = await deps.db
    .select({ enabled: users.twofaEnabled, pending: users.twofaPendingSecret })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (user === undefined) throw new AppError(ErrorCode.unauthenticated, "Sign in required.");
  if (user.enabled) {
    throw new AppError(ErrorCode.forbidden, "Two-factor authentication is already enabled.", {
      reason: "already_enabled",
    });
  }
  if (user.pending === null) {
    throw new AppError(ErrorCode.validationFailed, "Start two-factor setup first.", {
      reason: "no_setup",
    });
  }
  const step = verifyTotp(decryptSecret(user.pending, deps.totpKey), code, deps.now());
  if (step === null) throw new AppError(ErrorCode.twoFactorInvalid, "Invalid two-factor code.");

  const codes = Array.from({ length: BACKUP_CODE_COUNT }, backupCode);
  await deps.db.transaction(async (tx) => {
    const updated = await tx
      .update(users)
      .set({
        twofaEnabled: true,
        twofaSecret: user.pending,
        twofaPendingSecret: null,
        twofaLastStep: step,
      })
      .where(and(eq(users.id, userId), eq(users.twofaEnabled, false)))
      .returning({ id: users.id });
    if (updated.length === 0) {
      throw new AppError(ErrorCode.forbidden, "Two-factor authentication is already enabled.", {
        reason: "already_enabled",
      });
    }
    await tx.delete(twofaBackupCodes).where(eq(twofaBackupCodes.userId, userId));
    await tx
      .insert(twofaBackupCodes)
      .values(codes.map((c) => ({ userId, codeHash: sha256(normalizeBackupCode(c)) })));
    await audit(tx, { userId, action: AuditAction.twoFactorEnabled, ip });
  });
  return { backupCodes: codes };
}

export async function listSessions(
  deps: TwoFactorDeps,
  userId: string,
  currentSessionId: string,
): Promise<SessionItem[]> {
  const now = deps.now();
  const rows = await deps.db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        gt(sessions.absoluteExpiresAt, now),
      ),
    )
    .orderBy(desc(sessions.lastSeenAt));
  return rows.map((row) => ({
    id: row.id,
    current: row.id === currentSessionId,
    ip: row.ip,
    userAgent: row.userAgent,
    createdAt: iso(row.createdAt),
    lastSeenAt: iso(row.lastSeenAt),
    expiresAt: iso(new Date(Math.min(row.expiresAt.getTime(), row.absoluteExpiresAt.getTime()))),
  }));
}

/** ISO 8601 UTC không có phần mili giây (CODING_STANDARDS C7). */
export function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
