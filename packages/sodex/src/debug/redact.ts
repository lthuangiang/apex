import type { SodexHeader } from "@drift/shared";

import { SIGNATURE_REDACTED } from "./capture";

// Che dữ liệu nhạy cảm trước khi lưu (DEC-TBD-sodex-debugger, CODING_STANDARDS C11, CLAUDE.md quy tắc 1.9): params
// của action đã ký được lưu, nhưng chữ ký, private key, secret và header xác thực thì không bao giờ. Tên API key và
// public key chỉ giữ 4 ký tự cuối.
//
// Làm trên CHUỖI bằng regex (không parse JSON) để flush không chặn event loop (review PR #217, B2): body có thể đã
// bị cắt nên không còn là JSON hợp lệ.

/** Header chứa chữ ký hoặc thông tin xác thực: bỏ hẳn giá trị. */
const SIGNATURE_HEADERS = new Set(["x-api-sign", "authorization", "cookie", "set-cookie"]);
/** Header định danh key: chỉ giữ 4 ký tự cuối. */
const MASKED_HEADERS = new Set(["x-api-key"]);

export const REDACTED = "[redacted]";

/** Độ dài tối thiểu của một chuỗi hex bị coi là key / chữ ký (private key 32 byte = 64 ký tự). */
const LONG_HEX_MIN = 64;

function isHex(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

/**
 * Thay mọi chuỗi hex dài ≥ 64 ký tự (private key 32 byte, chữ ký 64 / 65 byte, có hoặc không có prefix 0x / 0x01 /
 * 0x02) ở BẤT KỲ đâu trong chuỗi bằng `[redacted]`. Hash giao dịch cũng bị che: chấp nhận để không bao giờ lọt key.
 * Một vòng duyệt ký tự (nhanh hơn regex ~10 lần trên body 64 KB, review PR #217 B2).
 */
export function replaceLongHex(text: string): string {
  let out: string[] | null = null;
  let last = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (!isHex(text.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < n && isHex(text.charCodeAt(i))) i += 1;
    // "0x" + hex: "0" là hex, "x" thì không → chạy hex dừng ở "x"; nối tiếp phần sau "x".
    if (i - start === 1 && text.charCodeAt(start) === 48 && (text.charCodeAt(i) | 32) === 120) {
      const after = i + 1;
      let k = after;
      while (k < n && isHex(text.charCodeAt(k))) k += 1;
      if (k - after >= LONG_HEX_MIN) {
        i = k;
      } else {
        i = after;
        continue;
      }
    } else if (i - start < LONG_HEX_MIN) {
      continue;
    }
    out ??= [];
    out.push(text.slice(last, start), REDACTED);
    last = i;
  }
  if (out === null) return text;
  out.push(text.slice(last));
  return out.join("");
}

function hasLongHex(text: string): boolean {
  return replaceLongHex(text) !== text;
}

/** Tên khoá (đã bỏ `_` / `-`, chữ thường) mà giá trị không bao giờ được lưu. */
const SECRET_KEY =
  /(privatekey|secret|signature|mnemonic|seedphrase|password)|^(sig|sign|apisign|xapisign|seed|authorization|cookie|apikey)$/;

/** Khoá chỉ giữ 4 ký tự cuối (quy tắc 1.9): public key luôn; `name` chỉ ở endpoint api-keys (tên key). */
const MASK_ALWAYS = new Set(["publickey"]);

function normKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

export function maskLast4(value: string): string {
  return `••${value.slice(-4)}`;
}

/** Bỏ NUL và surrogate lẻ (Postgres từ chối cả batch nếu có, review PR #217 M2). */
export function sanitizeText(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- cố ý bỏ ký tự NUL mà Postgres không nhận trong text / jsonb.
      .replace(/\u0000/g, "")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
  );
}

/** Chuỗi tự do (lỗi SoDEX, chi tiết lỗi mạng, chi tiết WS): bỏ mọi chuỗi hex dài, làm sạch. */
export function scrubText(text: string | null): string | null {
  if (text === null) return null;
  return replaceLongHex(sanitizeText(text));
}

/** Cặp `"khoá": giá trị` với giá trị là chuỗi, số hoặc literal. */
const PAIR = /"((?:[^"\\]|\\.)*)"(\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*|true|false|null)/g;
/** Khoá bí mật có giá trị là object / mảng: che cả khối tới hết dòng / chuỗi (an toàn hơn đoán). */
const SECRET_BLOCK = /"((?:[^"\\]|\\.)*)"\s*:\s*[[{]/g;

/** Có tên khoá nào có thể cần che không (một lần quét, rẻ hơn nhiều so với thay theo cặp). */
const SUSPICIOUS =
  /sig|secret|private|mnemonic|seed|password|api_?key|public_?key|cookie|authorization/i;
const SUSPICIOUS_OR_NAME =
  /sig|secret|private|mnemonic|seed|password|api_?key|public_?key|cookie|authorization|name/i;

export interface RedactOptions {
  /** Che thêm `name` (tên API key): dùng cho endpoint `/api-keys`. */
  maskName?: boolean;
}

/** Body (JSON hoặc JSON bị cắt, hoặc văn bản): che khoá bí mật, public key / tên key, mọi chuỗi hex dài. */
export function redactBody(text: string | null, options: RedactOptions = {}): string | null {
  if (text === null || text === "") return text;
  let out = sanitizeText(text);
  // Đường nhanh: phần lớn body (kline, lệnh, lịch sử) không có khoá nào cần che → bỏ qua hai bước theo khoá.
  const suspicious = options.maskName === true ? SUSPICIOUS_OR_NAME : SUSPICIOUS;
  if (suspicious.test(out)) {
    // Khoá bí mật trỏ tới object / mảng: cắt bỏ phần còn lại (hiếm; SoDEX không gửi).
    for (const m of out.matchAll(SECRET_BLOCK)) {
      if (SECRET_KEY.test(normKey(m[1] ?? ""))) {
        out = `${out.slice(0, m.index)}"${m[1] ?? ""}":"${REDACTED}"`;
        break;
      }
    }
    out = out.replace(PAIR, (whole, key: string, colon: string, value: string) => {
      const k = normKey(key);
      if (SECRET_KEY.test(k)) return `"${key}"${colon}"${REDACTED}"`;
      if (
        (MASK_ALWAYS.has(k) || (options.maskName === true && k === "name")) &&
        value.startsWith('"')
      ) {
        return `"${key}"${colon}"${maskLast4(value.slice(1, -1))}"`;
      }
      return whole;
    });
  }
  return replaceLongHex(out);
}

export function redactHeaders(headers: Record<string, string>): SodexHeader[] {
  return Object.entries(headers).map(([name, raw]): SodexHeader => {
    const lower = name.toLowerCase();
    const value = sanitizeText(raw);
    if (SIGNATURE_HEADERS.has(lower) || value === SIGNATURE_REDACTED) {
      return { name, value: null, redaction: "signature" };
    }
    if (MASKED_HEADERS.has(lower)) return { name, value: maskLast4(value), redaction: "masked" };
    if (hasLongHex(value)) return { name, value: null, redaction: "signature" };
    return { name, value, redaction: "none" };
  });
}

/** Header response: bỏ header xác thực / cookie, che hex dài trong phần còn lại. */
export function responseHeaderList(
  headers: Record<string, string> | null,
): { name: string; value: string }[] {
  if (headers === null) return [];
  return Object.entries(headers)
    .filter(([name]) => !SIGNATURE_HEADERS.has(name.toLowerCase()))
    .map(([name, value]) => ({ name, value: scrubText(value) ?? "" }));
}
