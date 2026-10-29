import { z } from "zod";

import { UserRole } from "../enums";
import { decimalStringSchema, isoDateTimeSchema, uuidSchema } from "../schemas";

// Schema request/response cho đăng nhập bằng email + OTP, phiên và 2FA (DEC-28).

export const SESSION_COOKIE = "drift_session";
export const CSRF_COOKIE = "drift_csrf";
export const CSRF_HEADER = "X-CSRF-Token";

export const OTP_LENGTH = 6;
export const TOTP_LENGTH = 6;

const emailSchema = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());
const otpCodeSchema = z.string().regex(/^\d{6}$/);
/** Mã TOTP 6 số hoặc backup code (10 ký tự base32, cho phép gạch nối). */
export const twoFactorCodeSchema = z
  .string()
  .trim()
  .regex(/^(\d{6}|[A-Za-z2-7]{5}-?[A-Za-z2-7]{5})$/);

export const requestOtpBodySchema = z.object({ email: emailSchema });
export type RequestOtpBody = z.input<typeof requestOtpBodySchema>;

/** Mật khẩu (DEC-76): 12–128 ký tự, theo artboard Onboarding 1 ("12+ characters"). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

/** Đăng ký bằng email + mật khẩu (DEC-76). Mật khẩu không được chứa phần tên của email. */
export const registerBodySchema = z
  .object({ email: emailSchema, password: passwordSchema })
  .refine((b) => !passwordContainsEmail(b.password, b.email), {
    message: "Password must not contain your email.",
    path: ["password"],
  });
export type RegisterBody = z.input<typeof registerBodySchema>;

/** Đăng nhập bằng email + mật khẩu; `twoFactorCode` khi account đã bật 2FA (DEC-76). */
export const loginBodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  twoFactorCode: twoFactorCodeSchema.optional(),
});
export type LoginBody = z.input<typeof loginBodySchema>;

/** Mật khẩu chứa phần trước "@" của email (≥ 3 ký tự), không phân biệt hoa thường. */
export function passwordContainsEmail(password: string, email: string): boolean {
  const local = email.trim().toLowerCase().split("@")[0] ?? "";
  return local.length >= 3 && password.toLowerCase().includes(local);
}

export const createSessionBodySchema = z.object({
  email: emailSchema,
  code: otpCodeSchema,
  twoFactorCode: twoFactorCodeSchema.optional(),
});
export type CreateSessionBody = z.input<typeof createSessionBodySchema>;

export const meSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  displayName: z.string().nullable(),
  timezone: z.string(),
  numberFormat: z.string(),
  defaultMaxLossPct: z.string().nullable().default(null),
  twoFactorEnabled: z.boolean(),
  role: z.enum(UserRole),
});

export const NUMBER_FORMATS = ["en-US", "de-DE", "fr-FR", "vi-VN"] as const;
export const preferencesBodySchema = z
  .object({
    displayName: z.string().trim().min(1).max(60).nullable(),
    timezone: z.string().min(1).max(64),
    numberFormat: z.enum(NUMBER_FORMATS),
    defaultMaxLossPct: decimalStringSchema.nullable(),
  })
  .partial();
export const deleteAccountBodySchema = z.object({
  twoFactorCode: z.string().min(6).max(11).optional(),
});
export type Me = z.infer<typeof meSchema>;

export const sessionItemSchema = z.object({
  id: uuidSchema,
  current: z.boolean(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
});
export const sessionListSchema = z.object({ items: z.array(sessionItemSchema) });
export type SessionItem = z.infer<typeof sessionItemSchema>;

export const twoFactorSetupSchema = z.object({
  /** URI `otpauth://` để render QR ở client. */
  otpauthUri: z.string(),
  /** Secret base32 để nhập tay. Chỉ trả trong bước setup. */
  secret: z.string(),
});
export type TwoFactorSetup = z.infer<typeof twoFactorSetupSchema>;

export const enableTwoFactorBodySchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export const backupCodesSchema = z.object({ backupCodes: z.array(z.string()) });
export type BackupCodes = z.infer<typeof backupCodesSchema>;
