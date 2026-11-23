import { randomBytes } from "node:crypto";

import {
  isProblemCall,
  SodexCallOutcome,
  SodexUnreadableReason,
  type SodexHeader,
} from "@drift/shared";

import {
  RECORD_BODY_LIMIT,
  type SodexCallCapture,
  type SodexRestCapture,
  type SodexWsCapture,
} from "./capture";
import {
  redactBody,
  redactHeaders,
  type RedactOptions,
  responseHeaderList,
  sanitizeText,
  scrubText,
} from "./redact";

// Bản ghi thô → dòng lưu được (chạy ở bước flush, ngoài đường gửi lệnh). Phân loại outcome theo DEC-309:
// ok / rejected (code ≠ 0 ở envelope hoặc ở một lệnh; kể cả `OrderNotFound` của lệnh huỷ không kèm clOrdID, #493) / timeout /
// network / unreadable (envelope ok nhưng không đọc được).
// Không parse JSON ở đây (review PR #217, B2): code envelope và kết quả lệnh đến từ object client đã parse; clOrdID và
// accountID trong body request lấy bằng regex; body chỉ được che bằng regex trên chuỗi đã cắt.

/** Giới hạn body response lưu lại: lời gọi thành công giữ ít hơn lời gọi có vấn đề. */
export const RESPONSE_BODY_LIMIT = { ok: 16 * 1024, problem: 64 * 1024 } as const;
export const REQUEST_BODY_LIMIT = 64 * 1024;

export interface SodexCallRow {
  id: string;
  at: Date;
  service: string;
  kind: "rest" | "ws";
  method: string;
  endpoint: string;
  url: string | null;
  engine: "spot" | "perps" | null;
  actionType: string | null;
  outcome: SodexCallOutcome;
  httpStatus: number | null;
  /** `code` của lỗi: envelope âm, hoặc lệnh đầu tiên có code ≠ 0. */
  sodexCode: number | null;
  sodexError: string | null;
  envelopeCode: number | null;
  orderCodes: number[];
  unreadableReason: SodexUnreadableReason | null;
  errorDetail: string | null;
  latencyMs: number;
  requestHeaders: SodexHeader[];
  requestBody: string | null;
  requestBodyBytes: number | null;
  signed: boolean;
  responseHeaders: { name: string; value: string }[];
  responseBody: string | null;
  responseBodyBytes: number | null;
  responseTruncated: boolean;
  botId: string | null;
  accountId: string | null;
  accountAddress: string | null;
  sodexAccountId: string | null;
  clOrdIds: string[];
  orderIds: string[];
  traceId: string | null;
  connId: string | null;
  /** Giữ 14 ngày (lỗi hoặc chậm) thay vì 3 ngày. */
  problem: boolean;
}

/** UUID v7 theo thời điểm `ms`: id mang thời gian, API tìm đúng chunk từ id. */
export function uuidV7At(ms: number): string {
  const b = randomBytes(16);
  const t = BigInt(Math.max(0, Math.floor(ms)));
  for (let i = 0; i < 6; i += 1) b[i] = Number((t >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Thời điểm (ms) nằm trong UUID v7. */
export function uuidV7Time(id: string): number {
  return Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

const ADDRESS = /0x[0-9a-fA-F]{40}/;

/** `/perps/accounts/0xabc…/orders?symbol=…` → `/perps/accounts/{addr}/orders`; kline / orderbook theo `{symbol}`. */
export function endpointTemplate(path: string): string {
  const noQuery = path.split("?")[0] ?? path;
  return noQuery
    .replace(/\/0x[0-9a-fA-F]{40}(?=\/|$)/g, "/{addr}")
    .replace(
      /\/markets\/(?!symbols$|mark-prices$|tickers$)[^/]+\/(klines|orderbook|trades)$/,
      "/markets/{symbol}/$1",
    );
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/api\/v1/, "");
    return `${p}${u.search}`;
  } catch {
    return url;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function idString(v: unknown): string | null {
  return typeof v === "string" || typeof v === "number" || typeof v === "bigint" ? String(v) : null;
}

const CL_ORD_ID = /"(?:orig)?[cC]lOrdID"\s*:\s*"([^"\\]{1,64})"/g;
const ACCOUNT_ID = /"accountID"\s*:\s*(\d{1,20})/;

/** clOrdID trong body request (lệnh, huỷ, modify), không parse. */
function clOrdIdsOfRequest(body: string | null): string[] {
  if (body === null) return [];
  const out: string[] = [];
  for (const m of body.matchAll(CL_ORD_ID)) {
    const v = m[1];
    if (v !== undefined && !out.includes(v)) out.push(v);
  }
  return out;
}

interface Verdict {
  outcome: SodexCallOutcome;
  sodexCode: number | null;
  sodexError: string | null;
  envelopeCode: number | null;
  orderCodes: number[];
  unreadableReason: SodexUnreadableReason | null;
  clOrdIds: string[];
  orderIds: string[];
}

function classifyRest(c: SodexRestCapture): Verdict {
  const v: Verdict = {
    outcome: SodexCallOutcome.ok,
    sodexCode: null,
    sodexError: null,
    envelopeCode: c.envelopeCode,
    orderCodes: [],
    unreadableReason: null,
    // clOrdID của request thêm ở restRow (regex trên body); ở đây chỉ việc rẻ để dùng được lúc record.
    clOrdIds: [],
    orderIds: [],
  };
  if (c.failure !== null) return { ...v, outcome: c.failure };
  const status = c.httpStatus ?? 0;
  const ok2xx = status >= 200 && status < 300;
  const unreadable = (reason: SodexUnreadableReason): Verdict => ({
    ...v,
    outcome: SodexCallOutcome.unreadable,
    unreadableReason: reason,
  });
  if (!c.json) {
    return unreadable(ok2xx ? SodexUnreadableReason.invalidJson : SodexUnreadableReason.httpError);
  }
  const code = c.envelopeCode;
  if (code !== null && code !== 0) {
    return {
      ...v,
      outcome: SodexCallOutcome.rejected,
      sodexCode: code,
      sodexError: c.envelopeError,
    };
  }
  if (code === null) return unreadable(SodexUnreadableReason.schemaMismatch);
  if (!ok2xx) return unreadable(SodexUnreadableReason.httpError);
  if (c.schemaOk === false) return unreadable(SodexUnreadableReason.schemaMismatch);
  if (c.orderEndpoint === true && c.orderResults != null) {
    let firstBad: { code: number; error: string | null } | null = null;
    for (const item of c.orderResults) {
      const o = asRecord(item);
      const itemCode = o?.code;
      if (o === null || typeof itemCode !== "number") {
        return unreadable(SodexUnreadableReason.schemaMismatch);
      }
      v.orderCodes.push(itemCode);
      const orderId = idString(o.orderID);
      if (orderId !== null) v.orderIds.push(orderId);
      const error = typeof o.error === "string" ? o.error : null;
      // SoDEX trả `OrderNotFound` khi huỷ mà không kèm clOrdID (`[{"code":-1,"error":"order rejected: OrderNotFound"}]`):
      // từ chối nghiệp vụ đã biết (engine xử lý là `not_found`, DEC-250 / DEC-308), không phải response không đọc được
      // (#493, DEC-TBD-cancel-notfound-outcome). Item lỗi khác mà thiếu clOrdID vẫn là `unreadable`.
      if (typeof o.clOrdID !== "string" && itemCode !== 0 && isOrderNotFound(error)) {
        firstBad ??= { code: itemCode, error };
        continue;
      }
      if (typeof o.clOrdID !== "string") {
        return {
          ...unreadable(SodexUnreadableReason.orderResultWithoutClOrdId),
          sodexCode: itemCode,
          sodexError: error,
        };
      }
      if (!v.clOrdIds.includes(o.clOrdID)) v.clOrdIds.push(o.clOrdID);
      if (itemCode !== 0 && firstBad === null) firstBad = { code: itemCode, error };
    }
    if (firstBad !== null) {
      return {
        ...v,
        outcome: SodexCallOutcome.rejected,
        sodexCode: firstBad.code,
        sodexError: firstBad.error,
      };
    }
  }
  return v;
}

/** Lỗi `OrderNotFound` của SoDEX (như `isOrderNotFound` của engine, `apps/engine/src/http-gateway.ts`). */
const isOrderNotFound = (error: string | null): boolean =>
  error?.includes("OrderNotFound") === true;

/** Kết quả chính xác cho việc chọn bảng / bỏ gì khi đầy: dùng lại lúc record (rẻ: không parse). */
export function captureOutcome(c: SodexCallCapture): SodexCallOutcome {
  return c.kind === "rest" ? classifyRest(c).outcome : c.outcome;
}

/**
 * Che TRƯỚC rồi mới cắt về giới hạn lưu (review PR #217): cắt sau khi che không bao giờ để lại một đoạn hex dài.
 * Body đã bị cắt lúc record (`capBody`) có thể kết thúc giữa một chuỗi hex (một phần chữ ký / key, ngắn hơn ngưỡng
 * 64): bỏ hẳn đoạn hex dở ở cuối trước khi che.
 */
function redactThenCap(
  text: string | null,
  limit: number,
  options: RedactOptions = {},
): { text: string | null; truncated: boolean } {
  if (text === null) return { text, truncated: false };
  const cutAtRecord = text.length >= RECORD_BODY_LIMIT;
  const whole = cutAtRecord ? text.replace(/(?:0x)?[0-9a-fA-F]+$/, "") : text;
  const red = redactBody(whole, options) ?? "";
  if (red.length <= limit) return { text: red, truncated: cutAtRecord };
  return { text: red.slice(0, limit), truncated: true };
}

function restRow(c: SodexRestCapture, service: string): SodexCallRow {
  const verdict = classifyRest(c);
  const path = pathOf(c.url);
  const address = ADDRESS.exec(path)?.[0] ?? null;
  const latencyMs = Math.max(0, Math.round(c.latencyMs));
  const problem = isProblemCall(verdict.outcome, latencyMs);
  const engine = path.startsWith("/spot/") ? "spot" : path.startsWith("/perps/") ? "perps" : null;
  // Tên key và public key ở endpoint api-keys chỉ giữ 4 ký tự cuối (quy tắc 1.9).
  const maskName = path.includes("/api-keys");
  const response = redactThenCap(
    c.responseText,
    problem ? RESPONSE_BODY_LIMIT.problem : RESPONSE_BODY_LIMIT.ok,
    { maskName },
  );
  const request = redactThenCap(c.requestBody, REQUEST_BODY_LIMIT, { maskName });
  return {
    id: uuidV7At(c.startedAt),
    at: new Date(c.startedAt),
    service,
    kind: "rest",
    method: c.method,
    endpoint: endpointTemplate(path),
    url: scrubText(c.url),
    engine,
    actionType: c.actionType,
    outcome: verdict.outcome,
    httpStatus: c.httpStatus,
    sodexCode: verdict.sodexCode,
    sodexError: scrubText(verdict.sodexError),
    envelopeCode: verdict.envelopeCode,
    orderCodes: verdict.orderCodes,
    unreadableReason: verdict.unreadableReason,
    errorDetail: scrubText(c.errorDetail),
    latencyMs,
    requestHeaders: redactHeaders(c.requestHeaders),
    requestBody: request.text,
    requestBodyBytes: c.requestBody === null ? null : c.requestBody.length,
    signed: c.signed,
    responseHeaders: responseHeaderList(c.responseHeaders),
    responseBody: response.text,
    responseBodyBytes: c.responseLength,
    responseTruncated:
      response.truncated || (c.responseLength ?? 0) > (c.responseText?.length ?? 0),
    botId: c.context?.botId ?? null,
    accountId: c.context?.accountId ?? null,
    accountAddress: address === null ? null : address.toLowerCase(),
    sodexAccountId: c.requestBody === null ? null : (ACCOUNT_ID.exec(c.requestBody)?.[1] ?? null),
    clOrdIds: [...new Set([...clOrdIdsOfRequest(c.requestBody), ...verdict.clOrdIds])].map(
      sanitizeText,
    ),
    orderIds: verdict.orderIds,
    traceId: c.context?.traceId ?? null,
    connId: null,
    problem,
  };
}

/** clOrdID / order ID trong phần tử tin push (`c`, `i`) đã parse. */
function idsOfPush(items: readonly unknown[] | null | undefined): {
  clOrdIds: string[];
  orderIds: string[];
} {
  const out = { clOrdIds: [] as string[], orderIds: [] as string[] };
  for (const item of items ?? []) {
    const o = asRecord(item);
    if (o === null) continue;
    if (typeof o.c === "string" && !out.clOrdIds.includes(o.c))
      out.clOrdIds.push(sanitizeText(o.c));
    const oid = idString(o.i);
    if (oid !== null && !out.orderIds.includes(oid)) out.orderIds.push(oid);
  }
  return out;
}

function wsRow(c: SodexWsCapture, service: string): SodexCallRow {
  const latencyMs = Math.max(0, Math.round(c.latencyMs));
  const outcome = c.outcome;
  const problem = isProblemCall(outcome, latencyMs);
  const response = redactThenCap(
    c.response,
    problem ? RESPONSE_BODY_LIMIT.problem : RESPONSE_BODY_LIMIT.ok,
  );
  const ids = c.event === "MSG" ? idsOfPush(c.items) : { clOrdIds: [], orderIds: [] };
  const detail = scrubText(c.detail);
  return {
    id: uuidV7At(c.startedAt),
    at: new Date(c.startedAt),
    service,
    kind: "ws",
    method: c.event,
    endpoint: c.channel ?? "connection",
    url: c.url,
    engine: c.engine,
    actionType: null,
    outcome,
    httpStatus: null,
    sodexCode: null,
    sodexError: outcome === SodexCallOutcome.rejected ? detail : null,
    envelopeCode: null,
    orderCodes: [],
    unreadableReason:
      outcome === SodexCallOutcome.unreadable ? SodexUnreadableReason.invalidJson : null,
    errorDetail: outcome === SodexCallOutcome.rejected ? null : detail,
    latencyMs,
    requestHeaders: [],
    requestBody: redactThenCap(c.request, REQUEST_BODY_LIMIT).text,
    requestBodyBytes: c.request === null ? null : c.request.length,
    signed: false,
    responseHeaders: [],
    responseBody: response.text,
    responseBodyBytes: c.response === null ? null : c.response.length,
    responseTruncated: response.truncated,
    botId: c.context?.botId ?? null,
    accountId: c.context?.accountId ?? null,
    accountAddress: c.accountAddress.toLowerCase(),
    sodexAccountId: c.sodexAccountId,
    clOrdIds: ids.clOrdIds,
    orderIds: ids.orderIds,
    traceId: c.context?.traceId ?? null,
    connId: c.connId,
    problem,
  };
}

export function toSodexCallRow(capture: SodexCallCapture, service: string): SodexCallRow {
  return capture.kind === "rest" ? restRow(capture, service) : wsRow(capture, service);
}
