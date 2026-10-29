import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// Băm mật khẩu bằng scrypt của node:crypto (DEC-76), không thêm dependency native.
// Định dạng lưu: scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>; tham số nằm trong chuỗi để đổi về sau
// mà mật khẩu cũ vẫn kiểm tra được.

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

function derive(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem phải đủ cho 128 * N * r byte.
    scrypt(password, salt, KEY_LEN, { ...opts, maxmem: 256 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, { N, r: R, p: P });
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

/** So khớp thời gian hằng; chuỗi hash hỏng thì trả false, không ném lỗi. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expected = Buffer.from(parts[5] ?? "", "base64");
  if (!n || !r || !p || salt.length === 0 || expected.length === 0) return false;
  const key = await derive(password, salt, { N: n, r, p });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Hash giả để đăng nhập email không tồn tại vẫn tốn cùng thời gian (không lộ email nào có account). */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString("hex"));
  return dummy;
}
