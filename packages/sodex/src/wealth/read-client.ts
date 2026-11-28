import {
  SODEX_WEALTH_DEFAULT_ORIGIN,
  WEALTH_PNL_HISTORY_INTERVALS,
  WEALTH_PNL_HISTORY_RANGES,
  wealthEnvelopeSchema,
  wealthFundDetailsSchema,
  wealthFundInfoSchema,
  wealthFundsSchema,
  wealthInFlightSchema,
  wealthPnlHistorySchema,
  wealthPnlSchema,
  wealthPositionsSchema,
  wealthRecurringBuysSchema,
  wealthRecurringExecutionsSchema,
  wealthTradingStatusSchema,
  wealthTvlSchema,
} from "@drift/shared";
import type { z } from "zod";

import type { BucketSpec, RateLimitStore } from "../rate-limit/token-bucket";

// Client CHỈ ĐỌC của SoDEX Wealth API công khai phía server (#589, DEC-402 mục 2). Quy tắc sản phẩm 1: DeskLabs không
// nạp, rút, chuyển. Client chỉ có danh sách các route đọc bên dưới, method luôn GET, không body, không header
// Authorization, không cookie, host cố định, không theo redirect. Không có hàm gọi chung nào nhận đường dẫn hay method
// từ ngoài; tham số đường dẫn (địa chỉ, fundId, planIndex) được kiểm dạng trước khi ghép. Không log gì (đường dẫn chứa
// địa chỉ ví). Test: `wealth-read-client.test.ts`.

/** Route được phép (tương đối với `/api/v1/wealth/`). `{a}` = địa chỉ ví, `{f}` = fundId, `{p}` = planIndex. */
export const WEALTH_READ_ENDPOINTS = {
  funds: "funds",
  fund: "funds/{f}",
  tradingStatus: "funds/{f}/trading-status",
  positions: "users/{a}/positions",
  pnl: "users/{a}/pnl",
  inFlight: "users/{a}/in-flight",
  fundDetails: "users/{a}/fund-details",
  recurringBuys: "users/{a}/recurring-buys",
  recurringBuyExecutions: "users/{a}/recurring-buys/{p}/executions",
  pnlHistory: "users/{a}/pnl-history",
  tvl: "users/{a}/tvl",
} as const;
export type WealthReadEndpoint = keyof typeof WEALTH_READ_ENDPOINTS;

/**
 * Weight mỗi lời gọi trên bucket IP chung. GIẢ ĐỊNH CHƯA ĐO: tài liệu SoDEX (Rate limits) không liệt kê route Wealth;
 * endpoint không liệt kê tính 20, nên tính 20 cho chắc.
 */
export const WEALTH_READ_WEIGHT = 20;
/** Body tối đa (byte); lớn hơn thì bỏ, coi như không đọc được. */
export const WEALTH_READ_MAX_BODY = 512 * 1024;
export const WEALTH_READ_TIMEOUT_MS = 5000;
/** Ưu tiên thấp như rewards (DEC-398): chỉ lấy token khi bucket IP chung còn trên 50%, không giành phần của lệnh. */
export const WEALTH_IDLE_RESERVE = 0.5;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const FUND_ID = /^[A-Za-z0-9._-]{1,64}$/;
const PLAN_INDEX = /^\d{1,20}$/;

export type WealthReadFailureReason =
  /** Hạn mức của chính DeskLabs (bucket Redis) không cho gọi lúc này; chưa gửi gì. */
  | "budget"
  /** Tham số không đúng dạng: không gửi gì. */
  | "invalid_param"
  | "network"
  | "timeout"
  | "http_status"
  | "too_large"
  | "invalid_json"
  /** Envelope `code` khác 0 (`error`: thông điệp của SoDEX, không hiển thị nguyên văn). */
  | "business"
  | "schema";

/** Gateway lỗi / trả sai dạng → `not_provided` (không ném), người gọi hiện "Not provided". */
export type WealthReadResult<T> =
  | { kind: "ok"; data: T }
  | {
      kind: "not_provided";
      reason: WealthReadFailureReason;
      status?: number;
      /** Chỉ với `budget`: bao lâu nữa bucket đủ token cho một lời gọi (ms). */
      retryAfterMs?: number;
    };

export type WealthFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface WealthReadClientOptions {
  /** Origin gateway (https). Trống / thiếu = mainnet. */
  gateway?: string | undefined;
  rateLimit: RateLimitStore;
  /** Khoá IP egress (`rl:sodex:ip:<egress>`), cùng bucket với REST giao dịch vì SoDEX đếm chung theo IP. */
  egressKey: string;
  /** Bucket IP chung (`ipBucket(SODEX_REST_WEIGHT_PER_MIN)`). Client áp dự trữ `WEALTH_IDLE_RESERVE`. */
  ipBucket: BucketSpec;
  /** Trần riêng của Wealth (weight / phút, `rl:sodex:wealth:<egress>`). Thiếu = không có trần riêng. */
  maxWeightPerMinute?: number | undefined;
  fetch?: WealthFetch;
  timeoutMs?: number;
}

export interface WealthPnlHistoryQuery {
  interval?: (typeof WEALTH_PNL_HISTORY_INTERVALS)[number];
  range?: (typeof WEALTH_PNL_HISTORY_RANGES)[number];
}

interface Params {
  a?: string;
  f?: string;
  p?: string;
}

function gatewayOrigin(raw: string | undefined): string {
  const value = raw === undefined || raw.trim() === "" ? SODEX_WEALTH_DEFAULT_ORIGIN : raw.trim();
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Wealth gateway must use https");
  return url.origin;
}

export class WealthReadClient {
  readonly #origin: string;
  readonly #rateLimit: RateLimitStore;
  readonly #egressKey: string;
  readonly #ipBucket: BucketSpec;
  readonly #capBucket: BucketSpec | null;
  readonly #fetch: WealthFetch;
  readonly #timeoutMs: number;

  constructor(options: WealthReadClientOptions) {
    this.#origin = gatewayOrigin(options.gateway);
    this.#rateLimit = options.rateLimit;
    this.#egressKey = options.egressKey;
    this.#ipBucket = {
      ...options.ipBucket,
      reserve: Math.floor(options.ipBucket.capacity * WEALTH_IDLE_RESERVE),
    };
    const cap = options.maxWeightPerMinute;
    this.#capBucket = cap === undefined ? null : { capacity: cap, refill: cap, intervalMs: 60_000 };
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? WEALTH_READ_TIMEOUT_MS;
  }

  getFunds(): Promise<WealthReadResult<z.output<typeof wealthFundsSchema>>> {
    return this.#read("funds", {}, {}, wealthFundsSchema);
  }

  getFund(fundId: string): Promise<WealthReadResult<z.output<typeof wealthFundInfoSchema>>> {
    return this.#read("fund", { f: fundId }, {}, wealthFundInfoSchema);
  }

  getTradingStatus(
    fundId: string,
  ): Promise<WealthReadResult<z.output<typeof wealthTradingStatusSchema>>> {
    return this.#read("tradingStatus", { f: fundId }, {}, wealthTradingStatusSchema);
  }

  getPositions(address: string): Promise<WealthReadResult<z.output<typeof wealthPositionsSchema>>> {
    return this.#read("positions", { a: address }, {}, wealthPositionsSchema);
  }

  getPnl(address: string): Promise<WealthReadResult<z.output<typeof wealthPnlSchema>>> {
    return this.#read("pnl", { a: address }, {}, wealthPnlSchema);
  }

  getInFlight(address: string): Promise<WealthReadResult<z.output<typeof wealthInFlightSchema>>> {
    return this.#read("inFlight", { a: address }, {}, wealthInFlightSchema);
  }

  getFundDetails(
    address: string,
  ): Promise<WealthReadResult<z.output<typeof wealthFundDetailsSchema>>> {
    return this.#read("fundDetails", { a: address }, {}, wealthFundDetailsSchema);
  }

  /** Ví không có kế hoạch có thể nhận `code -1` (thấy ngày 2026-11-28) → `not_provided`. */
  getRecurringBuys(
    address: string,
    status: "active" | "history" = "active",
  ): Promise<WealthReadResult<z.output<typeof wealthRecurringBuysSchema>>> {
    return this.#read("recurringBuys", { a: address }, { status }, wealthRecurringBuysSchema);
  }

  getRecurringBuyExecutions(
    address: string,
    planIndex: string,
    dcaAddress?: string,
  ): Promise<WealthReadResult<z.output<typeof wealthRecurringExecutionsSchema>>> {
    if (dcaAddress !== undefined && !ADDRESS.test(dcaAddress))
      return Promise.resolve({ kind: "not_provided", reason: "invalid_param" });
    return this.#read(
      "recurringBuyExecutions",
      { a: address, p: planIndex },
      dcaAddress === undefined ? {} : { dcaAddress },
      wealthRecurringExecutionsSchema,
    );
  }

  getPnlHistory(
    address: string,
    query: WealthPnlHistoryQuery = {},
  ): Promise<WealthReadResult<z.output<typeof wealthPnlHistorySchema>>> {
    if (
      (query.interval !== undefined && !WEALTH_PNL_HISTORY_INTERVALS.includes(query.interval)) ||
      (query.range !== undefined && !WEALTH_PNL_HISTORY_RANGES.includes(query.range))
    )
      return Promise.resolve({ kind: "not_provided", reason: "invalid_param" });
    return this.#read(
      "pnlHistory",
      { a: address },
      { interval: query.interval, range: query.range },
      wealthPnlHistorySchema,
    );
  }

  getTvl(address: string): Promise<WealthReadResult<z.output<typeof wealthTvlSchema>>> {
    return this.#read("tvl", { a: address }, {}, wealthTvlSchema);
  }

  /** null = lấy được token; số = chờ bao lâu (ms) mới đủ. */
  async #take(): Promise<number | null> {
    if (this.#capBucket !== null) {
      const cap = await this.#rateLimit.take(
        `sodex:wealth:${this.#egressKey}`,
        this.#capBucket,
        WEALTH_READ_WEIGHT,
      );
      if (!cap.allowed) return Math.max(0, cap.retryAfterMs);
    }
    const ip = await this.#rateLimit.take(
      `sodex:ip:${this.#egressKey}`,
      this.#ipBucket,
      WEALTH_READ_WEIGHT,
    );
    return ip.allowed ? null : Math.max(0, ip.retryAfterMs);
  }

  #path(endpoint: WealthReadEndpoint, params: Params): string | null {
    let path: string = WEALTH_READ_ENDPOINTS[endpoint];
    if (path.includes("{a}")) {
      if (params.a === undefined || !ADDRESS.test(params.a)) return null;
      path = path.replace("{a}", params.a.toLowerCase());
    }
    if (path.includes("{f}")) {
      if (params.f === undefined || !FUND_ID.test(params.f)) return null;
      path = path.replace("{f}", params.f);
    }
    if (path.includes("{p}")) {
      if (params.p === undefined || !PLAN_INDEX.test(params.p)) return null;
      path = path.replace("{p}", params.p);
    }
    return path;
  }

  async #read<T extends z.ZodType>(
    endpoint: WealthReadEndpoint,
    params: Params,
    query: Readonly<Record<string, string | undefined>>,
    schema: T,
  ): Promise<WealthReadResult<z.output<T>>> {
    const path = this.#path(endpoint, params);
    if (path === null) return { kind: "not_provided", reason: "invalid_param" };
    const wait = await this.#take();
    if (wait !== null) return { kind: "not_provided", reason: "budget", retryAfterMs: wait };

    const url = new URL(`/api/v1/wealth/${path}`, this.#origin);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);

    let response: Response;
    try {
      response = await this.#fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const timeout =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return { kind: "not_provided", reason: timeout ? "timeout" : "network" };
    }

    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > WEALTH_READ_MAX_BODY) return { kind: "not_provided", reason: "too_large" };
    let text: string;
    try {
      text = await response.text();
    } catch {
      return { kind: "not_provided", reason: "network" };
    }
    if (text.length > WEALTH_READ_MAX_BODY) return { kind: "not_provided", reason: "too_large" };
    if (!response.ok)
      return { kind: "not_provided", reason: "http_status", status: response.status };

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { kind: "not_provided", reason: "invalid_json" };
    }
    const envelope = wealthEnvelopeSchema.safeParse(json);
    if (!envelope.success) return { kind: "not_provided", reason: "schema" };
    if (envelope.data.code !== 0) return { kind: "not_provided", reason: "business" };
    const data = schema.safeParse(envelope.data.data);
    if (!data.success) return { kind: "not_provided", reason: "schema" };
    return { kind: "ok", data: data.data };
  }
}
