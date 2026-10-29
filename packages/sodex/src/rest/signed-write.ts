import { AppError, ErrorCode } from "@drift/shared";
import type { Hex } from "viem";
import { z } from "zod";

import type { SodexConfig } from "../config";
import type { RateLimitStore } from "../rate-limit/token-bucket";
import {
  ipBucket,
  KEY_ORDERS_PER_MINUTE,
  KEY_ORDERS_PER_SECOND,
  orderBatchWeight,
  RestWeight,
} from "../rate-limit/weights";

import { DEFAULT_TIMEOUT_MS, type FetchLike } from "./client";
import { parseSodexJson } from "./json";
import { errorEnvelopeSchema, successEnvelope, uint64Schema } from "./schemas";

// Request ghi đã ký. Không retry (CODING_STANDARDS C10, quy tắc 1.7): timeout, lỗi mạng, HTTP 5xx
// hoặc response không đọc được → "unknown"; engine đối soát theo clOrdID trước khi gửi lại.
// Nguồn: authentication-and-signing.md, manual-rest-signing.md (tra ngày 2026-10-27).

export type SignedWriteOutcome =
  /** HTTP 2xx và `code: 0`. Batch vẫn có thể có lỗi từng lệnh: xem `parseOrderResults`. */
  | { outcome: "ok"; data: unknown }
  /** SoDEX trả envelope lỗi (`code` âm): chắc chắn không được nhận. */
  | { outcome: "rejected"; status: number; sodexCode: number; sodexError: string }
  /** Không biết SoDEX đã nhận hay chưa. */
  | { outcome: "unknown" };

export interface SignedWriteRequest {
  /** Đường dẫn sau `/api/v1`, ví dụ `/perps/trade/orders`. */
  path: string;
  method: "POST" | "DELETE";
  /** Body đúng byte đã hash (chỉ `params`). DELETE cũng gửi body. */
  body: string;
  /** Đã có prefix `0x01` / `0x02`. Không bao giờ log giá trị này. */
  signature: Hex;
  nonce: bigint;
  /**
   * Tên API key (`X-API-Key`). Bỏ trống khi master wallet ký trực tiếp
   * (đăng ký key, approve builder fee).
   */
  apiKeyName?: string;
  /** `X-API-Chain`, chỉ cho action universal. */
  chainId?: bigint;
  /** Số lệnh trong batch đặt / huỷ / thay; tính vào hạn mức lệnh của API key. */
  orderCount?: number;
}

export interface SignedWriteOptions {
  config: Pick<SodexConfig, "restUrl" | "restWeightPerMinute">;
  rateLimit: RateLimitStore;
  egressKey: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class SignedWriteClient {
  readonly #base: string;
  readonly #rateLimit: RateLimitStore;
  readonly #egressKey: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  readonly #bucket: ReturnType<typeof ipBucket>;

  constructor(options: SignedWriteOptions) {
    this.#base = `${options.config.restUrl}/api/v1`;
    this.#rateLimit = options.rateLimit;
    this.#egressKey = options.egressKey;
    this.#bucket = ipBucket(options.config.restWeightPerMinute);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Gửi một request đã ký. Ném `RATE_LIMITED` **trước khi gửi** nếu hết hạn mức (an toàn để thử lại
   * sau `retryAfterMs` với cùng chữ ký nếu nonce còn hợp lệ). Mọi kết quả sau khi đã gửi đều trả về
   * dưới dạng `SignedWriteOutcome`, không ném.
   */
  async write(request: SignedWriteRequest): Promise<SignedWriteOutcome> {
    await this.#checkRateLimit(request);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-API-Sign": request.signature,
      "X-API-Nonce": request.nonce.toString(),
    };
    if (request.apiKeyName !== undefined) headers["X-API-Key"] = request.apiKeyName;
    if (request.chainId !== undefined) headers["X-API-Chain"] = request.chainId.toString();

    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${this.#base}${request.path}`, {
        method: request.method,
        headers,
        body: request.body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      text = await response.text();
    } catch {
      return { outcome: "unknown" };
    }

    let body: unknown;
    try {
      body = parseSodexJson(text);
    } catch {
      return { outcome: "unknown" };
    }

    const failure = errorEnvelopeSchema.safeParse(body);
    if (failure.success && response.status < 500) {
      return {
        outcome: "rejected",
        status: response.status,
        sodexCode: failure.data.code,
        sodexError: failure.data.error,
      };
    }

    const success = successEnvelope(z.unknown()).safeParse(body);
    if (response.ok && success.success) {
      return { outcome: "ok", data: success.data.data };
    }
    return { outcome: "unknown" };
  }

  async #checkRateLimit(request: SignedWriteRequest): Promise<void> {
    const count = request.orderCount;
    const checks: [string, Parameters<RateLimitStore["take"]>[1], number][] = [
      [
        `sodex:ip:${this.#egressKey}`,
        this.#bucket,
        count === undefined ? RestWeight.default : orderBatchWeight(count),
      ],
    ];
    if (count !== undefined && request.apiKeyName !== undefined) {
      checks.push([`sodex:key:${request.apiKeyName}:s`, KEY_ORDERS_PER_SECOND, count]);
      checks.push([`sodex:key:${request.apiKeyName}:m`, KEY_ORDERS_PER_MINUTE, count]);
    }
    for (const [key, spec, cost] of checks) {
      const result = await this.#rateLimit.take(key, spec, cost);
      if (!result.allowed) {
        throw new AppError(ErrorCode.rateLimited, "SoDEX rate limit reached", {
          retryAfterMs: result.retryAfterMs,
        });
      }
    }
  }
}

/** Kết quả từng lệnh trong batch đặt / huỷ (`ResponseData`). */
export const orderResultSchema = z.object({
  code: z.number().int(),
  clOrdID: z.string(),
  error: z.string().optional(),
  orderID: uint64Schema.optional(),
});
export type OrderResult = z.infer<typeof orderResultSchema>;

/**
 * Tài liệu: thường mỗi lệnh một phần tử, nhưng lỗi pre-validation có thể trả một phần tử cho cả batch.
 * Không giả định độ dài khớp với request; khớp theo `clOrdID`.
 */
export function parseOrderResults(data: unknown): OrderResult[] {
  return z.array(orderResultSchema).parse(data);
}
