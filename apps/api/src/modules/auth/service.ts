import { randomBytes } from "node:crypto";

import type { Db } from "@drift/db";
import { emailOtps, sessions, users } from "@drift/db";
import { AppError, ErrorCode, OTP_LENGTH, UserRole } from "@drift/shared";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";

import { AuditAction, audit } from "../../lib/audit";
import { numericCode, randomToken, safeEqual, sha256 } from "../../lib/crypto";
import type { Mailer } from "../../lib/mailer";
import { dummyHash, hashPassword, verifyPassword } from "../../lib/password";
import messages from "../../messages/en.json" with { type: "json" };
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from "../../plugins/session";
import { verifyTwoFactor, type TwoFactorDeps } from "../security/two-factor";

// Đăng nhập bằng email + OTP (DEC-28). Không phân biệt "email chưa có" với "đã có" trong response,
// để không lộ danh sách người dùng; xác minh lần đầu thì tạo user.

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
export const OTP_MAX_PER_HOUR = 5;

export interface AuthDeps extends TwoFactorDeps {
  mailer: Mailer;
}

export async function requestOtp(deps: AuthDeps, email: string): Promise<void> {
  const now = deps.now();
  const recent = await deps.db
    .select({ createdAt: emailOtps.createdAt })
    .from(emailOtps)
    .where(
      and(
        eq(emailOtps.email, email),
        gt(emailOtps.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
      ),
    )
    .orderBy(desc(emailOtps.createdAt));
  const latest = recent[0];
  if (latest !== undefined && now.getTime() - latest.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
    throw new AppError(ErrorCode.rateLimited, "Wait before requesting another code.", {
      retryAfterMs: OTP_RESEND_COOLDOWN_MS - (now.getTime() - latest.createdAt.getTime()),
    });
  }
  if (recent.length >= OTP_MAX_PER_HOUR) {
    throw new AppError(ErrorCode.rateLimited, "Too many codes requested.", {
      retryAfterMs: 60 * 60 * 1000,
    });
  }

  const code = numericCode(OTP_LENGTH);
  await deps.db.transaction(async (tx) => {
    // Mã mới thay mọi mã cũ còn hiệu lực.
    await tx
      .update(emailOtps)
      .set({ consumedAt: now })
      .where(and(eq(emailOtps.email, email), isNull(emailOtps.consumedAt)));
    await tx.insert(emailOtps).values({
      email,
      codeHash: sha256(`${email}:${code}`),
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
      createdAt: now,
    });
  });
  await deps.mailer.send({
    to: email,
    subject: messages.email.otp.subject,
    text: messages.email.otp.body.replace("{code}", code),
  });
}

export interface NewSession {
  token: string;
  expiresAt: Date;
  userId: string;
}

export async function createSession(
  deps: AuthDeps,
  input: { email: string; code: string; twoFactorCode: string | undefined },
  client: { ip: string | null; userAgent: string | null },
): Promise<NewSession> {
  const now = deps.now();
  const [otp] = await deps.db
    .select()
    .from(emailOtps)
    .where(
      and(
        eq(emailOtps.email, input.email),
        isNull(emailOtps.consumedAt),
        gt(emailOtps.expiresAt, now),
      ),
    )
    .orderBy(desc(emailOtps.createdAt))
    .limit(1);
  if (otp === undefined || otp.attempts >= OTP_MAX_ATTEMPTS) {
    throw new AppError(ErrorCode.otpInvalid, "Invalid or expired code.");
  }
  if (!safeEqual(otp.codeHash, sha256(`${input.email}:${input.code}`))) {
    await deps.db
      .update(emailOtps)
      .set({ attempts: sql`${emailOtps.attempts} + 1` })
      .where(eq(emailOtps.id, otp.id));
    throw new AppError(ErrorCode.otpInvalid, "Invalid or expired code.");
  }

  const [existing] = await deps.db
    .select({ id: users.id, twofaEnabled: users.twofaEnabled })
    .from(users)
    .where(sql`lower(${users.email}) = ${input.email}`)
    .limit(1);
  // 2FA kiểm tra trước khi tiêu thụ OTP, để người dùng nhập tiếp mã 2FA mà không cần OTP mới.
  if (existing?.twofaEnabled === true) {
    await verifyTwoFactor(deps, existing.id, input.twoFactorCode, client.ip);
  }

  const token = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_IDLE_MS);
  const userId = await deps.db.transaction(async (tx) => {
    const consumed = await tx
      .update(emailOtps)
      .set({ consumedAt: now })
      .where(and(eq(emailOtps.id, otp.id), isNull(emailOtps.consumedAt)))
      .returning({ id: emailOtps.id });
    if (consumed.length === 0) throw new AppError(ErrorCode.otpInvalid, "Invalid or expired code.");

    let id = existing?.id;
    if (id === undefined) {
      const [created] = await tx
        .insert(users)
        .values({ email: input.email })
        .onConflictDoNothing()
        .returning({ id: users.id });
      id = created?.id;
      if (id === undefined) throw new AppError(ErrorCode.otpInvalid, "Invalid or expired code.");
    }
    await tx.insert(sessions).values({
      userId: id,
      tokenHash: sha256(token),
      expiresAt,
      absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
      lastSeenAt: now,
      // Vừa nhập đúng 2FA khi đăng nhập: tính luôn cửa sổ 2 giờ (DEC-115).
      twofaVerifiedAt: existing?.twofaEnabled === true ? now : null,
      ip: client.ip,
      userAgent: client.userAgent,
    });
    await audit(tx, {
      userId: id,
      action: AuditAction.signIn,
      ip: client.ip,
      metadata: { newUser: existing === undefined },
    });
    return id;
  });
  return { token, expiresAt, userId };
}

// ---------- Email + mật khẩu (DEC-76) ----------

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function openSession(
  tx: Tx,
  userId: string,
  now: Date,
  client: { ip: string | null; userAgent: string | null },
  newUser: boolean,
  twofaVerified = false,
): Promise<NewSession> {
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_IDLE_MS);
  await tx.insert(sessions).values({
    userId,
    tokenHash: sha256(token),
    expiresAt,
    absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
    lastSeenAt: now,
    twofaVerifiedAt: twofaVerified ? now : null,
    ip: client.ip,
    userAgent: client.userAgent,
  });
  await audit(tx, {
    userId,
    action: AuditAction.signIn,
    ip: client.ip,
    metadata: { newUser, method: "password" },
  });
  return { token, expiresAt, userId };
}

/** Tạo account bằng email + mật khẩu và mở phiên luôn. Email đã có account → EMAIL_TAKEN. */
export async function registerWithPassword(
  deps: AuthDeps,
  input: { email: string; password: string },
  client: { ip: string | null; userAgent: string | null },
): Promise<NewSession> {
  const now = deps.now();
  const passwordHash = await hashPassword(input.password);
  return deps.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({ email: input.email, passwordHash })
      .onConflictDoNothing()
      .returning({ id: users.id });
    if (created === undefined) {
      throw new AppError(ErrorCode.emailTaken, "An account with this email already exists.");
    }
    return openSession(tx, created.id, now, client, true);
  });
}

/**
 * Đăng nhập bằng email + mật khẩu. Sai email hay sai mật khẩu đều trả cùng một lỗi. Sai liên tiếp
 * LOGIN_MAX_FAILURES lần thì khoá LOGIN_LOCK_MS. Đúng mật khẩu mới hỏi 2FA (nếu đã bật).
 */
export async function loginWithPassword(
  deps: AuthDeps,
  input: { email: string; password: string; twoFactorCode: string | undefined },
  client: { ip: string | null; userAgent: string | null },
): Promise<NewSession> {
  const now = deps.now();
  const [user] = await deps.db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      twofaEnabled: users.twofaEnabled,
      failedLogins: users.failedLogins,
      lockedUntil: users.loginLockedUntil,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(sql`lower(${users.email}) = ${input.email}`)
    .limit(1);

  if (user?.lockedUntil != null && user.lockedUntil > now) {
    throw new AppError(ErrorCode.rateLimited, "Too many failed sign-ins. Try again later.", {
      retryAfterMs: user.lockedUntil.getTime() - now.getTime(),
    });
  }
  const usable = user !== undefined && user.passwordHash !== null && user.deletedAt === null;
  // Email không có account (hoặc chưa đặt mật khẩu) vẫn chạy scrypt để thời gian phản hồi như nhau.
  const ok = usable
    ? await verifyPassword(input.password, user.passwordHash ?? "")
    : (await verifyPassword(input.password, await dummyHash())) && false;
  if (user === undefined || !ok) {
    if (user !== undefined) {
      const failures = user.failedLogins + 1;
      const lock = failures >= LOGIN_MAX_FAILURES;
      await deps.db
        .update(users)
        .set({
          failedLogins: lock ? 0 : failures,
          loginLockedUntil: lock ? new Date(now.getTime() + LOGIN_LOCK_MS) : null,
        })
        .where(eq(users.id, user.id));
    }
    throw new AppError(ErrorCode.invalidCredentials, "Wrong email or password.");
  }
  if (user.twofaEnabled) await verifyTwoFactor(deps, user.id, input.twoFactorCode, client.ip);

  return deps.db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ failedLogins: 0, loginLockedUntil: null })
      .where(eq(users.id, user.id));
    return openSession(tx, user.id, now, client, false, user.twofaEnabled);
  });
}

/** Đặt mật khẩu cho account có sẵn (lệnh admin trên server, DEC-76). Trả false khi không có email đó. */
export async function setPassword(db: Db, email: string, password: string): Promise<boolean> {
  const updated = await db
    .update(users)
    .set({ passwordHash: await hashPassword(password), failedLogins: 0, loginLockedUntil: null })
    .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`)
    .returning({ id: users.id });
  return updated.length > 0;
}

/**
 * Team đặt lại mật khẩu cho một user từ trang Users (DEC-77). Cần role `team` và 2FA của người thao tác.
 * Server sinh mật khẩu tạm (trả về một lần), thu hồi mọi phiên của user đó, bỏ khoá đăng nhập, ghi audit
 * (không ghi mật khẩu).
 */
export async function resetPasswordByTeam(
  deps: AuthDeps,
  input: { actorId: string; targetId: string; twoFactorCode: string },
  ip: string | null,
): Promise<{ email: string; temporaryPassword: string }> {
  const [actor] = await deps.db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, input.actorId))
    .limit(1);
  if (actor?.role !== UserRole.team) {
    throw new AppError(ErrorCode.forbidden, "Users is for the DeskLabs team only.");
  }
  // Thao tác của team: bắt buộc đã bật 2FA và luôn hỏi mã mới.
  await verifyTwoFactor(deps, input.actorId, input.twoFactorCode, ip, {
    required: true,
    fresh: true,
  });
  const [target] = await deps.db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(eq(users.id, input.targetId), isNull(users.deletedAt)))
    .limit(1);
  if (target === undefined) throw new AppError(ErrorCode.notFound, "User not found.");

  const temporaryPassword = temporaryPasswordFor();
  const passwordHash = await hashPassword(temporaryPassword);
  const now = deps.now();
  await deps.db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, failedLogins: 0, loginLockedUntil: null })
      .where(eq(users.id, target.id));
    await tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.userId, target.id), isNull(sessions.revokedAt)));
    await audit(tx, {
      userId: input.actorId,
      action: AuditAction.passwordResetByTeam,
      target: target.id,
      ip,
    });
  });
  return { email: target.email, temporaryPassword };
}

/** 20 ký tự base32 không nhầm lẫn (≈ 100 bit), nhóm 4 bằng gạch nối để đọc cho người dùng dễ. */
function temporaryPasswordFor(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(20);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length] ?? "A").join("");
  return chars.match(/.{4}/g)?.join("-") ?? chars;
}

export async function revokeSession(
  db: Db,
  userId: string,
  sessionId: string,
  now: Date,
  ip: string | null,
  action: AuditAction,
): Promise<boolean> {
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  if (revoked.length > 0) await audit(db, { userId, action, target: sessionId, ip });
  return revoked.length > 0;
}
