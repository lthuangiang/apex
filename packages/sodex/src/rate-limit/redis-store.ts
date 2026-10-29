import { z } from "zod";

import type { BucketSpec, RateLimitStore, TakeResult } from "./token-bucket";

// Token bucket dùng chung giữa các replica (ARCHITECTURE.md 3.3.6). Một script Lua đọc, nạp lại và
// trừ token trong một bước nguyên tử. Thời gian lấy từ `TIME` của Redis để mọi replica dùng chung
// một đồng hồ. Cùng công thức với `takeTokens`.

/** Bề mặt tối thiểu; `ioredis` (`redis.eval(script, numKeys, ...args)`) khớp interface này. */
export interface RedisEval {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// KEYS[1] = bucket; ARGV = capacity, refill, intervalMs, cost, reserve (token phải còn lại sau khi lấy).
// Trả {allowed (0/1), tokens * 1000 (số nguyên), retryAfterMs}.
export const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local interval = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local reserve = tonumber(ARGV[5]) or 0
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'updatedAt')
local tokens = tonumber(state[1])
local updated = tonumber(state[2])
if tokens == nil or updated == nil then
  tokens = capacity
  updated = now
end
local rate = refill / interval
local elapsed = math.max(0, now - updated)
tokens = math.min(capacity, tokens + elapsed * rate)
local allowed = 0
local retry = 0
if tokens >= cost + reserve then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost + reserve - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'updatedAt', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate) + 1000)
return {allowed, math.floor(tokens * 1000), retry}
`;

const resultSchema = z.tuple([
  z.union([z.literal(0), z.literal(1)]),
  z.number().int(),
  z.number().int(),
]);

export class RedisRateLimitStore implements RateLimitStore {
  readonly #redis: RedisEval;
  readonly #prefix: string;

  constructor(redis: RedisEval, prefix = "rl:") {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  async take(key: string, spec: BucketSpec, cost: number): Promise<TakeResult> {
    if (!Number.isInteger(cost) || cost <= 0) {
      throw new RangeError("Cost must be a positive integer");
    }
    if (cost > spec.capacity) {
      throw new RangeError("Cost exceeds bucket capacity");
    }
    const raw = await this.#redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      `${this.#prefix}${key}`,
      spec.capacity,
      spec.refill,
      spec.intervalMs,
      cost,
      spec.reserve ?? 0,
    );
    const [allowed, milliTokens, retryAfterMs] = resultSchema.parse(raw);
    return {
      allowed: allowed === 1,
      // `updatedAt` là đồng hồ của Redis; chỉ để tham khảo.
      state: { tokens: milliTokens / 1000, updatedAt: Date.now() },
      retryAfterMs,
    };
  }
}
