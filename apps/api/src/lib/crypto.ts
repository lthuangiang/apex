import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

/** Token ngẫu nhiên 32 byte, base64url. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** So sánh hai chuỗi hash cùng độ dài trong thời gian hằng. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Mã số `length` chữ số, phân phối đều. */
export function numericCode(length: number): string {
  let code = "";
  for (let i = 0; i < length; i += 1) code += String(randomInt(10));
  return code;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Backup code dạng `XXXXX-XXXXX` (50 bit). */
export function backupCode(): string {
  let raw = "";
  for (let i = 0; i < 10; i += 1) raw += BASE32[randomInt(32)] ?? "A";
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export function normalizeBackupCode(code: string): string {
  return code.replace(/-/g, "").toUpperCase();
}

/** AES-256-GCM: `v1.<iv>.<tag>.<ciphertext>` (base64url). */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [version, iv, tag, data] = payload.split(".");
  if (version !== "v1" || iv === undefined || tag === undefined || data === undefined) {
    throw new Error("Unsupported secret format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
