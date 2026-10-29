import { json, optional, type JsonValue } from "../signing/canonical-json";
import { buildPayload, ExchangeDomain, type SignedPayload } from "../signing/exchange";

import {
  SodexActionType,
  SodexPositionSide,
  type SodexMarginMode,
  type SodexOrderModifier,
  type SodexOrderType,
  type SodexSide,
  type SodexStopType,
  type SodexTimeInForce,
  type SodexTriggerType,
} from "./enums";

// Builder cho action lệnh. Thứ tự field khớp Go struct của SoDEX; đổi thứ tự là đổi hash.

/** clOrdID tất định do engine sinh (CLAUDE.md, quy định code 4). */
export const CL_ORD_ID_PATTERN = /^[0-9a-zA-Z_-]{1,36}$/;
export const MAX_BATCH_SIZE = 100;

export interface Builder {
  id: bigint;
  /** Phần mười bp; DRIFT luôn dùng 50 (DEC-04). */
  fee: number;
}

function builderJson(builder: Builder): JsonValue {
  return json.object([
    ["id", json.uint(builder.id)],
    ["fee", json.uint(builder.fee)],
  ]);
}

function checkClOrdId(clOrdID: string): void {
  if (!CL_ORD_ID_PATTERN.test(clOrdID)) {
    throw new RangeError(`Invalid clOrdID: ${JSON.stringify(clOrdID)}`);
  }
}

function checkBatch(length: number): void {
  if (length < 1 || length > MAX_BATCH_SIZE) {
    throw new RangeError(`Batch size must be between 1 and ${String(MAX_BATCH_SIZE)}`);
  }
}

export interface ActionPayload extends SignedPayload {
  type: string;
  domain: ExchangeDomain;
}

// ---------- Spot ----------

export interface SpotOrder {
  symbolID: bigint;
  clOrdID: string;
  side: SodexSide;
  type: SodexOrderType;
  timeInForce: SodexTimeInForce;
  price?: string;
  quantity?: string;
  funds?: string;
}

export function spotNewOrders(input: {
  accountID: bigint;
  orders: readonly SpotOrder[];
  builder?: Builder;
}): ActionPayload {
  checkBatch(input.orders.length);
  const orders = input.orders.map((order) => {
    checkClOrdId(order.clOrdID);
    return json.object([
      ["symbolID", json.uint(order.symbolID)],
      ["clOrdID", json.string(order.clOrdID)],
      ["side", json.uint(order.side)],
      ["type", json.uint(order.type)],
      ["timeInForce", json.uint(order.timeInForce)],
      ["price", optional(order.price, json.decimal)],
      ["quantity", optional(order.quantity, json.decimal)],
      ["funds", optional(order.funds, json.decimal)],
    ]);
  });
  const params = json.object([
    ["accountID", json.uint(input.accountID)],
    ["orders", json.array(orders)],
    ["builder", optional(input.builder, builderJson)],
  ]);
  const type = SodexActionType.spotNewOrder;
  return { type, domain: ExchangeDomain.spot, ...buildPayload(type, params) };
}

export interface SpotCancel {
  symbolID: bigint;
  /** Tên của chính request huỷ. */
  clOrdID: string;
  orderID?: bigint;
  origClOrdID?: string;
}

export function spotCancelOrders(input: {
  accountID: bigint;
  cancels: readonly SpotCancel[];
}): ActionPayload {
  checkBatch(input.cancels.length);
  const cancels = input.cancels.map((cancel) => {
    checkClOrdId(cancel.clOrdID);
    if (cancel.orderID === undefined && cancel.origClOrdID === undefined) {
      throw new RangeError("Cancel needs orderID or origClOrdID");
    }
    return json.object([
      ["symbolID", json.uint(cancel.symbolID)],
      ["clOrdID", json.string(cancel.clOrdID)],
      ["orderID", optional(cancel.orderID, json.uint)],
      ["origClOrdID", optional(cancel.origClOrdID, json.string)],
    ]);
  });
  const params = json.object([
    ["accountID", json.uint(input.accountID)],
    ["cancels", json.array(cancels)],
  ]);
  const type = SodexActionType.spotCancelOrder;
  return { type, domain: ExchangeDomain.spot, ...buildPayload(type, params) };
}

// ---------- Perps ----------

export interface PerpsOrder {
  clOrdID: string;
  modifier: SodexOrderModifier;
  side: SodexSide;
  type: SodexOrderType;
  timeInForce: SodexTimeInForce;
  price?: string;
  quantity?: string;
  funds?: string;
  stopPrice?: string;
  stopType?: SodexStopType;
  triggerType?: SodexTriggerType;
  reduceOnly: boolean;
}

export function perpsNewOrders(input: {
  accountID: bigint;
  symbolID: bigint;
  orders: readonly PerpsOrder[];
  builder?: Builder;
}): ActionPayload {
  checkBatch(input.orders.length);
  const orders = input.orders.map((order) => {
    checkClOrdId(order.clOrdID);
    return json.object([
      ["clOrdID", json.string(order.clOrdID)],
      ["modifier", json.uint(order.modifier)],
      ["side", json.uint(order.side)],
      ["type", json.uint(order.type)],
      ["timeInForce", json.uint(order.timeInForce)],
      ["price", optional(order.price, json.decimal)],
      ["quantity", optional(order.quantity, json.decimal)],
      ["funds", optional(order.funds, json.decimal)],
      ["stopPrice", optional(order.stopPrice, json.decimal)],
      ["stopType", optional(order.stopType, json.uint)],
      ["triggerType", optional(order.triggerType, json.uint)],
      ["reduceOnly", json.bool(order.reduceOnly)],
      // Lệnh chỉ nhận BOTH (docs/SODEX.md mục 5.6).
      ["positionSide", json.uint(SodexPositionSide.both)],
    ]);
  });
  const params = json.object([
    ["accountID", json.uint(input.accountID)],
    ["symbolID", json.uint(input.symbolID)],
    ["orders", json.array(orders)],
    ["builder", optional(input.builder, builderJson)],
  ]);
  const type = SodexActionType.perpsNewOrder;
  return { type, domain: ExchangeDomain.futures, ...buildPayload(type, params) };
}

export type PerpsCancel =
  | { symbolID: bigint; orderID: bigint; clOrdID?: never }
  | { symbolID: bigint; clOrdID: string; orderID?: never };

export function perpsCancelOrders(input: {
  accountID: bigint;
  cancels: readonly PerpsCancel[];
}): ActionPayload {
  checkBatch(input.cancels.length);
  const cancels = input.cancels.map((cancel) => {
    if (cancel.clOrdID !== undefined) checkClOrdId(cancel.clOrdID);
    return json.object([
      ["symbolID", json.uint(cancel.symbolID)],
      ["orderID", optional(cancel.orderID, json.uint)],
      ["clOrdID", optional(cancel.clOrdID, json.string)],
    ]);
  });
  const params = json.object([
    ["accountID", json.uint(input.accountID)],
    ["cancels", json.array(cancels)],
  ]);
  const type = SodexActionType.perpsCancelOrder;
  return { type, domain: ExchangeDomain.futures, ...buildPayload(type, params) };
}

/**
 * Đặt đòn bẩy và margin mode của account cho một symbol Perps (Go SDK `UpdateLeverageRequest`,
 * thứ tự field `accountID, symbolID, leverage, marginMode`). SoDEX áp dụng cho mọi lệnh sau đó
 * trên symbol này; không gửi thì lệnh dùng thiết lập sẵn có của account.
 */
export function perpsUpdateLeverage(input: {
  accountID: bigint;
  symbolID: bigint;
  leverage: number;
  marginMode: SodexMarginMode;
}): ActionPayload {
  if (!Number.isInteger(input.leverage) || input.leverage < 1) {
    throw new RangeError(`Invalid leverage: ${String(input.leverage)}`);
  }
  const params = json.object([
    ["accountID", json.uint(input.accountID)],
    ["symbolID", json.uint(input.symbolID)],
    ["leverage", json.uint(input.leverage)],
    ["marginMode", json.uint(input.marginMode)],
  ]);
  const type = SodexActionType.perpsUpdateLeverage;
  return { type, domain: ExchangeDomain.futures, ...buildPayload(type, params) };
}
