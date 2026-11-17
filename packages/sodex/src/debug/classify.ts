import { randomBytes } from "node:crypto";

import {
  isProblemCall,
  SodexCallOutcome,
  SodexUnreadableReason,
  type SodexHeader,
} from "@drift/shared";

import { parseSodexJson } from "../rest/json";

import type { SodexCallCapture, SodexRestCapture, SodexWsCapture } from "./capture";
import { redactBody, redactHeaders, responseHeaderList } from "./redact";

// Bản ghi thô → dòng lưu được (chạy ở bước flush, ngoài đường gửi lệnh). Phân loại outcome theo DEC-TBD-sodex-debugger:
// ok / rejected (code ≠ 0 ở envelope hoặc ở một lệnh) / timeout / network / unreadable (envelope ok nhưng không đọc được).

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

function bytes(text: string | null): number | null {
  return text === null ? null : Buffer.byteLength(text, "utf8");
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function idString(v: unknown): string | null {
  return typeof v === "string" || typeof v === "number" || typeof v === "bigint" ? String(v) : null;
}

/** clOrdID trong body request (lệnh, huỷ, modify). */
function clOrdIdsOfRequest(body: unknown): string[] {
  const r = asRecord(body);
  if (r === null) return [];
  const out: string[] = [];
  const push = (x: unknown) => {
    const o = asRecord(x);
    if (o === null) return;
    for (const k of ["clOrdID", "origClOrdID"]) {
      const v = o[k];
      if (typeof v === "string" && !out.includes(v)) out.push(v);
    }
  };
  push(r);
  for (const key of ["orders", "cancels"]) {
    const list = r[key];
    if (Array.isArray(list)) for (const x of list) push(x);
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

function classifyRest(c: SodexRestCapture, parsedBody: unknown): Verdict {
  const v: Verdict = {
    outcome: SodexCallOutcome.ok,
    sodexCode: null,
    sodexError: null,
    envelopeCode: null,
    orderCodes: [],
    unreadableReason: null,
    clOrdIds: clOrdIdsOfRequest(parsedBody),
    orderIds: [],
  };
  if (c.failure !== null) return { ...v, outcome: c.failure };
  const status = c.httpStatus ?? 0;
  const ok2xx = status >= 200 && status < 300;
  let body: unknown;
  try {
    body = parseSodexJson(c.responseText ?? "");
  } catch {
    return {
      ...v,
      outcome: SodexCallOutcome.unreadable,
      unreadableReason: ok2xx ? SodexUnreadableReason.invalidJson : SodexUnreadableReason.httpError,
    };
  }
  const env = asRecord(body);
  const code = env?.code;
  if (typeof code === "number") v.envelopeCode = code;
  if (typeof code === "number" && code !== 0) {
    return {
      ...v,
      outcome: SodexCallOutcome.rejected,
      sodexCode: code,
      sodexError: typeof env?.error === "string" ? env.error : null,
    };
  }
  if (code !== 0) {
    return {
      ...v,
      outcome: SodexCallOutcome.unreadable,
      unreadableReason: SodexUnreadableReason.schemaMismatch,
    };
  }
  if (!ok2xx) {
    return {
      ...v,
      outcome: SodexCallOutcome.unreadable,
      unreadableReason: SodexUnreadableReason.httpError,
    };
  }
  if (c.schemaOk === false) {
    return {
      ...v,
      outcome: SodexCallOutcome.unreadable,
      unreadableReason: SodexUnreadableReason.schemaMismatch,
    };
  }
  if (c.orderResults === true && Array.isArray(env?.data)) {
    let firstBad: { code: number; error: string | null } | null = null;
    for (const item of env.data) {
      const o = asRecord(item);
      const itemCode = o?.code;
      if (o === null || typeof itemCode !== "number") {
        return {
          ...v,
          outcome: SodexCallOutcome.unreadable,
          unreadableReason: SodexUnreadableReason.schemaMismatch,
        };
      }
      v.orderCodes.push(itemCode);
      const orderId = idString(o.orderID);
      if (orderId !== null) v.orderIds.push(orderId);
      const error = typeof o.error === "string" ? o.error : null;
      if (typeof o.clOrdID !== "string") {
        return {
          ...v,
          outcome: SodexCallOutcome.unreadable,
          unreadableReason: SodexUnreadableReason.orderResultWithoutClOrdId,
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

function accountFromBody(body: unknown): string | null {
  const id = asRecord(body)?.accountID;
  return idString(id);
}

function truncate(text: string | null, limit: number): { text: string | null; truncated: boolean } {
  if (text === null || text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

function restRow(c: SodexRestCapture, service: string): SodexCallRow {
  let parsedRequest: unknown = null;
  if (c.requestBody !== null) {
    try {
      parsedRequest = parseSodexJson(c.requestBody);
    } catch {
      parsedRequest = null;
    }
  }
  const verdict = classifyRest(c, parsedRequest);
  const path = pathOf(c.url);
  const address = ADDRESS.exec(path)?.[0] ?? null;
  const latencyMs = Math.max(0, Math.round(c.latencyMs));
  const problem = isProblemCall(verdict.outcome, latencyMs);
  const limit = problem ? RESPONSE_BODY_LIMIT.problem : RESPONSE_BODY_LIMIT.ok;
  const response = truncate(c.responseText, limit);
  const request = truncate(c.requestBody, REQUEST_BODY_LIMIT);
  const engine = path.startsWith("/spot/") ? "spot" : path.startsWith("/perps/") ? "perps" : null;
  return {
    id: uuidV7At(c.startedAt),
    at: new Date(c.startedAt),
    service,
    kind: "rest",
    method: c.method,
    endpoint: endpointTemplate(path),
    url: c.url,
    engine,
    actionType: c.actionType,
    outcome: verdict.outcome,
    httpStatus: c.httpStatus,
    sodexCode: verdict.sodexCode,
    sodexError: verdict.sodexError,
    envelopeCode: verdict.envelopeCode,
    orderCodes: verdict.orderCodes,
    unreadableReason: verdict.unreadableReason,
    errorDetail: c.errorDetail,
    latencyMs,
    requestHeaders: redactHeaders(c.requestHeaders),
    requestBody: redactBody(request.text),
    requestBodyBytes: bytes(c.requestBody),
    signed: c.signed,
    responseHeaders: responseHeaderList(c.responseHeaders),
    // Body bị cắt không còn là JSON: redactBody xử lý như văn bản (che hết nếu có chuỗi giống key).
    responseBody: redactBody(response.text),
    responseBodyBytes: bytes(c.responseText),
    responseTruncated: response.truncated,
    botId: c.context?.botId ?? null,
    accountId: c.context?.accountId ?? null,
    accountAddress: address === null ? null : address.toLowerCase(),
    sodexAccountId: accountFromBody(parsedRequest),
    clOrdIds: verdict.clOrdIds,
    orderIds: verdict.orderIds,
    traceId: c.context?.traceId ?? null,
    connId: null,
    problem,
  };
}

/** clOrdID / order ID trong tin push của user stream (`c`, `i`). */
function idsOfPush(text: string | null): { clOrdIds: string[]; orderIds: string[] } {
  const out = { clOrdIds: [] as string[], orderIds: [] as string[] };
  if (text === null) return out;
  let body: unknown;
  try {
    body = parseSodexJson(text);
  } catch {
    return out;
  }
  const data = asRecord(body)?.data;
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    const o = asRecord(item);
    if (o === null) continue;
    if (typeof o.c === "string" && !out.clOrdIds.includes(o.c)) out.clOrdIds.push(o.c);
    const oid = idString(o.i);
    if (oid !== null && !out.orderIds.includes(oid)) out.orderIds.push(oid);
  }
  return out;
}

function wsRow(c: SodexWsCapture, service: string): SodexCallRow {
  const latencyMs = Math.max(0, Math.round(c.latencyMs));
  const outcome = c.outcome;
  const problem = isProblemCall(outcome, latencyMs);
  const response = truncate(
    c.response,
    problem ? RESPONSE_BODY_LIMIT.problem : RESPONSE_BODY_LIMIT.ok,
  );
  const ids = c.event === "MSG" ? idsOfPush(c.response) : { clOrdIds: [], orderIds: [] };
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
    sodexError: outcome === SodexCallOutcome.rejected ? c.detail : null,
    envelopeCode: null,
    orderCodes: [],
    unreadableReason:
      outcome === SodexCallOutcome.unreadable ? SodexUnreadableReason.invalidJson : null,
    errorDetail: outcome === SodexCallOutcome.rejected ? null : c.detail,
    latencyMs,
    requestHeaders: [],
    requestBody: redactBody(c.request),
    requestBodyBytes: bytes(c.request),
    signed: false,
    responseHeaders: [],
    responseBody: redactBody(response.text),
    responseBodyBytes: bytes(c.response),
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
