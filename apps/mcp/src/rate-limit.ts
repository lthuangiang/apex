import { MCP_RATE_LIMITS } from "@drift/shared";
import type { Redis } from "ioredis";

// Giới hạn gọi MCP (PM chốt): 60 lần / phút / token (team 120), 5.000 lần / ngày / user. Đếm mọi request MCP đã qua
// xác thực, cửa sổ cố định trong Redis.

export interface Counter {
  hit(key: string, windowMs: number): Promise<number>;
}

export function redisCounter(redis: Pick<Redis, "multi">): Counter {
  return {
    async hit(key, windowMs) {
      const res = await redis.multi().incr(key).pexpire(key, windowMs, "NX").exec();
      return Number(res?.[0]?.[1] ?? 0);
    },
  };
}

export function memoryCounter(now: () => number = () => Date.now()): Counter {
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
      return Promise.resolve(next.count);
    },
  };
}

/** null = được phép; còn lại là lý do bị chặn. */
export async function checkLimits(
  counter: Counter,
  t: { tokenId: string; userId: string },
  team: boolean,
): Promise<"per_minute" | "per_day" | null> {
  const perMinute = team
    ? MCP_RATE_LIMITS.teamPerTokenPerMinute
    : MCP_RATE_LIMITS.perTokenPerMinute;
  if ((await counter.hit(`mcp:rl:tok:${t.tokenId}`, 60_000)) > perMinute) return "per_minute";
  if ((await counter.hit(`mcp:rl:user:${t.userId}`, 86_400_000)) > MCP_RATE_LIMITS.perUserPerDay)
    return "per_day";
  return null;
}
