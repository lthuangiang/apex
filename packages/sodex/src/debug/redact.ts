import type { SodexHeader } from "@drift/shared";

import { parseSodexJson } from "../rest/json";

import { SIGNATURE_REDACTED } from "./capture";

// Che dữ liệu nhạy cảm trước khi lưu (DEC-TBD-sodex-debugger, CODING_STANDARDS C11): params của action đã ký được
// lưu, nhưng chữ ký, private key, secret và header xác thực thì không bao giờ. Tên API key chỉ giữ 4 ký tự cuối.

/** Header chứa chữ ký hoặc thông tin xác thực: bỏ hẳn giá trị. */
const SIGNATURE_HEADERS = new Set(["x-api-sign", "authorization", "cookie", "set-cookie"]);
/** Header định danh key: chỉ giữ 4 ký tự cuối. */
const MASKED_HEADERS = new Set(["x-api-key"]);

/** Khoá JSON không bao giờ lưu giá trị (so sánh không phân biệt hoa thường, bỏ `_` / `-`). */
const SECRET_KEYS = new Set([
  "signature",
  "sig",
  "sign",
  "apisign",
  "xapisign",
  "privatekey",
  "secret",
  "apisecret",
  "secretkey",
  "seed",
  "seedphrase",
  "mnemonic",
  "authorization",
  "cookie",
  "password",
]);

export const REDACTED = "[redacted]";

/** Chuỗi hex dài như chữ ký (65 byte, có thể có prefix 0x01 / 0x02) hoặc private key (32 byte). */
const SECRET_HEX = /^(0x)?([0-9a-fA-F]{64}|0[12][0-9a-fA-F]{130}|[0-9a-fA-F]{130})$/;

function normKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

export function maskLast4(value: string): string {
  return `••${value.slice(-4)}`;
}

export function redactHeaders(headers: Record<string, string>): SodexHeader[] {
  return Object.entries(headers).map(([name, value]): SodexHeader => {
    const lower = name.toLowerCase();
    if (SIGNATURE_HEADERS.has(lower) || value === SIGNATURE_REDACTED) {
      return { name, value: null, redaction: "signature" };
    }
    if (MASKED_HEADERS.has(lower)) return { name, value: maskLast4(value), redaction: "masked" };
    if (SECRET_HEX.test(value)) return { name, value: null, redaction: "signature" };
    return { name, value, redaction: "none" };
  });
}

/** Header response: bỏ header xác thực / cookie, giữ phần còn lại. */
export function responseHeaderList(headers: Headers | null): { name: string; value: string }[] {
  if (headers === null) return [];
  const out: { name: string; value: string }[] = [];
  headers.forEach((value, name) => {
    if (!SIGNATURE_HEADERS.has(name.toLowerCase())) out.push({ name, value });
  });
  return out;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return SECRET_HEX.test(value) ? REDACTED : value;
  if (typeof value === "bigint") return value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(normKey(k)) ? REDACTED : redactValue(v);
    }
    return out;
  }
  return value;
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v: unknown) => (typeof v === "bigint" ? `__big__${v.toString()}` : v),
    2,
  ).replace(/"__big__(-?\d+)"/g, "$1");
}

/**
 * Body JSON đã che và định dạng. Không phải JSON thì chỉ giữ khi không có gì giống chữ ký / key; ngược lại thay bằng
 * `[redacted]` (an toàn hơn đoán).
 */
export function redactBody(text: string | null): string | null {
  if (text === null || text === "") return text;
  let parsed: unknown;
  try {
    parsed = parseSodexJson(text);
  } catch {
    return /[0-9a-fA-F]{64}/.test(text) ? REDACTED : text;
  }
  return stringify(redactValue(parsed));
}
