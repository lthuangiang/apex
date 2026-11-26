import { rewardsEnvelopeSchema, rewardsRetryAfterSchema } from "@drift/shared";
import type { z } from "zod";

import { REWARDS_GATEWAY_ORIGIN } from "./gateway";

// Client Rewards API của SoDEX (DEC-397): trình duyệt gọi thẳng gateway, không qua server DeskLabs. Token (JWT) chỉ đi
// trong header Authorization tới đúng origin gateway; không bao giờ nằm trong URL, log, thông báo lỗi hay analytics.
// Envelope `{ code, msg | message, data }`: thành công khi HTTP 2xx và `code === 0`. HTTP 401 → `expired` (người gọi
// xoá token). HTTP 429 → `rate_limited` với `data.retryAfter` (giây); mọi request sau đó dừng tới hết hạn, không gửi.

export type RewardsErrorKind =
  "expired" | "rate_limited" | "business" | "http" | "network" | "schema";

export class RewardsError extends Error {
  constructor(
    readonly kind: RewardsErrorKind,
    readonly status: number,
    /** Câu của SoDEX (`msg` / `message`) khi lỗi nghiệp vụ; UI hiện nguyên trong ngoặc kép. */
    readonly sodexMessage: string | null = null,
    /** Số giây phải chờ khi `rate_limited`; null khi SoDEX không trả. */
    readonly retryAfterSec: number | null = null,
    /** Đường dẫn trường lệch schema (không có giá trị). */
    readonly issues: readonly string[] = [],
  ) {
    // Chỉ loại lỗi: message không bao giờ chứa token, body hay URL đầy đủ.
    super(`REWARDS_${kind.toUpperCase()}`);
    this.name = "RewardsError";
  }
}

/** Hết hạn tạm dừng do 429 (ms epoch), theo origin gateway. */
const pausedUntil = new Map<string, number>();

export function rewardsPausedUntil(origin = REWARDS_GATEWAY_ORIGIN): number | null {
  return pausedUntil.get(origin) ?? null;
}

/** Chỉ cho test. */
export function resetRewardsRateLimit(): void {
  pausedUntil.clear();
}

export interface RewardsRequest<T extends z.ZodType> {
  method?: "GET" | "POST";
  /** Đường dẫn sau `/api/v1/`, ví dụ `lottery/boxes`. */
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  /** JWT của ví; chỉ endpoint cần ví mới truyền. */
  token?: string | null;
  schema: T;
  /** Cybereator trả object trực tiếp, không envelope. */
  envelope?: boolean;
  origin?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
}

const PATH_RE = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/i;

/** URL tới gateway; ném nếu đường dẫn lạ hoặc origin không phải gateway (token chỉ được rời trình duyệt tới đó). */
export function rewardsUrl(
  path: string,
  query: RewardsRequest<z.ZodType>["query"] = {},
  origin = REWARDS_GATEWAY_ORIGIN,
): URL {
  if (!PATH_RE.test(path)) throw new Error("Invalid rewards path");
  const url = new URL(`/api/v1/${path}`, origin);
  if (url.origin !== origin) throw new Error("Rewards request outside the gateway");
  if (typeof window !== "undefined" && url.origin === window.location.origin)
    throw new Error("Rewards requests never go to the DeskLabs origin");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  return url;
}

function retryAfterOf(json: unknown, header: string | null): number | null {
  const parsed = rewardsRetryAfterSchema.safeParse(json);
  if (parsed.success) return parsed.data.data.retryAfter;
  const fromHeader = header === null ? Number.NaN : Number(header);
  return Number.isFinite(fromHeader) && fromHeader >= 0 ? fromHeader : null;
}

/** Thời gian dừng khi 429 không kèm `retryAfter`: chỉ để dừng poll, không hiện thành số trên UI. */
export const RATE_LIMIT_FALLBACK_SEC = 60;

export async function rewardsRequest<T extends z.ZodType>(
  req: RewardsRequest<T>,
): Promise<z.output<T>> {
  const origin = req.origin ?? REWARDS_GATEWAY_ORIGIN;
  const now = req.now ?? Date.now;
  const until = pausedUntil.get(origin);
  if (until !== undefined) {
    if (now() < until)
      throw new RewardsError("rate_limited", 429, null, Math.ceil((until - now()) / 1000));
    pausedUntil.delete(origin);
  }
  const url = rewardsUrl(req.path, req.query, origin);
  const method = req.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (req.body !== undefined) headers["Content-Type"] = "application/json";
  if (req.token != null && req.token !== "") headers.Authorization = `Bearer ${req.token}`;

  let response: Response;
  try {
    response = await (req.fetchImpl ?? fetch)(url, {
      method,
      headers,
      // Không cookie (gateway đặt cookie Cloudflare), không referrer, không cache.
      credentials: "omit",
      mode: "cors",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
      ...(req.signal === undefined ? {} : { signal: req.signal }),
    });
  } catch {
    throw new RewardsError("network", 0);
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.status === 401) throw new RewardsError("expired", 401);
  if (response.status === 429) {
    const retryAfter = retryAfterOf(json, response.headers.get("Retry-After"));
    pausedUntil.set(origin, now() + (retryAfter ?? RATE_LIMIT_FALLBACK_SEC) * 1000);
    throw new RewardsError("rate_limited", 429, null, retryAfter);
  }
  if (!response.ok) throw new RewardsError("http", response.status);

  let data: unknown = json;
  if (req.envelope !== false) {
    const env = rewardsEnvelopeSchema.safeParse(json);
    if (!env.success) throw new RewardsError("schema", response.status, null, null, ["(envelope)"]);
    if (env.data.code !== 0) {
      const said = env.data.msg ?? env.data.message ?? "";
      throw new RewardsError("business", response.status, said === "" ? null : said);
    }
    data = env.data.data;
  }
  const parsed = req.schema.safeParse(data);
  if (!parsed.success)
    throw new RewardsError(
      "schema",
      response.status,
      null,
      null,
      parsed.error.issues.map((i) => i.path.join(".") || "(root)"),
    );
  return parsed.data;
}
