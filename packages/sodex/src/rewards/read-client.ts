import {
  lotteryDrawEntriesSchema,
  lotteryTreasuresSchema,
  rewardAmountSchema,
  rewardsEnvelopeSchema,
  rewardsJwtSchema,
  rewardsRetryAfterSchema,
  SODEX_REWARDS_DEFAULT_ORIGIN,
  sopointsSummarySchema,
} from "@drift/shared";
import { z } from "zod";

import type { BucketSpec, RateLimitStore } from "../rate-limit/token-bucket";

// Client CHỈ ĐỌC của Rewards API SoDEX phía server (#558, DEC-398). Mọi lời gọi gateway rewards từ server (api lúc bật
// báo box mới, scheduler lúc đọc định kỳ) đi qua đây. JWT rewards một mình đủ để claim, nên client này chỉ có danh sách
// cho phép các đường dẫn đọc bên dưới, method luôn là GET, không bao giờ có body, host cố định. Không có hàm gọi chung
// nào nhận đường dẫn hay method từ ngoài. Không log gì (token nằm trong header). Test: `rewards-read-client.test.ts`.

/** Đường dẫn được phép (tương đối với `/api/v1/`) và weight theo tài liệu SoDEX (Rewards API › Rate limits). */
export const REWARDS_READ_ENDPOINTS = {
  treasures: { path: "lottery/treasures", weight: 1 },
  ledger: { path: "lottery/ledger", weight: 5 },
  drawEntries: { path: "lottery/draw/entries", weight: 5 },
  sopointsSummary: { path: "sopoints/summary", weight: 5 },
} as const;
export type RewardsReadEndpoint = keyof typeof REWARDS_READ_ENDPOINTS;

/** Body tối đa (byte) của một response; lớn hơn thì bỏ, coi như lỗi. */
export const REWARDS_READ_MAX_BODY = 256 * 1024;
export const REWARDS_READ_TIMEOUT_MS = 5000;
/** Ưu tiên `idle` (DEC-398): chỉ lấy token khi bucket IP chung còn trên 50%. */
export const REWARDS_IDLE_RESERVE = 0.5;

/** Ledger phía server: thêm các trường scheduler cần để phân loại (đều tuỳ chọn, khoan dung). */
export const rewardsLedgerReadSchema = z.object({
  total: z.number().int(),
  items: z.array(
    z.object({
      kind: z.string(),
      tsMs: z.number().int(),
      tokenId: z.number().int().nullish(),
      level: z.string().nullish(),
      direction: z.string().nullish(),
      reason: z.string().nullish(),
      round: z.number().int().nullish(),
      reward: rewardAmountSchema.nullish(),
    }),
  ),
});

const summaryWithWalletSchema = sopointsSummarySchema.extend({
  walletAddress: z.string().nullish(),
});

export type RewardsReadFailure =
  /** Token sai / hết hạn (HTTP 401). Người gọi xoá token, không thử lại. */
  | { kind: "unauthorized" }
  /** Gateway trả 429; `retryAfterMs` null khi không có `data.retryAfter`. */
  | { kind: "rate_limited"; retryAfterMs: number | null }
  /** Hạn mức của chính DeskLabs (bucket Redis) không cho gọi lúc này; chưa gửi gì. */
  | { kind: "budget"; retryAfterMs: number }
  /** Token không đúng dạng JWT: không gửi gì. */
  | { kind: "invalid_token" }
  | {
      kind: "error";
      code:
        | "network"
        | "timeout"
        | "http_status"
        | "too_large"
        | "invalid_json"
        | "business"
        | "schema";
      status?: number;
      businessCode?: number;
    };

export type RewardsReadResult<T> = { kind: "ok"; data: T } | RewardsReadFailure;

export type RewardsFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface RewardsReadClientOptions {
  /** Origin gateway (https). Trống / thiếu = mainnet. */
  gateway?: string | undefined;
  rateLimit: RateLimitStore;
  /** Khoá IP egress (`rl:sodex:ip:<egress>`), cùng bucket với REST giao dịch vì SoDEX đếm chung theo IP. */
  egressKey: string;
  /** Bucket IP chung (`ipBucket(SODEX_REST_WEIGHT_PER_MIN)`). Client áp dự trữ `REWARDS_IDLE_RESERVE`. */
  ipBucket: BucketSpec;
  /** Trần riêng của rewards (weight / phút, `rl:sodex:rewards:<egress>`). Thiếu = không có trần riêng. */
  maxWeightPerMinute?: number | undefined;
  fetch?: RewardsFetch;
  timeoutMs?: number;
}

export interface RewardsLedgerQuery {
  limit?: number;
  offset?: number;
}
export interface RewardsDrawQuery {
  round?: number;
  limit?: number;
  offset?: number;
}

const ledgerQuerySchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();
const drawQuerySchema = z
  .object({
    round: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

function gatewayOrigin(raw: string | undefined): string {
  const value = raw === undefined || raw.trim() === "" ? SODEX_REWARDS_DEFAULT_ORIGIN : raw.trim();
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Rewards gateway must use https");
  return url.origin;
}

export class RewardsReadClient {
  readonly #origin: string;
  readonly #rateLimit: RateLimitStore;
  readonly #egressKey: string;
  readonly #ipBucket: BucketSpec;
  readonly #capBucket: BucketSpec | null;
  readonly #fetch: RewardsFetch;
  readonly #timeoutMs: number;

  constructor(options: RewardsReadClientOptions) {
    this.#origin = gatewayOrigin(options.gateway);
    this.#rateLimit = options.rateLimit;
    this.#egressKey = options.egressKey;
    this.#ipBucket = {
      ...options.ipBucket,
      reserve: Math.floor(options.ipBucket.capacity * REWARDS_IDLE_RESERVE),
    };
    const cap = options.maxWeightPerMinute;
    this.#capBucket = cap === undefined ? null : { capacity: cap, refill: cap, intervalMs: 60_000 };
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? REWARDS_READ_TIMEOUT_MS;
  }

  getTreasures(token: string): Promise<RewardsReadResult<z.output<typeof lotteryTreasuresSchema>>> {
    return this.#read(token, "treasures", {}, lotteryTreasuresSchema);
  }

  getLedger(
    token: string,
    query: RewardsLedgerQuery = {},
  ): Promise<RewardsReadResult<z.output<typeof rewardsLedgerReadSchema>>> {
    return this.#read(token, "ledger", ledgerQuerySchema.parse(query), rewardsLedgerReadSchema);
  }

  getDrawEntries(
    token: string,
    query: RewardsDrawQuery = {},
  ): Promise<RewardsReadResult<z.output<typeof lotteryDrawEntriesSchema>>> {
    return this.#read(token, "drawEntries", drawQuerySchema.parse(query), lotteryDrawEntriesSchema);
  }

  /** Lúc bật báo box mới: `walletAddress` để so với master wallet (JWT không có claim ví). */
  getSopointsSummary(
    token: string,
  ): Promise<RewardsReadResult<z.output<typeof summaryWithWalletSchema>>> {
    return this.#read(token, "sopointsSummary", {}, summaryWithWalletSchema);
  }

  async #take(weight: number): Promise<RewardsReadFailure | null> {
    if (this.#capBucket !== null) {
      const cap = await this.#rateLimit.take(
        `sodex:rewards:${this.#egressKey}`,
        this.#capBucket,
        weight,
      );
      if (!cap.allowed) return { kind: "budget", retryAfterMs: cap.retryAfterMs };
    }
    const ip = await this.#rateLimit.take(`sodex:ip:${this.#egressKey}`, this.#ipBucket, weight);
    if (!ip.allowed) return { kind: "budget", retryAfterMs: ip.retryAfterMs };
    return null;
  }

  async #read<T extends z.ZodType>(
    token: string,
    endpoint: RewardsReadEndpoint,
    query: Readonly<Record<string, number | undefined>>,
    schema: T,
  ): Promise<RewardsReadResult<z.output<T>>> {
    if (!rewardsJwtSchema.safeParse(token).success) return { kind: "invalid_token" };
    const { path, weight } = REWARDS_READ_ENDPOINTS[endpoint];
    const denied = await this.#take(weight);
    if (denied !== null) return denied;

    const url = new URL(`/api/v1/${path}`, this.#origin);
    for (const [k, v] of Object.entries(query))
      if (v !== undefined) url.searchParams.set(k, String(v));

    let response: Response;
    try {
      response = await this.#fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const timeout =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return { kind: "error", code: timeout ? "timeout" : "network" };
    }

    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > REWARDS_READ_MAX_BODY) return { kind: "error", code: "too_large" };
    let text: string;
    try {
      text = await response.text();
    } catch {
      return { kind: "error", code: "network" };
    }
    if (text.length > REWARDS_READ_MAX_BODY) return { kind: "error", code: "too_large" };

    if (response.status === 401) return { kind: "unauthorized" };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (response.status === 429) {
      const r = rewardsRetryAfterSchema.safeParse(json);
      return {
        kind: "rate_limited",
        retryAfterMs: r.success ? r.data.data.retryAfter * 1000 : null,
      };
    }
    if (!response.ok) return { kind: "error", code: "http_status", status: response.status };
    if (json === undefined) return { kind: "error", code: "invalid_json" };
    const envelope = rewardsEnvelopeSchema.safeParse(json);
    if (!envelope.success) return { kind: "error", code: "schema" };
    if (envelope.data.code !== 0)
      return { kind: "error", code: "business", businessCode: envelope.data.code };
    const data = schema.safeParse(envelope.data.data);
    if (!data.success) return { kind: "error", code: "schema" };
    return { kind: "ok", data: data.data };
  }
}
