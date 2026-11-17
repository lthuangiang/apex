import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

// Lease trên Redis (ARCHITECTURE.md mục 3.3.1): `SET key token NX PX ttl`, gia hạn định kỳ, chỉ người
// giữ token mới gia hạn hoặc trả được (script Lua so token). Dùng cho leader của marketdata/scheduler
// và shard của engine.

export interface LeaseRedis {
  set(key: string, value: string, px: "PX", ttl: number, nx: "NX"): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
/**
 * Gia hạn nhiều lease trong MỘT lần gọi Redis (DEC-TBD-engine-lease-renew). KEYS[1] = key heartbeat (ARGV[1] rỗng thì
 * bỏ qua, không thì `SET KEYS[1] ARGV[1] PX ARGV[2]`); KEYS[i] (i ≥ 2) = lease, token ARGV[2i − 1], ttl ARGV[2i]. Trả về
 * mảng 0 / 1 theo thứ tự lease.
 */
export const RENEW_MANY_SCRIPT = `if ARGV[1] ~= '' then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) end
local out = {}
for i = 2, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[2 * i - 1] then
    out[#out + 1] = redis.call('PEXPIRE', KEYS[i], ARGV[2 * i])
  else
    out[#out + 1] = 0
  end
end
return out`;

export class Lease {
  readonly token = randomUUID();
  #held = false;

  constructor(
    private readonly redis: LeaseRedis,
    readonly key: string,
    readonly ttlMs = 15_000,
  ) {}

  /**
   * Gia hạn mọi lease (cùng một Redis) và ghi heartbeat trong một round trip. Lease không còn là của mình trả `false`
   * và chuyển sang "không giữ"; lần `tick()` sau sẽ thử `SET NX` lại với cùng token.
   */
  static async renewMany(
    redis: LeaseRedis,
    leases: readonly Lease[],
    heartbeat?: { key: string; value: string; ttlMs: number },
  ): Promise<boolean[]> {
    if (leases.length === 0 && heartbeat === undefined) return [];
    const keys = [heartbeat?.key ?? "", ...leases.map((l) => l.key)];
    const args: (string | number)[] = [heartbeat?.value ?? "", heartbeat?.ttlMs ?? 0];
    for (const l of leases) args.push(l.token, l.ttlMs);
    const raw = await redis.eval(RENEW_MANY_SCRIPT, keys.length, ...keys, ...args);
    const list = Array.isArray(raw) ? (raw as unknown[]) : [];
    return leases.map((l, i) => {
      const ok = list[i] === 1;
      l.#held = ok;
      return ok;
    });
  }

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

/** Lý do mất lease trong `LeaseSet`. */
export type LeaseLoss = "taken" | "epoch_moved" | "unverified";

export interface LeaseSetOptions<K> {
  redis: LeaseRedis;
  ttlMs: number;
  /** Chu kỳ gia hạn; mặc định ttl / 3. */
  renewEveryMs?: number;
  /** Lease coi là hết hiệu lực sớm hơn hạn Redis chừng này (trễ mạng, lệch đồng hồ); mặc định ttl / 5. */
  marginMs?: number;
  /** Key heartbeat của worker, ghi cùng lần gia hạn. */
  heartbeat?: { key: string; value: () => string };
  /** Đồng hồ đơn điệu (ms); mặc định `performance.now`. */
  clock?: () => number;
  /**
   * Lease hết hạn nhưng `SET NX` lại được với chính token của mình: xác nhận không ai khác đã nhận trong lúc đó (ví dụ
   * epoch trong DB vẫn là của mình). `true` → giữ nguyên lease và mọi thứ gắn với nó.
   */
  verify: (id: K) => Promise<boolean>;
  /** Lease đã mất (đã bị bỏ khỏi set; nếu `SET NX` được mà không xác nhận được thì lease cũng đã được trả). */
  onLost: (id: K, reason: LeaseLoss) => void;
  onReacquired?: (id: K) => void;
  onError?: (error: unknown) => void;
}

interface LeaseEntry {
  lease: Lease;
  validUntil: number;
}

/**
 * Tập lease gia hạn bằng timer riêng (DEC-TBD-engine-lease-renew), không phụ thuộc vòng làm việc của caller: mọi lease
 * + heartbeat gia hạn trong một round trip mỗi `renewEveryMs`. Mỗi lease có `validUntil` = lúc gửi lần gia hạn thành
 * công gần nhất + ttl − margin; caller kiểm tra `valid(id)` trước khi hành động. Gia hạn thất bại (key đã hết hạn): thử
 * `SET NX` cùng token, rồi `verify`; được thì giữ nguyên, không thì báo `onLost`.
 */
export class LeaseSet<K> {
  readonly #o: Required<Omit<LeaseSetOptions<K>, "heartbeat" | "onReacquired" | "onError">> &
    Pick<LeaseSetOptions<K>, "heartbeat" | "onReacquired" | "onError">;
  readonly #entries = new Map<K, LeaseEntry>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #inflight: Promise<void> | null = null;

  constructor(options: LeaseSetOptions<K>) {
    this.#o = {
      renewEveryMs: Math.max(1, Math.floor(options.ttlMs / 3)),
      marginMs: Math.floor(options.ttlMs / 5),
      clock: () => performance.now(),
      ...options,
    };
  }

  get size(): number {
    return this.#entries.size;
  }

  ids(): K[] {
    return [...this.#entries.keys()];
  }

  has(id: K): boolean {
    return this.#entries.has(id);
  }

  /** Thêm lease vừa giành được; `sentAt` = lúc (đồng hồ `clock`) gửi lệnh `SET NX`. */
  add(id: K, lease: Lease, sentAt: number): void {
    this.#entries.set(id, { lease, validUntil: sentAt + this.#o.ttlMs - this.#o.marginMs });
  }

  /** Bỏ lease khỏi set (không trả lease trên Redis). */
  delete(id: K): Lease | undefined {
    const e = this.#entries.get(id);
    this.#entries.delete(id);
    return e?.lease;
  }

  /** Lease còn hiệu lực theo lần gia hạn thành công gần nhất. */
  valid(id: K): boolean {
    const e = this.#entries.get(id);
    return e !== undefined && this.#o.clock() < e.validUntil;
  }

  validUntil(id: K): number | undefined {
    return this.#entries.get(id)?.validUntil;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#schedule();
  }

  /** Dừng timer (không trả lease). */
  stop(): void {
    this.#running = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Gia hạn ngay (dùng chung lần đang chạy nếu có). */
  renew(): Promise<void> {
    this.#inflight ??= this.#renewOnce().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  #schedule(): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      void this.renew().finally(() => {
        this.#schedule();
      });
    }, this.#o.renewEveryMs);
    this.#timer.unref();
  }

  async #renewOnce(): Promise<void> {
    const entries = [...this.#entries];
    const hb = this.#o.heartbeat;
    const sentAt = this.#o.clock();
    let ok: boolean[];
    try {
      ok = await Lease.renewMany(
        this.#o.redis,
        entries.map(([, e]) => e.lease),
        hb === undefined ? undefined : { key: hb.key, value: hb.value(), ttlMs: this.#o.ttlMs },
      );
    } catch (error) {
      // Redis lỗi: không gia hạn được, `validUntil` tự hết; lần sau thử lại.
      this.#o.onError?.(error);
      return;
    }
    for (const [i, [id, entry]] of entries.entries()) {
      if (this.#entries.get(id) !== entry) continue;
      if (ok[i] === true) entry.validUntil = sentAt + this.#o.ttlMs - this.#o.marginMs;
      else await this.#recover(id, entry);
    }
  }

  async #recover(id: K, entry: LeaseEntry): Promise<void> {
    const sentAt = this.#o.clock();
    let got: boolean;
    try {
      got = await entry.lease.tick();
    } catch (error) {
      this.#o.onError?.(error);
      return;
    }
    if (this.#entries.get(id) !== entry) return;
    if (!got) {
      this.#entries.delete(id);
      this.#o.onLost(id, "taken");
      return;
    }
    let same: boolean | null;
    try {
      same = await this.#o.verify(id);
    } catch (error) {
      this.#o.onError?.(error);
      same = null;
    }
    if (this.#entries.get(id) !== entry) return;
    if (same === true) {
      entry.validUntil = sentAt + this.#o.ttlMs - this.#o.marginMs;
      this.#o.onReacquired?.(id);
      return;
    }
    // Có thể đã có worker khác nhận rồi trả trong lúc mình mất lease: không giữ gì gắn với lease cũ.
    this.#entries.delete(id);
    await entry.lease.release().catch((error: unknown) => {
      this.#o.onError?.(error);
    });
    this.#o.onLost(id, same === false ? "epoch_moved" : "unverified");
  }
}
