import type { BucketSpec, RateLimitStore } from "@drift/sodex";
import type { z } from "zod";

import {
  hlClearinghouseSchema,
  hlFillsSchema,
  hlFundingSchema,
  hlLeaderboardRowSchema,
  hlRoleSchema,
  type HlClearinghouse,
  type HlFill,
  type HlLeaderboardRow,
} from "./schemas";

// Client REST chỉ đọc của Hyperliquid (docs/COPY_TRADING_DATA.md). Mọi request `info` đi qua một token bucket chung
// theo IP egress (1.200 weight / phút), lưu trong Redis để marketdata và scheduler cùng một ngân sách (DEC-163 mục 10).

export const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
/** Không có trong tài liệu chính thức (DEC-163 mục 2): lỗi thì người gọi giữ danh sách cũ. */
export const HL_LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";

/** Weight theo tài liệu "Rate limits and user limits" (đọc 2026-11-11). */
export const HL_WEIGHT = {
  light: 2, // clearinghouseState, allMids, l2Book
  standard: 20, // userFills, userFillsByTime, userFunding…
  role: 60, // userRole
  /** Cộng thêm 1 cho mỗi chừng này dòng trả về (userFills, userFillsByTime, userFunding). */
  itemsPerExtraWeight: 20,
} as const;

/** 1.200 weight / phút / IP. */
export const HL_BUCKET: BucketSpec = { capacity: 1200, refill: 1200, intervalMs: 60_000 };
/** Job nền (T2) chừa phần này cho T0 / T1 và DEC-92. */
export const HL_BACKGROUND_RESERVE = 500;

export const HL_PAGE = { fills: 2000, funding: 500 } as const;

export type HlPriority = "realtime" | "background";

export class HyperliquidError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "HyperliquidError";
  }
}

export interface HyperliquidClientOptions {
  limiter: RateLimitStore;
  /** Khoá bucket theo IP egress, ví dụ `hl:ip:default`. */
  bucketKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HyperliquidClient {
  readonly #o: Required<Omit<HyperliquidClientOptions, "fetch">> & { fetch: typeof fetch };

  constructor(options: HyperliquidClientOptions) {
    this.#o = {
      limiter: options.limiter,
      bucketKey: options.bucketKey,
      fetch: options.fetch ?? fetch,
      timeoutMs: options.timeoutMs ?? 15_000,
      sleep: options.sleep ?? wait,
    };
  }

  /** Lấy `cost` token, chờ tới khi đủ (job nền chừa `HL_BACKGROUND_RESERVE`). */
  async #charge(cost: number, priority: HlPriority): Promise<void> {
    const spec: BucketSpec =
      priority === "background" ? { ...HL_BUCKET, reserve: HL_BACKGROUND_RESERVE } : HL_BUCKET;
    let left = cost;
    while (left > 0) {
      // Một lần lấy không quá dung lượng bucket (trừ phần dự trữ).
      const step = Math.min(left, spec.capacity - (spec.reserve ?? 0));
      const r = await this.#o.limiter.take(this.#o.bucketKey, spec, step);
      if (r.allowed) left -= step;
      else await this.#o.sleep(r.retryAfterMs);
    }
  }

  async #info<T>(
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
    weight: number,
    priority: HlPriority,
    perItem = false,
  ): Promise<T> {
    await this.#charge(weight, priority);
    let res: Response;
    try {
      res = await this.#o.fetch(HL_INFO_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#o.timeoutMs),
      });
    } catch {
      throw new HyperliquidError(`Hyperliquid ${String(body.type)} request failed`, null);
    }
    if (!res.ok)
      throw new HyperliquidError(
        `Hyperliquid ${String(body.type)} returned ${String(res.status)}`,
        res.status,
      );
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success)
      throw new HyperliquidError(
        `Hyperliquid ${String(body.type)} did not match schema`,
        res.status,
      );
    if (perItem && Array.isArray(parsed.data)) {
      const extra = Math.floor(parsed.data.length / HL_WEIGHT.itemsPerExtraWeight);
      if (extra > 0) await this.#charge(extra, priority);
    }
    return parsed.data;
  }

  /** Một trang fill từ `startTime` (cũ → mới, tối đa 2.000). */
  userFillsByTime(user: string, startTime: number, priority: HlPriority): Promise<HlFill[]> {
    return this.#info(
      { type: "userFillsByTime", user, startTime, aggregateByTime: false },
      hlFillsSchema,
      HL_WEIGHT.standard,
      priority,
      true,
    );
  }

  /**
   * Fill từ `startTime`, phân trang tới khi hết hoặc chạm `cap` (Hyperliquid chỉ giữ ~10.000 fill gần nhất).
   * `capped` = dừng vì trần, lịch sử có thể thiếu.
   */
  async fillsSince(
    user: string,
    startTime: number,
    cap: number,
    priority: HlPriority,
    /**
     * Dừng sớm (DEC-171): trang đầu đầy mà gói gọn trong chừng này ms thì ví sẽ chạm `cap` (gần như
     * chắc bị ẩn vì giữ lệnh quá ngắn). Trả `capped: true` ngay để không tốn weight đọc thêm trang.
     */
    earlyStopSpanMs?: number,
  ): Promise<{ fills: HlFill[]; capped: boolean }> {
    const out: HlFill[] = [];
    let start = startTime;
    for (;;) {
      const page = await this.userFillsByTime(user, start, priority);
      out.push(...page);
      if (out.length >= cap) return { fills: out.slice(0, cap), capped: true };
      const last = page.at(-1);
      if (page.length < HL_PAGE.fills || last === undefined) return { fills: out, capped: false };
      const first = page[0];
      if (
        earlyStopSpanMs !== undefined &&
        out.length === page.length &&
        first !== undefined &&
        last.time - first.time < earlyStopSpanMs
      )
        return { fills: out, capped: true };
      start = last.time + 1;
    }
  }

  /** Funding từ `startTime`, phân trang (500 dòng / trang). */
  async fundingSince(
    user: string,
    startTime: number,
    priority: HlPriority,
  ): Promise<{ coin: string; time: number; usdc: string }[]> {
    const out: { coin: string; time: number; usdc: string }[] = [];
    let start = startTime;
    for (let page = 0; page < 40; page += 1) {
      const rows = await this.#info(
        { type: "userFunding", user, startTime: start },
        hlFundingSchema,
        HL_WEIGHT.standard,
        priority,
        true,
      );
      for (const r of rows)
        if (r.delta.type === "funding")
          out.push({ coin: r.delta.coin, time: r.time, usdc: r.delta.usdc });
      const last = rows.at(-1);
      if (rows.length < HL_PAGE.funding || last === undefined) break;
      start = last.time + 1;
    }
    return out;
  }

  /** `dex`: perp HIP-3 (ví dụ `xyz`); bỏ trống = perp gốc của Hyperliquid. */
  clearinghouseState(user: string, priority: HlPriority, dex?: string): Promise<HlClearinghouse> {
    return this.#info(
      dex === undefined
        ? { type: "clearinghouseState", user }
        : { type: "clearinghouseState", user, dex },
      hlClearinghouseSchema,
      HL_WEIGHT.light,
      priority,
    );
  }

  /** `true` khi ví là vault (gồm HLP). Weight 60: người gọi lưu kết quả, không hỏi lại. */
  async isVault(user: string, priority: HlPriority): Promise<boolean> {
    const r = await this.#info({ type: "userRole", user }, hlRoleSchema, HL_WEIGHT.role, priority);
    return r.role === "vault";
  }

  /**
   * Leaderboard công khai (~39 MB). Không tính vào bucket `info` (host khác), gọi tối đa một lần mỗi ngày.
   * Dòng không khớp schema bị bỏ, không làm hỏng cả danh sách.
   */
  async leaderboard(): Promise<HlLeaderboardRow[]> {
    let res: Response;
    try {
      res = await this.#o.fetch(HL_LEADERBOARD_URL, { signal: AbortSignal.timeout(120_000) });
    } catch {
      throw new HyperliquidError("Hyperliquid leaderboard request failed", null);
    }
    if (!res.ok)
      throw new HyperliquidError(
        `Hyperliquid leaderboard returned ${String(res.status)}`,
        res.status,
      );
    const body: unknown = await res.json();
    const rows =
      typeof body === "object" &&
      body !== null &&
      "leaderboardRows" in body &&
      Array.isArray(body.leaderboardRows)
        ? (body.leaderboardRows as unknown[])
        : null;
    if (rows === null)
      throw new HyperliquidError("Hyperliquid leaderboard did not match schema", res.status);
    const out: HlLeaderboardRow[] = [];
    for (const r of rows) {
      const p = hlLeaderboardRowSchema.safeParse(r);
      if (p.success) out.push(p.data);
    }
    return out;
  }
}

const LIGHT_TYPES = new Set(["clearinghouseState", "allMids", "l2Book"]);

/**
 * `fetch` có trừ weight vào bucket chung, cho code gọi `info` trực tiếp (bản đồ thanh lý DEC-92), để ngân sách
 * 1.200 / phút là thật cho mọi tầng. Chạy như job nền (chừa phần dự trữ cho T0 / T1).
 */
export function chargedFetch(
  limiter: RateLimitStore,
  bucketKey: string,
  base: typeof fetch = fetch,
): typeof fetch {
  const spec: BucketSpec = { ...HL_BUCKET, reserve: HL_BACKGROUND_RESERVE };
  return async (input: string | URL | Request, init?: RequestInit) => {
    let type = "";
    if (typeof init?.body === "string") {
      try {
        const b: unknown = JSON.parse(init.body);
        if (typeof b === "object" && b !== null && "type" in b && typeof b.type === "string")
          type = b.type;
      } catch {
        type = "";
      }
    }
    const cost = LIGHT_TYPES.has(type) ? HL_WEIGHT.light : HL_WEIGHT.standard;
    for (;;) {
      const r = await limiter.take(bucketKey, spec, cost);
      if (r.allowed) break;
      await wait(r.retryAfterMs);
    }
    return base(input, init);
  };
}
