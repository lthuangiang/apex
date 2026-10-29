// SoDEX trả order ID, trade ID… dạng uint64, có thể vượt Number.MAX_SAFE_INTEGER.
// Dùng `context.source` của reviver (Node ≥ 21) để đổi số nguyên không an toàn sang bigint,
// không cần thư viện JSON riêng.

interface ReviverContext {
  source?: string;
}

type Reviver = (this: unknown, key: string, value: unknown, context?: ReviverContext) => unknown;

const reviveBigInts: Reviver = (_key, value, context) => {
  if (typeof value === "number" && !Number.isSafeInteger(value) && Number.isInteger(value)) {
    const source = context?.source;
    if (source !== undefined && /^-?\d+$/.test(source)) {
      return BigInt(source);
    }
  }
  return value;
};

export function parseSodexJson(text: string): unknown {
  return JSON.parse(text, reviveBigInts);
}
