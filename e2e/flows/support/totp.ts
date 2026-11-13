import { createHmac } from "node:crypto";

import type { Locator } from "@playwright/test";

// RFC 6238 (SHA1, 6 số, 30 s) để E2E nhập mã 2FA như app authenticator.
function base32(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/[\s=]/g, "").toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = createHmac("sha1", base32(secret)).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
}

/** Chờ sang chu kỳ 30 s mới để mã không trùng bước đã dùng (server chặn dùng lại). */
export async function nextTotpWindow(): Promise<void> {
  const ms = 30_000 - (Date.now() % 30_000) + 500;
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Điền mã 2FA nếu hộp thoại hỏi. Phiên vừa xác minh 2FA được tin 2 giờ (DEC-115), nên ngay sau khi bật 2FA các thao tác
 * nhạy cảm không hỏi lại mã.
 */
export async function fillTwoFactorIfAsked(scope: Locator, secret: string): Promise<void> {
  const field = scope.getByLabel("2FA code");
  // Ô 2FA hiện cùng hộp thoại; chờ ngắn rồi coi như không hỏi.
  const asked = await field
    .waitFor({ timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!asked) return;
  await nextTotpWindow();
  await field.fill(totp(secret));
}
