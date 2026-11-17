import { z } from "zod";

import { isoDateTimeSchema, pageSchema } from "../schemas";

// SoDEX Debugger (team, docs/mockups/sodex-debugger, DEC-TBD-sodex-debugger): mọi lời gọi REST tới SoDEX và sự kiện
// WS user stream mà DeskLabs gửi / nhận. Bảng `sodex_calls` (view trên hai hypertable theo thời hạn giữ).

/** Kết quả một lời gọi, phân loại khi ghi (packages/sodex/src/debug/classify.ts). */
export const SodexCallOutcome = {
  ok: "ok",
  /** SoDEX trả `code` ≠ 0, hoặc một lệnh trong batch có `code` ≠ 0, hoặc subscribe bị từ chối. */
  rejected: "rejected",
  timeout: "timeout",
  network: "network",
  /** Envelope ok nhưng không đọc được kết quả (JSON hỏng, sai schema, kết quả lệnh không có clOrdID…). */
  unreadable: "unreadable",
} as const;
export type SodexCallOutcome = (typeof SodexCallOutcome)[keyof typeof SodexCallOutcome];
export const SODEX_CALL_OUTCOMES = Object.values(SodexCallOutcome) as [
  SodexCallOutcome,
  ...SodexCallOutcome[],
];

export const SodexCallKind = { rest: "rest", ws: "ws" } as const;
export type SodexCallKind = (typeof SodexCallKind)[keyof typeof SodexCallKind];

/** Vì sao một lời gọi là `unreadable`; UI chọn câu giải thích theo mã này. */
export const SodexUnreadableReason = {
  invalidJson: "invalid_json",
  schemaMismatch: "schema_mismatch",
  httpError: "http_error",
  orderResultWithoutClOrdId: "order_result_without_cl_ord_id",
} as const;
export type SodexUnreadableReason =
  (typeof SodexUnreadableReason)[keyof typeof SodexUnreadableReason];

/** Lời gọi chậm hơn ngưỡng này được giữ 14 ngày như lời gọi lỗi (DEC-TBD-sodex-debugger). */
export const SODEX_CALL_SLOW_MS = 1000;
/** Thời hạn giữ: lỗi / chậm 14 ngày, thành công 3 ngày. */
export const SODEX_CALL_RETENTION_DAYS = { problem: 14, ok: 3 } as const;

/** Lời gọi có thuộc nhóm "vấn đề" (giữ 14 ngày) không. */
export function isProblemCall(outcome: SodexCallOutcome, latencyMs: number): boolean {
  return outcome !== SodexCallOutcome.ok || latencyMs > SODEX_CALL_SLOW_MS;
}

export const SODEX_CALL_RANGES = ["1h", "6h", "24h", "3d", "14d"] as const;
export type SodexCallRange = (typeof SODEX_CALL_RANGES)[number];
export const SODEX_CALL_RANGE_MS: Record<SodexCallRange, number> = {
  "1h": 3_600_000,
  "6h": 6 * 3_600_000,
  "24h": 24 * 3_600_000,
  "3d": 3 * 24 * 3_600_000,
  "14d": 14 * 24 * 3_600_000,
};

/** Nút lọc Outcome: All / Errors (mọi outcome ≠ ok) / Timeouts / Slow (> `slowMs`). */
export const SODEX_CALL_SHOW = ["all", "errors", "timeouts", "slow"] as const;
export type SodexCallShow = (typeof SODEX_CALL_SHOW)[number];

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const sodexCallsQuerySchema = z.object({
  range: z.enum(SODEX_CALL_RANGES).default("24h"),
  service: z.string().min(1).max(40).optional(),
  endpoint: z.string().min(1).max(200).optional(),
  botId: z.uuid().optional(),
  account: addressSchema.optional(),
  /** clOrdID, SoDEX order ID, traceId hoặc connID (khớp chính xác). */
  q: z.string().trim().min(1).max(100).optional(),
  show: z.enum(SODEX_CALL_SHOW).default("all"),
  slowMs: z.coerce.number().int().min(1).max(600_000).default(SODEX_CALL_SLOW_MS),
  /** Lấy các lời gọi có `at` nhỏ hơn (trong range): dùng khi bấm một cột Timeouts per hour. */
  before: isoDateTimeSchema.optional(),
  /** Lấy các lời gọi có `at` từ mốc này (cùng với `before` để chọn một giờ). */
  after: isoDateTimeSchema.optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SodexCallsQuery = z.infer<typeof sodexCallsQuerySchema>;

export const sodexCallBotSchema = z.object({ id: z.uuid(), name: z.string() });

export const sodexCallItemSchema = z.object({
  id: z.uuid(),
  /** Thời điểm gửi request / nhận sự kiện, ISO 8601 UTC có mili giây. */
  at: z.iso.datetime({ offset: false, precision: 3 }),
  service: z.string(),
  kind: z.enum([SodexCallKind.rest, SodexCallKind.ws]),
  /** REST: GET / POST / DELETE. WS: OPEN / SUB / MSG / CLOSE / ERROR. */
  method: z.string(),
  /** Đường dẫn dạng mẫu (`/perps/accounts/{addr}/orders`) hoặc kênh WS. */
  endpoint: z.string(),
  httpStatus: z.number().int().nullable(),
  outcome: z.enum(SODEX_CALL_OUTCOMES),
  sodexCode: z.number().int().nullable(),
  /** `error` của SoDEX, hoặc chi tiết lỗi mạng / timeout của DeskLabs. */
  sodexSays: z.string().nullable(),
  latencyMs: z.number().int().nonnegative(),
  bot: sodexCallBotSchema.nullable(),
  /** Địa chỉ đầy đủ; UI che còn đầu…cuối. */
  accountAddress: addressSchema.nullable(),
  clOrdIds: z.array(z.string()),
  connId: z.string().nullable(),
});
export type SodexCallItem = z.infer<typeof sodexCallItemSchema>;

/**
 * Số đếm cạnh nút Outcome bị chặn ở mức này (đếm tối đa `CAP + 1` dòng): UI hiện "1,000+" khi vượt, để đếm không
 * quét cả 14 ngày (review PR #217 M4).
 */
export const SODEX_CALL_COUNT_CAP = 1000;

export const sodexCallCountsSchema = z.object({
  all: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  timeouts: z.number().int().nonnegative(),
  slow: z.number().int().nonnegative(),
});

export const sodexCallsPageSchema = pageSchema(sodexCallItemSchema).extend({
  /**
   * Số lời gọi theo bộ lọc hiện tại (trừ nút Outcome), để hiện cạnh từng nút; tối đa `SODEX_CALL_COUNT_CAP + 1`.
   * Chỉ có ở trang đầu (không có cursor); trang sau là null.
   */
  counts: sodexCallCountsSchema.nullable(),
  /** Thời điểm server đọc (ISO UTC), cho dòng "Updated … UTC". */
  readAt: isoDateTimeSchema,
});
export type SodexCallsPage = z.infer<typeof sodexCallsPageSchema>;

export const sodexHeaderSchema = z.object({
  name: z.string(),
  /** Giá trị đã che: `null` khi đã bỏ hẳn (chữ ký). */
  value: z.string().nullable(),
  redaction: z.enum(["none", "signature", "masked"]),
});
export type SodexHeader = z.infer<typeof sodexHeaderSchema>;

export const sodexCallDetailSchema = sodexCallItemSchema.extend({
  url: z.string().nullable(),
  engine: z.enum(["spot", "perps"]).nullable(),
  /** Action đã ký (`newOrder`, `cancelOrder`…); `null` với lời gọi không ký. */
  actionType: z.string().nullable(),
  requestHeaders: z.array(sodexHeaderSchema),
  /** JSON đã định dạng, đã bỏ mọi chữ ký / secret. */
  requestBody: z.string().nullable(),
  requestBodyBytes: z.number().int().nonnegative().nullable(),
  /** Request có chữ ký (đã bỏ khỏi bản lưu). */
  signed: z.boolean(),
  responseHeaders: z.array(z.object({ name: z.string(), value: z.string() })),
  responseBody: z.string().nullable(),
  responseBodyBytes: z.number().int().nonnegative().nullable(),
  /** Body response dài hơn giới hạn lưu nên chỉ giữ phần đầu. */
  responseTruncated: z.boolean(),
  /** `code` của envelope và `code` của từng lệnh (nếu có). */
  envelopeCode: z.number().int().nullable(),
  orderCodes: z.array(z.number().int()),
  unreadableReason: z
    .enum([
      SodexUnreadableReason.invalidJson,
      SodexUnreadableReason.schemaMismatch,
      SodexUnreadableReason.httpError,
      SodexUnreadableReason.orderResultWithoutClOrdId,
    ])
    .nullable(),
  traceId: z.string().nullable(),
  sodexAccountId: z.string().nullable(),
  orderIds: z.array(z.string()),
  botDetail: z
    .object({ id: z.uuid(), name: z.string(), strategy: z.string(), market: z.string() })
    .nullable(),
  /** User sở hữu account (để mở trang Users); `null` khi không khớp. */
  accountUserId: z.uuid().nullable(),
  /** Kết nối WS user stream của cùng account + engine đang mở lúc này (REST) hoặc của chính sự kiện (WS). */
  wsConn: z.object({ connId: z.string(), open: z.boolean() }).nullable(),
  /** Lời gọi cùng traceId hoặc clOrdID trong ±10 phút, cũ trước. */
  related: z.array(sodexCallItemSchema),
  /** Builder ID của DeskLabs cho báo cáo; `null` khi chưa cấu hình. */
  builderId: z.string().nullable(),
});
export type SodexCallDetail = z.infer<typeof sodexCallDetailSchema>;

export const sodexEndpointStatSchema = z.object({
  endpoint: z.string(),
  /** REST method hoặc "WS SUB" … */
  method: z.string(),
  calls: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  timeouts: z.number().int().nonnegative(),
  p95Ms: z.number().int().nullable(),
  /** Tỷ lệ lỗi / số timeout cao hơn mức thường (công thức ở DEC-TBD-sodex-debugger). */
  errorsAboveUsual: z.boolean(),
  timeoutsAboveUsual: z.boolean(),
});
export type SodexEndpointStat = z.infer<typeof sodexEndpointStatSchema>;

export const sodexCallSummarySchema = z.object({
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  calls: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  timeouts: z.number().int().nonnegative(),
  timeoutsAboveUsual: z.boolean(),
  errorsAboveUsual: z.boolean(),
  p95Ms: z.number().int().nullable(),
  /** 24 cột theo giờ UTC, cũ trước; `hour` là đầu giờ. */
  timeoutsPerHour: z.array(z.object({ hour: isoDateTimeSchema, count: z.number().int() })),
  /** Giờ nhiều timeout nhất (null khi không có timeout). */
  peak: z
    .object({
      hour: isoDateTimeSchema,
      count: z.number().int(),
      firstAt: isoDateTimeSchema,
      lastAt: isoDateTimeSchema,
      endpoints: z.array(z.string()),
    })
    .nullable(),
  endpoints: z.array(sodexEndpointStatSchema),
  /** Lý do bị từ chối nhiều nhất trên lệnh mới và tỷ lệ của nó (0–1); null khi không có reject. */
  topReject: z.object({ reason: z.string(), share: z.number().min(0).max(1) }).nullable(),
  readAt: isoDateTimeSchema,
});
export type SodexCallSummary = z.infer<typeof sodexCallSummarySchema>;

export const sodexCallFacetsQuerySchema = z.object({
  range: z.enum(SODEX_CALL_RANGES).default("24h"),
});
export const sodexCallFacetsSchema = z.object({
  services: z.array(z.string()),
  endpoints: z.array(z.string()),
  bots: z.array(sodexCallBotSchema),
  accounts: z.array(addressSchema),
});
export type SodexCallFacets = z.infer<typeof sodexCallFacetsSchema>;
