import type { Db } from "@drift/db";
import { twofaBackupCodes, users } from "@drift/db";
import { AppError, ErrorCode } from "@drift/shared";
import { and, eq, isNull } from "drizzle-orm";

import { AuditAction, audit } from "../../lib/audit";
import { decryptSecret, normalizeBackupCode, safeEqual, sha256 } from "../../lib/crypto";
import { verifyTotp } from "../../lib/totp";

// Kiểm tra 2FA ở server (CODING_STANDARDS C12): mã TOTP (không dùng lại cùng bước) hoặc backup code
// (mỗi mã dùng một lần).

export interface TwoFactorDeps {
  db: Db;
  totpKey: Buffer;
  now: () => Date;
}

export async function verifyTwoFactor(
  deps: TwoFactorDeps,
  userId: string,
  code: string | undefined,
  ip: string | null,
): Promise<void> {
  const [user] = await deps.db
    .select({
      enabled: users.twofaEnabled,
      secret: users.twofaSecret,
      lastStep: users.twofaLastStep,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (user === undefined || !user.enabled || user.secret === null) {
    throw new AppError(ErrorCode.twoFactorRequired, "Two-factor authentication must be enabled.", {
      reason: "not_enabled",
    });
  }
  if (code === undefined) {
    throw new AppError(ErrorCode.twoFactorRequired, "Two-factor code required.");
  }

  if (/^\d{6}$/.test(code)) {
    const step = verifyTotp(decryptSecret(user.secret, deps.totpKey), code, deps.now());
    if (step === null || (user.lastStep !== null && step <= user.lastStep)) {
      throw new AppError(ErrorCode.twoFactorInvalid, "Invalid two-factor code.");
    }
    // Chỉ một request thắng khi hai request dùng cùng mã đồng thời.
    const updated = await deps.db
      .update(users)
      .set({ twofaLastStep: step })
      .where(
        and(
          eq(users.id, userId),
          user.lastStep === null
            ? isNull(users.twofaLastStep)
            : eq(users.twofaLastStep, user.lastStep),
        ),
      )
      .returning({ id: users.id });
    if (updated.length === 0)
      throw new AppError(ErrorCode.twoFactorInvalid, "Invalid two-factor code.");
    return;
  }

  const hash = sha256(normalizeBackupCode(code));
  const candidates = await deps.db
    .select({ id: twofaBackupCodes.id, codeHash: twofaBackupCodes.codeHash })
    .from(twofaBackupCodes)
    .where(and(eq(twofaBackupCodes.userId, userId), isNull(twofaBackupCodes.usedAt)));
  const match = candidates.find((c) => safeEqual(c.codeHash, hash));
  if (match === undefined)
    throw new AppError(ErrorCode.twoFactorInvalid, "Invalid two-factor code.");
  const used = await deps.db
    .update(twofaBackupCodes)
    .set({ usedAt: deps.now() })
    .where(and(eq(twofaBackupCodes.id, match.id), isNull(twofaBackupCodes.usedAt)))
    .returning({ id: twofaBackupCodes.id });
  if (used.length === 0) throw new AppError(ErrorCode.twoFactorInvalid, "Invalid two-factor code.");
  await audit(deps.db, { userId, action: AuditAction.backupCodeUsed, ip });
}
