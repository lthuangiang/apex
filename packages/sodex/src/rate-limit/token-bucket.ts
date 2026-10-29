// Token bucket thuần, không I/O. Store (bộ nhớ hoặc Redis) giữ state theo từng khoá
// (API key, IP egress, địa chỉ ví) — docs/ARCHITECTURE.md mục 3.3.6.

export interface BucketSpec {
  /** Số token tối đa. */
  capacity: number;
  /** Số token nạp lại mỗi `intervalMs`. */
  refill: number;
  intervalMs: number;
  /**
   * Số token phải còn lại sau khi lấy (mặc định 0). Job nền dùng mức dự trữ để không rút cạn bucket chung,
   * chừa phần cho request tương tác của người dùng.
   */
  reserve?: number;
}

export interface BucketState {
  tokens: number;
  updatedAt: number;
}

export interface TakeResult {
  allowed: boolean;
  state: BucketState;
  /** Thời gian chờ tới khi đủ token, 0 nếu được phép ngay. */
  retryAfterMs: number;
}

export function initialBucket(spec: BucketSpec, now: number): BucketState {
  return { tokens: spec.capacity, updatedAt: now };
}

export function takeTokens(
  spec: BucketSpec,
  state: BucketState,
  cost: number,
  now: number,
): TakeResult {
  if (!Number.isInteger(cost) || cost <= 0) {
    throw new RangeError("Cost must be a positive integer");
  }
  if (cost > spec.capacity) {
    throw new RangeError("Cost exceeds bucket capacity");
  }
  const elapsed = Math.max(0, now - state.updatedAt);
  const ratePerMs = spec.refill / spec.intervalMs;
  const tokens = Math.min(spec.capacity, state.tokens + elapsed * ratePerMs);

  const need = cost + (spec.reserve ?? 0);
  if (tokens >= need) {
    return { allowed: true, state: { tokens: tokens - cost, updatedAt: now }, retryAfterMs: 0 };
  }
  return {
    allowed: false,
    state: { tokens, updatedAt: now },
    retryAfterMs: Math.ceil((need - tokens) / ratePerMs),
  };
}

export interface RateLimitStore {
  take(key: string, spec: BucketSpec, cost: number): Promise<TakeResult>;
}

/** Store trong bộ nhớ của một process. Nhiều replica cần store dùng chung (Redis). */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly #buckets = new Map<string, BucketState>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  take(key: string, spec: BucketSpec, cost: number): Promise<TakeResult> {
    const now = this.#now();
    const state = this.#buckets.get(key) ?? initialBucket(spec, now);
    const result = takeTokens(spec, state, cost, now);
    this.#buckets.set(key, result.state);
    return Promise.resolve(result);
  }
}
