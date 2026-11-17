import type { SodexCallContext } from "./context";

// Bản ghi thô mà client SoDEX đẩy vào recorder. Trên đường gửi lệnh chỉ dựng object này (không parse, không I/O);
// phân loại, che dữ liệu nhạy cảm và tuần tự hoá làm ở bước flush (classify.ts, redact.ts).

/** Giá trị đặt vào header chữ ký ngay lúc capture: chữ ký thật không bao giờ vào hàng đợi. */
export const SIGNATURE_REDACTED = "[signature redacted]";

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
  responseHeaders: Headers | null;
  responseText: string | null;
  /** GET: dữ liệu khớp schema của client không (`false` → unreadable). Bỏ trống với request ghi. */
  schemaOk?: boolean;
  /** Request ghi tới endpoint lệnh: `data` là mảng kết quả từng lệnh (ResponseData). */
  orderResults?: boolean;
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
  /** Tin SoDEX gửi (ack, push). */
  response: string | null;
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
