import type { SodexCallContext } from "./context";

// Bản ghi thô mà client SoDEX đẩy vào recorder. Trên đường gửi lệnh chỉ dựng object này từ dữ liệu client ĐÃ parse
// (code của envelope, mảng kết quả lệnh), không parse lại, không I/O. Body chỉ giữ tối đa `RECORD_BODY_LIMIT` ký tự
// (bản sao, không giữ chuỗi gốc). Phân loại và che dữ liệu nhạy cảm làm ở bước flush (classify.ts, redact.ts) bằng
// regex trên chuỗi đã cắt, không parse JSON (review PR #217, B2).

/** Giá trị đặt vào header chữ ký ngay lúc capture: chữ ký thật không bao giờ vào hàng đợi. */
export const SIGNATURE_REDACTED = "[signature redacted]";

/** Số ký tự body tối đa giữ trong hàng đợi (= giới hạn lưu của lời gọi có vấn đề). */
export const RECORD_BODY_LIMIT = 64 * 1024;

/**
 * Cắt body về giới hạn lưu. Chuỗi dài được SAO CHÉP (qua Buffer) để hàng đợi không giữ cả response gốc
 * (chuỗi cắt của V8 giữ chuỗi cha). Chỉ tốn công khi body vượt giới hạn.
 */
export function capBody(text: string | null): string | null {
  if (text === null || text.length <= RECORD_BODY_LIMIT) return text;
  return Buffer.from(text.slice(0, RECORD_BODY_LIMIT), "utf8").toString("utf8");
}

/** `{code, error}` của envelope SoDEX từ body ĐÃ parse (không parse lại). */
export function envelopeOf(body: unknown): {
  code: number | null;
  error: string | null;
  data: unknown;
} {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { code: null, error: null, data: undefined };
  }
  const r = body as Record<string, unknown>;
  return {
    code: typeof r.code === "number" ? r.code : null,
    error: typeof r.error === "string" ? r.error : null,
    data: r.data,
  };
}

export function headerRecord(headers: Headers | null): Record<string, string> | null {
  if (headers === null) return null;
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

export interface SodexRestCapture {
  kind: "rest";
  /** `Date.now()` lúc gửi. */
  startedAt: number;
  latencyMs: number;
  method: "GET" | "POST" | "DELETE";
  url: string;
  /** Header đã gửi; `X-API-Sign` đã thay bằng `SIGNATURE_REDACTED`. */
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  signed: boolean;
  actionType: string | null;
  /** Không có response: timeout hoặc lỗi mạng. */
  failure: "timeout" | "network" | null;
  errorDetail: string | null;
  httpStatus: number | null;
  responseHeaders: Record<string, string> | null;
  /** Đã cắt bằng `capBody`. */
  responseText: string | null;
  /** Độ dài response gốc (ký tự). */
  responseLength: number | null;
  /** Response parse được thành JSON (client đã parse). */
  json: boolean;
  envelopeCode: number | null;
  envelopeError: string | null;
  /** GET: dữ liệu khớp schema của client không (`false` → unreadable). */
  schemaOk?: boolean;
  /** Request ghi tới endpoint lệnh: `data` (đã parse) là mảng kết quả từng lệnh, null khi không phải mảng. */
  orderEndpoint?: boolean;
  orderResults?: readonly unknown[] | null;
  context: SodexCallContext | undefined;
}

export type SodexWsEvent = "OPEN" | "SUB" | "MSG" | "CLOSE" | "ERROR";

export interface SodexWsCapture {
  kind: "ws";
  startedAt: number;
  latencyMs: number;
  event: SodexWsEvent;
  url: string;
  engine: "spot" | "perps";
  /** Kênh (`accountOrderUpdate`…); null với OPEN / CLOSE / ERROR. */
  channel: string | null;
  connId: string;
  accountAddress: string;
  sodexAccountId: string | null;
  /** Tin DeskLabs gửi (subscribe). */
  request: string | null;
  /** Tin SoDEX gửi (ack, push), đã cắt bằng `capBody`. */
  response: string | null;
  /** Phần tử `data` (đã parse) của tin push, để lấy clOrdID / order ID lúc flush. */
  items?: readonly unknown[] | null;
  /** Kết quả do client biết chắc (ack thành công / từ chối, đóng do timeout…). */
  outcome: "ok" | "rejected" | "timeout" | "network" | "unreadable";
  detail: string | null;
  context: SodexCallContext | undefined;
}

export type SodexCallCapture = SodexRestCapture | SodexWsCapture;

/** Bề mặt client cần: `record` phải đồng bộ, không ném, không chờ I/O. */
export interface SodexCallRecorderLike {
  record(capture: SodexCallCapture): void;
}

/** Ghi an toàn: recorder lỗi không bao giờ làm hỏng lời gọi SoDEX. */
export function safeRecord(
  recorder: SodexCallRecorderLike | undefined,
  build: () => SodexCallCapture,
): void {
  if (recorder === undefined) return;
  try {
    recorder.record(build());
  } catch {
    // Bỏ qua: debugger không được ảnh hưởng tới lệnh.
  }
}
