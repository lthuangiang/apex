import { AppError, ErrorCode } from "@drift/shared";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";

// Rate limit API (CODING_STANDARDS C12): theo IP và theo user, cửa sổ cố định 1 phút. Vượt → RATE_LIMITED (429)
// kèm thời gian chờ. Giới hạn riêng của đăng nhập (OTP) vẫn nằm ở module auth.

export interface RateLimiter {
  /** Tăng bộ đếm của `key` trong cửa sổ; trả về số lần đã dùng và ms còn lại của cửa sổ. */
  hit(key: string, windowMs: number): Promise<{ count: number; resetMs: number }>;
}

export const API_RATE_LIMITS = { perIp: 600, perUser: 300, windowMs: 60_000 } as const;

export function redisRateLimiter(redis: Pick<Redis, "multi">): RateLimiter {
  return {
    async hit(key, windowMs) {
      const res = await redis.multi().incr(key).pexpire(key, windowMs, "NX").pttl(key).exec();
      const count = Number(res?.[0]?.[1] ?? 0);
      const ttl = Number(res?.[2]?.[1] ?? windowMs);
      return { count, resetMs: ttl > 0 ? ttl : windowMs };
    },
  };
}

export function memoryRateLimiter(now: () => number = () => Date.now()): RateLimiter {
  const m = new Map<string, { count: number; until: number }>();
  return {
    hit(key, windowMs) {
      const t = now();
      const cur = m.get(key);
      const next =
        cur === undefined || cur.until <= t
          ? { count: 1, until: t + windowMs }
          : { count: cur.count + 1, until: cur.until };
      m.set(key, next);
      return Promise.resolve({ count: next.count, resetMs: next.until - t });
    },
  };
}

export function registerRateLimit(
  app: FastifyInstance,
  limiter: RateLimiter,
  limits: { perIp: number; perUser: number; windowMs: number } = API_RATE_LIMITS,
): void {
  app.addHook("preHandler", async (request) => {
    if (request.url === "/healthz") return;
    const window = Math.floor(Date.now() / limits.windowMs);
    const ip = await limiter.hit(`rl:ip:${request.ip}:${String(window)}`, limits.windowMs);
    const user =
      request.auth === null
        ? null
        : await limiter.hit(`rl:user:${request.auth.userId}:${String(window)}`, limits.windowMs);
    const over =
      ip.count > limits.perIp ? ip : user !== null && user.count > limits.perUser ? user : null;
    if (over !== null)
      throw new AppError(ErrorCode.rateLimited, "Too many requests.", {
        retryAfterMs: over.resetMs,
      });
  });
}
