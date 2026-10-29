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
export const wsOrderUpdateSchema = z.object({
  s: z.string(), // symbol
  c: z.string(), // clOrdID
  i: uint64Schema, // orderID
  S: z.enum(WsOrderSide),
  o: z.enum(WsOrderType),
  f: z.enum(WsTimeInForce),
  p: decimal, // price
  q: decimal, // original quantity
  X: z.enum(WsOrderStatus),
  z: decimal, // cumulative filled quantity
  v: decimal, // cumulative filled value
  b: z.object({ i: uint64Schema, f: z.number().int().nonnegative() }).optional(), // builder
  E: z.number().int(), // event time ms
  T: z.number().int(), // block time ms
  t: uint64Schema.nullish(), // trade ID
  l: decimal.nullish(), // last executed quantity
  L: decimal.nullish(), // last executed price
  n: decimal.nullish(), // commission
  m: z.boolean().nullish(), // is maker
  x: z.enum(WsExecutionType),
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

/** Tài liệu ghi `data` của accountOrderUpdate có thể là object hoặc mảng. */
function parseItems<T extends z.ZodType>(schema: T, data: unknown): z.output<T>[] {
  if (Array.isArray(data)) return z.array(schema).parse(data);
  return [schema.parse(data)];
}

export function parseOrderUpdates(data: unknown): WsOrderUpdate[] {
  return parseItems(wsOrderUpdateSchema, data);
}

export function parseTrades(data: unknown): WsTrade[] {
  return parseItems(wsTradeSchema, data);
}
