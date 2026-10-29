import { Decimal } from "@drift/shared";
import type { FastifyInstance } from "fastify";

// Lớp an toàn cho C7: mọi số trong response là chuỗi thập phân thường. decimal.js (và SoDEX với số dư bụi)
// có thể cho "2.47775e-7"; web parse bằng DECIMAL_STRING_PATTERN nên một giá trị như vậy làm hỏng cả trang.
// Nguồn chính vẫn phải dùng `toDecimalString`; hook này chỉ chặn chỗ còn sót.

const EXPONENT = /^-?(\d+)(\.\d+)?e[+-]?\d+$/i;
// Field định danh không phải số dù trông giống số mũ: `last4` của key có thể là "4e43" (DEC-63).
const IDENTIFIER_KEYS: ReadonlySet<string> = new Set([
  "last4",
  "address",
  "publicKey",
  "name",
  "symbol",
]);
const isIdentifierKey = (k: string) => IDENTIFIER_KEYS.has(k) || /id$/i.test(k);

export function plainDecimals(value: unknown): unknown {
  if (typeof value === "string") {
    if (!EXPONENT.test(value)) return value;
    const d = new Decimal(value);
    return d.isZero() ? "0" : d.toFixed();
  }
  if (Array.isArray(value)) return value.map(plainDecimals);
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = isIdentifierKey(k) ? v : plainDecimals(v);
    return out;
  }
  return value;
}

export function registerPlainDecimals(app: FastifyInstance): void {
  app.addHook("preSerialization", (_request, _reply, payload, done) => {
    done(null, plainDecimals(payload));
  });
}
