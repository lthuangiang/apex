import { DECIMAL_STRING_PATTERN, toDecimalString } from "@drift/shared";

// JSON gọn, giữ đúng thứ tự khoá như Go struct của SoDEX (docs/SODEX.md mục 5.6).
// Không dùng JSON.stringify cho object vì cần uint64 dạng bigint và bỏ field `omitempty`.

export type JsonValue =
  | { kind: "uint"; value: bigint }
  | { kind: "string"; value: string }
  | { kind: "decimal"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "array"; items: readonly JsonValue[] }
  | { kind: "object"; fields: readonly (readonly [string, JsonValue | undefined])[] };

export const json = {
  uint: (value: bigint | number): JsonValue => {
    const v = BigInt(value);
    if (v < 0n) throw new RangeError("uint must be non-negative");
    return { kind: "uint", value: v };
  },
  string: (value: string): JsonValue => ({ kind: "string", value }),
  /** Số thập phân dạng chuỗi, chuẩn hoá như server (bỏ số 0 thừa, không dùng mũ). */
  decimal: (value: string): JsonValue => {
    if (!DECIMAL_STRING_PATTERN.test(value)) {
      throw new RangeError(`Invalid decimal string: ${JSON.stringify(value)}`);
    }
    return { kind: "decimal", value: toDecimalString(value) };
  },
  bool: (value: boolean): JsonValue => ({ kind: "bool", value }),
  array: (items: readonly JsonValue[]): JsonValue => ({ kind: "array", items }),
  /** Field có giá trị `undefined` bị bỏ qua (tương đương `omitempty`). */
  object: (fields: readonly (readonly [string, JsonValue | undefined])[]): JsonValue => ({
    kind: "object",
    fields,
  }),
};

export function optional<T>(
  value: T | undefined,
  wrap: (v: T) => JsonValue,
): JsonValue | undefined {
  return value === undefined ? undefined : wrap(value);
}

export function serialize(value: JsonValue): string {
  switch (value.kind) {
    case "uint":
      return value.value.toString();
    case "string":
    case "decimal":
      return JSON.stringify(value.value);
    case "bool":
      return value.value ? "true" : "false";
    case "array":
      return `[${value.items.map(serialize).join(",")}]`;
    case "object":
      return `{${value.fields
        .filter((field): field is readonly [string, JsonValue] => field[1] !== undefined)
        .map(([key, v]) => `${JSON.stringify(key)}:${serialize(v)}`)
        .join(",")}}`;
  }
}
