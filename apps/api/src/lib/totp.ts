import { Secret, TOTP } from "otpauth";

// TOTP RFC 6238: SHA1, 6 số, chu kỳ 30 s, chấp nhận lệch ±1 bước (DEC-29).

export const TOTP_PERIOD_S = 30;
const ISSUER = "DRIFT";

export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

function totp(secret: string, label: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD_S,
    secret: Secret.fromBase32(secret),
  });
}

export function totpUri(secret: string, email: string): string {
  return totp(secret, email).toString();
}

/** Trả về bước thời gian của mã hợp lệ, hoặc null. */
export function verifyTotp(secret: string, code: string, now: Date): number | null {
  const timestamp = now.getTime();
  const delta = totp(secret, "").validate({ token: code, timestamp, window: 1 });
  if (delta === null) return null;
  return Math.floor(timestamp / 1000 / TOTP_PERIOD_S) + delta;
}

export function generateTotp(secret: string, now: Date): string {
  return totp(secret, "").generate({ timestamp: now.getTime() });
}
