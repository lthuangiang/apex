import { randomUUID } from "node:crypto";

// Lease trên Redis (ARCHITECTURE.md mục 3.3.1): `SET key token NX PX ttl`, gia hạn định kỳ, chỉ người
// giữ token mới gia hạn hoặc trả được (script Lua so token). Dùng cho leader của marketdata/scheduler
// và shard của engine.

export interface LeaseRedis {
  set(key: string, value: string, px: "PX", ttl: number, nx: "NX"): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

export class Lease {
  readonly token = randomUUID();
  #held = false;

  constructor(
    private readonly redis: LeaseRedis,
    readonly key: string,
    private readonly ttlMs = 15_000,
  ) {}

  get held(): boolean {
    return this.#held;
  }

  /** Thử giành hoặc gia hạn; trả về trạng thái giữ lease sau lần gọi này. */
  async tick(): Promise<boolean> {
    if (this.#held) {
      this.#held = (await this.redis.eval(RENEW, 1, this.key, this.token, this.ttlMs)) === 1;
    } else {
      this.#held = (await this.redis.set(this.key, this.token, "PX", this.ttlMs, "NX")) === "OK";
    }
    return this.#held;
  }

  async release(): Promise<void> {
    if (this.#held) await this.redis.eval(RELEASE, 1, this.key, this.token);
    this.#held = false;
  }
}

/**
 * Chạy `onLead` khi giành được lease và `onLose` khi mất; gia hạn mỗi `renewMs`. Trả về hàm dừng
 * (trả lease khi SIGTERM, C10).
 */
export function runAsLeader(
  lease: Lease,
  handlers: { onLead: () => void; onLose: () => void; onError?: (error: unknown) => void },
  renewMs = 5_000,
): () => Promise<void> {
  let leading = false;
  let stopped = false;
  const loop = async () => {
    try {
      const held = await lease.tick();
      if (held && !leading) handlers.onLead();
      if (!held && leading) handlers.onLose();
      leading = held;
    } catch (error) {
      if (leading) handlers.onLose();
      leading = false;
      handlers.onError?.(error);
    }
    if (!stopped) timer = setTimeout(() => void loop(), renewMs);
  };
  let timer = setTimeout(() => void loop(), 0);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    if (leading) handlers.onLose();
    await lease.release();
  };
}
