import { AppError, decimalStringSchema, ErrorCode } from "@drift/shared";
import type { Address } from "viem";
import { z } from "zod";

import type { SodexConfig } from "../config";
import type { RateLimitStore } from "../rate-limit/token-bucket";
import { IP_REST_BUCKET, ipBucket, klineWeight, RestWeight } from "../rate-limit/weights";
import { TtlCache } from "../ttl-cache";

import {
  klineSchema,
  markPriceSchema,
  perpsAccountStateSchema,
  positionSchema,
  restOrderSchema,
  userFundingSchema,
  userTradeSchema,
  type Kline,
  type KlineInterval,
  type MarkPrice,
  type PerpsAccountState,
  type Position,
  type RestOrder,
  type UserFunding,
  type UserTrade,
} from "./history-schemas";
import { parseSodexJson } from "./json";
import {
  apiKeysSchema,
  builderApprovalsSchema,
  errorEnvelopeSchema,
  perpsSymbolSchema,
  spotSymbolSchema,
  subaccountsSchema,
  successEnvelope,
  type ApiKeys,
  type BuilderApprovals,
  type PerpsSymbol,
  type SpotSymbol,
  type Subaccounts,
} from "./schemas";

/** Timeout mặc định cho mọi lời gọi ra ngoài (CODING_STANDARDS C5). */
export const DEFAULT_TIMEOUT_MS = 5000;
/** Market info đổi ít; cache có hạn, không hard-code (mục 12). */
export const MARKET_INFO_TTL_MS = 60_000;

function schemaMismatch(path: string, error: z.ZodError): AppError {
  // Chỉ ghi đường dẫn field, không ghi giá trị (có thể chứa dữ liệu account).
  return new AppError(ErrorCode.sodexUnavailable, "SoDEX response did not match schema", {
    path,
    issues: error.issues.map((issue) => issue.path.join(".")),
  });
}

export type Engine = "spot" | "perps";

export interface HistoryQuery {
  accountID?: bigint;
  symbol?: string;
  startTime?: number;
  endTime?: number;
}

function historyQuery(q: HistoryQuery & { limit?: number }): string {
  const params = new URLSearchParams();
  if (q.accountID !== undefined) params.set("accountID", q.accountID.toString());
  if (q.symbol !== undefined) params.set("symbol", q.symbol);
  if (q.startTime !== undefined) params.set("startTime", String(q.startTime));
  if (q.endTime !== undefined) params.set("endTime", String(q.endTime));
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  return params.toString();
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Phần bucket IP chừa cho request tương tác. */
export const BACKGROUND_RESERVE = 0.3;

export interface SodexRestOptions {
  config: Pick<SodexConfig, "restUrl" | "restWeightPerMinute">;
  rateLimit: RateLimitStore;
  /** Khoá bucket của IP egress đang dùng (mỗi worker một IP, ARCHITECTURE.md mục 3.3.6). */
  egressKey: string;
  /**
   * `background`: job nền (backfill, thống kê, import, backtest, reco) — chỉ lấy token khi bucket còn trên
   * mức dự trữ 30%, để không chặn request của người dùng (api) và lệnh của engine. Mặc định `interactive`.
   */
  priority?: "interactive" | "background";
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Client REST chỉ đọc của SoDEX. Lệnh ghi (đặt/huỷ lệnh, key, approval) không retry ở đây
 * (CODING_STANDARDS C10) và đi qua module riêng khi có `signer`.
 */
export class SodexRestClient {
  readonly #base: string;
  readonly #rateLimit: RateLimitStore;
  readonly #egressKey: string;
  readonly #bucket: typeof IP_REST_BUCKET;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #spotSymbols = new TtlCache<SpotSymbol[]>(MARKET_INFO_TTL_MS);
  readonly #perpsSymbols = new TtlCache<PerpsSymbol[]>(MARKET_INFO_TTL_MS);

  constructor(options: SodexRestOptions) {
    this.#base = `${options.config.restUrl}/api/v1`;
    this.#rateLimit = options.rateLimit;
    this.#egressKey = options.egressKey;
    const bucket = ipBucket(options.config.restWeightPerMinute);
    this.#bucket =
      options.priority === "background"
        ? { ...bucket, reserve: Math.floor(bucket.capacity * BACKGROUND_RESERVE) }
        : bucket;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  getSubaccounts(address: Address): Promise<Subaccounts> {
    return this.#get(`/user/${address}/subaccounts`, RestWeight.publicUserRead, subaccountsSchema);
  }

  getBuilderApprovals(address: Address): Promise<BuilderApprovals> {
    return this.#get(
      `/user/${address}/builders`,
      RestWeight.publicUserRead,
      builderApprovalsSchema,
    );
  }

  getApiKeys(address: Address, accountID: bigint): Promise<ApiKeys> {
    const query = new URLSearchParams({ accountID: accountID.toString() });
    return this.#get(
      `/user/${address}/api-keys?${query.toString()}`,
      RestWeight.accountRead,
      apiKeysSchema,
    );
  }

  /** Lịch sử khớp lệnh của account (tối đa 1000 dòng mỗi lần; phân trang bằng `endTime`). */
  getTrades(
    engine: Engine,
    address: Address,
    q: HistoryQuery & { limit?: number },
  ): Promise<UserTrade[]> {
    return this.#get(
      `/${engine}/accounts/${address}/trades?${historyQuery(q)}`,
      RestWeight.default,
      z.array(userTradeSchema),
    );
  }

  /** Lệnh đang mở của account. */
  async getOpenOrders(engine: Engine, address: Address, q: HistoryQuery): Promise<RestOrder[]> {
    const data = await this.#get(
      `/${engine}/accounts/${address}/orders?${historyQuery(q)}`,
      RestWeight.accountRead,
      z.object({ orders: z.array(restOrderSchema).nullable() }),
    );
    return data.orders ?? [];
  }

  /** Lịch sử lệnh (tối đa 500 mỗi lần), dùng để đối soát lệnh `unknown` theo clOrdID. */
  getOrderHistory(
    engine: Engine,
    address: Address,
    q: HistoryQuery & { limit?: number },
  ): Promise<RestOrder[]> {
    return this.#get(
      `/${engine}/accounts/${address}/orders/history?${historyQuery(q)}`,
      RestWeight.default,
      z.array(restOrderSchema),
    );
  }

  /** Position Perps đã đóng (tối đa 500 mỗi lần). */
  getPositionsHistory(address: Address, q: HistoryQuery & { limit?: number }): Promise<Position[]> {
    return this.#get(
      `/perps/accounts/${address}/positions/history?${historyQuery(q)}`,
      RestWeight.default,
      z.array(positionSchema),
    );
  }

  /** Funding đã trả / nhận của account (tối đa 1000 mỗi lần). */
  getFundings(address: Address, q: HistoryQuery & { limit?: number }): Promise<UserFunding[]> {
    return this.#get(
      `/perps/accounts/${address}/fundings?${historyQuery(q)}`,
      RestWeight.default,
      z.array(userFundingSchema),
    );
  }

  /** Kline, mới nhất trước. Perps tối đa 1000 dòng, Spot 1500. */
  getKlines(
    engine: Engine,
    symbol: string,
    q: { interval: KlineInterval; startTime?: number; endTime?: number; limit: number },
  ): Promise<Kline[]> {
    const params = new URLSearchParams({ interval: q.interval, limit: String(q.limit) });
    if (q.startTime !== undefined) params.set("startTime", String(q.startTime));
    if (q.endTime !== undefined) params.set("endTime", String(q.endTime));
    return this.#get(
      `/${engine}/markets/${encodeURIComponent(symbol)}/klines?${params.toString()}`,
      klineWeight(q.limit),
      z.array(klineSchema),
    );
  }

  /** Số dư Spot: tổng và phần đang khoá theo coin (đối chiếu response mainnet ngày 2026-10-27). */
  async getSpotBalances(
    address: Address,
    accountID?: bigint,
  ): Promise<{ coin: string; total: string; locked: string }[]> {
    const q = accountID === undefined ? "" : `?accountID=${accountID.toString()}`;
    const data = await this.#get(
      `/spot/accounts/${address}/balances${q}`,
      RestWeight.accountRead,
      z.object({
        balances: z
          .array(
            z.object({ coin: z.string(), total: decimalStringSchema, locked: decimalStringSchema }),
          )
          .nullable(),
      }),
    );
    return data.balances ?? [];
  }

  /** Perps account state: account value, margin và vị thế đang mở (giá thanh lý lấy từ SoDEX). */
  getPerpsAccountState(address: Address): Promise<PerpsAccountState> {
    return this.#get(
      `/perps/accounts/${address}/state`,
      RestWeight.accountRead,
      perpsAccountStateSchema,
    );
  }

  /** `av` của Perps account state = cross account value (USDC). */
  async getPerpsAccountValue(address: Address): Promise<string> {
    const state = await this.#get(
      `/perps/accounts/${address}/state`,
      RestWeight.accountRead,
      z.object({ av: decimalStringSchema }),
    );
    return state.av;
  }

  getMarkPrices(): Promise<MarkPrice[]> {
    return this.#get("/perps/markets/mark-prices", RestWeight.default, z.array(markPriceSchema));
  }

  getSpotSymbols(): Promise<SpotSymbol[]> {
    return this.#spotSymbols.get("all", () =>
      this.#get("/spot/markets/symbols", RestWeight.marketInfo, z.array(spotSymbolSchema)),
    );
  }

  getPerpsSymbols(): Promise<PerpsSymbol[]> {
    return this.#perpsSymbols.get("all", () =>
      this.#get("/perps/markets/symbols", RestWeight.marketInfo, z.array(perpsSymbolSchema)),
    );
  }

  async #get<T extends z.ZodType>(path: string, weight: number, schema: T): Promise<z.output<T>> {
    const limit = await this.#rateLimit.take(`sodex:ip:${this.#egressKey}`, this.#bucket, weight);
    if (!limit.allowed) {
      throw new AppError(ErrorCode.rateLimited, "SoDEX rate limit reached", {
        retryAfterMs: limit.retryAfterMs,
      });
    }

    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new AppError(ErrorCode.sodexTimeout, "SoDEX request timed out", { path });
      }
      throw new AppError(ErrorCode.sodexUnavailable, "SoDEX request failed", { path });
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = parseSodexJson(text);
    } catch {
      throw new AppError(ErrorCode.sodexUnavailable, "SoDEX returned invalid JSON", {
        path,
        status: response.status,
      });
    }

    const failure = errorEnvelopeSchema.safeParse(body);
    if (failure.success) {
      throw new AppError(ErrorCode.sodexUnavailable, "SoDEX returned an error", {
        path,
        status: response.status,
        sodexCode: failure.data.code,
        sodexError: failure.data.error,
      });
    }
    if (!response.ok) {
      throw new AppError(ErrorCode.sodexUnavailable, "SoDEX returned an HTTP error", {
        path,
        status: response.status,
      });
    }

    const envelope = successEnvelope(z.unknown()).safeParse(body);
    if (!envelope.success) {
      throw schemaMismatch(path, envelope.error);
    }
    const parsed = schema.safeParse(envelope.data.data);
    if (!parsed.success) {
      throw schemaMismatch(path, parsed.error);
    }
    return parsed.data;
  }
}
