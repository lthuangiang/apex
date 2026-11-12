import { decimalStringSchema } from "@drift/shared";
import { z } from "zod";

import { uint64Schema } from "../rest/schemas";

// Schema event WebSocket SoDEX (websocket-v1.md, rest-v1/schema.md; tra ngày 2026-10-27).
// Response dùng enum dạng chuỗi (request dùng số). Chỉ khai báo field DRIFT dùng; field thừa bị bỏ qua.

export const wsChannels = {
  accountOrderUpdate: "accountOrderUpdate",
  accountTrade: "accountTrade",
} as const;

export const WsOrderSide = ["BUY", "SELL"] as const;
export const WsOrderType = ["LIMIT", "MARKET"] as const;
export const WsTimeInForce = ["GTC", "FOK", "IOC", "GTX"] as const;
/** OrderStatusEnum. Khác ExecutionTypeEnum: không có MODIFIED / REPLACED, có TRIGGERED (perps). */
export const WsOrderStatus = [
  "NEW",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
  "TRIGGERED",
] as const;
export const WsExecutionType = [
  "NEW",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELED",
  "REJECTED",
  "MODIFIED",
  "EXPIRED",
  "REPLACED",
] as const;

const decimal = decimalStringSchema;

/** Push dữ liệu: `{channel, type, data}`. */
export const wsPushSchema = z.object({
  channel: z.string(),
  type: z.string().optional(),
  data: z.unknown(),
});

/** Ack của subscribe / unsubscribe. */
export const wsAckSchema = z.object({
  op: z.enum(["subscribe", "unsubscribe"]),
  id: z.number().int().nullable().optional(),
  success: z.boolean(),
  error: z.string().nullable().optional(),
});

/** WsSpotOrderUpdate / WsPerpsOrderUpdate (phần chung). */
/**
 * Số thập phân có thể rỗng: lệnh stop loss của cả vị thế (DEC-118) không có price / quantity. Rỗng, null hay thiếu
 * đều đọc thành "0" để một lệnh như vậy không làm hỏng cả lô tin.
 */
const optionalDecimal = z
  .union([decimal, z.literal("")])
  .nullish()
  .transform((v) => (v === undefined || v === null || v === "" ? "0" : v));

export const wsOrderUpdateSchema = z.object({
  s: z.string(), // symbol
  c: z.string(), // clOrdID
  i: uint64Schema, // orderID
  S: z.enum(WsOrderSide),
  // Loại lệnh, TIF, trạng thái: engine không dùng; nhận mọi chuỗi để lệnh stop (DEC-118) không làm hỏng lô tin.
  o: z.string(),
  f: z.string(),
  p: optionalDecimal, // price
  q: optionalDecimal, // original quantity
  X: z.string(),
  z: decimal, // cumulative filled quantity
  v: decimal, // cumulative filled value
  b: z
    .object({ i: uint64Schema, f: z.number().int().nonnegative() })
    .optional()
    .catch(undefined), // builder
  E: z.number().int(), // event time ms
  T: z.number().int().optional(), // block time ms
  t: uint64Schema.nullish(), // trade ID
  l: decimal.nullish(), // last executed quantity
  L: decimal.nullish(), // last executed price
  n: decimal.nullish(), // commission
  m: z.boolean().nullish(), // is maker
  // Engine không dùng; lệnh stop (DEC-118) có thể mang loại execution ngoài danh sách đã biết.
  x: z.string().optional(),
  r: z.string().nullish(), // execution reason
});
export type WsOrderUpdate = z.infer<typeof wsOrderUpdateSchema>;

/** WsSpotUserTrade / WsPerpsUserTrade. `bf` đã nằm trong `f`; không cộng hai lần (SODEX.md 5.3). */
export const wsTradeSchema = z.object({
  E: z.number().int(),
  T: z.number().int(),
  t: uint64Schema, // trade ID
  s: z.string(),
  i: uint64Schema, // orderID
  c: z.string(), // clOrdID
  S: z.enum(WsOrderSide),
  p: decimal,
  q: decimal,
  f: decimal, // total fee, gồm builder fee
  bf: decimal.optional(), // phần builder fee trong f
  m: z.boolean(),
});
export type WsTrade = z.infer<typeof wsTradeSchema>;

/** Một tin không đọc được trong lô; `issues` chỉ có đường dẫn field và mã lỗi, không có giá trị. */
export class WsSchemaError extends Error {
  constructor(
    readonly issues: string,
    readonly items: unknown[],
  ) {
    super(`did not match schema (${issues})`);
  }
}

/**
 * Tài liệu ghi `data` của accountOrderUpdate có thể là object hoặc mảng. Đọc từng tin: tin hỏng bị bỏ riêng, các tin
 * khác (ví dụ fill của lệnh thoát) vẫn được xử lý (DEC-118). `onInvalid` nhận mô tả lỗi để ghi log.
 */
function parseItems<T extends z.ZodType>(
  schema: T,
  data: unknown,
  onInvalid?: (error: WsSchemaError) => void,
): z.output<T>[] {
  const list = Array.isArray(data) ? data : [data];
  const out: z.output<T>[] = [];
  const bad: unknown[] = [];
  const issues: string[] = [];
  for (const item of list) {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
    else {
      bad.push(item);
      issues.push(...r.error.issues.map((i) => `${i.path.join(".")}:${i.code}`));
    }
  }
  if (bad.length > 0) onInvalid?.(new WsSchemaError([...new Set(issues)].join(", "), bad));
  return out;
}

export function parseOrderUpdates(
  data: unknown,
  onInvalid?: (error: WsSchemaError) => void,
): WsOrderUpdate[] {
  return parseItems(wsOrderUpdateSchema, data, onInvalid);
}

export function parseTrades(data: unknown, onInvalid?: (error: WsSchemaError) => void): WsTrade[] {
  return parseItems(wsTradeSchema, data, onInvalid);
}
