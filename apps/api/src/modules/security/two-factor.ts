import type { Db } from "@drift/db";
import { sessions, twofaBackupCodes, users } from "@drift/db";
import { AppError, ErrorCode } from "@drift/shared";
import { and, eq, isNull } from "drizzle-orm";

import { AuditAction, audit } from "../../lib/audit";
import { decryptSecret, normalizeBackupCode, safeEqual, sha256 } from "../../lib/crypto";
import { verifyTotp } from "../../lib/totp";

// Kiểm tra 2FA ở server (CODING_STANDARDS C12): mã TOTP (không dùng lại cùng bước) hoặc backup code
// (mỗi mã dùng một lần).
//
// DEC-115 (người dùng quyết định): 2FA không bắt buộc. Chưa bật thì không hỏi mã; đã bật thì hỏi mã, nhưng
// nhập đúng một lần trên một phiên đăng nhập thì 2 giờ sau đó phiên đó không bị hỏi lại.

/** Sau khi nhập đúng mã, phiên đăng nhập được tin trong khoảng này. */
export const TWO_FACTOR_TRUST_MS = 2 * 60 * 60 * 1000;

export interface TwoFactorOptions {
  /** Phiên đang gọi: được dùng cửa sổ 2 giờ, và được ghi lại khi nhập đúng mã. */
  sessionId?: string;
  /** Bắt buộc đã bật 2FA (thao tác của team). Mặc định: chưa bật thì cho qua. */
  required?: boolean;
  /** Luôn hỏi mã, bỏ qua cửa sổ 2 giờ (xoá tài khoản). */
  fresh?: boolean;
}

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
  options: TwoFactorOptions = {},
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
    if (options.required !== true) return;
    throw new AppError(ErrorCode.twoFactorRequired, "Two-factor authentication must be enabled.", {
      reason: "not_enabled",
    });
  }
  const { sessionId } = options;
  if (sessionId !== undefined && options.fresh !== true) {
    const [session] = await deps.db
      .select({ verifiedAt: sessions.twofaVerifiedAt })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .limit(1);
    const at = session?.verifiedAt;
    if (at != null && deps.now().getTime() - at.getTime() < TWO_FACTOR_TRUST_MS) return;
  }
  await checkCode(deps, userId, { secret: user.secret, lastStep: user.lastStep }, code, ip);
  if (sessionId !== undefined) await markVerified(deps.db, sessionId, deps.now());
}

/** Ghi lại phiên vừa nhập đúng mã (cả lúc đăng nhập bằng 2FA). */
export async function markVerified(db: Db, sessionId: string, at: Date): Promise<void> {
  await db.update(sessions).set({ twofaVerifiedAt: at }).where(eq(sessions.id, sessionId));
}

async function checkCode(
  deps: TwoFactorDeps,
  userId: string,
  user: { secret: string; lastStep: number | null },
  code: string | undefined,
  ip: string | null,
): Promise<void> {
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
