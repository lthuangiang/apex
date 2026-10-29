import { builderBalanceSnapshots, createDb, marketStatsDaily } from "@drift/db";
import { Lease, runAsLeader } from "@drift/runtime";
import { AppError, ErrorCode } from "@drift/shared";
import { loadSodexConfig, RedisRateLimitStore, SodexRestClient } from "@drift/sodex";
import { count, eq } from "drizzle-orm";
import { Redis } from "ioredis";
import pino from "pino";
import { getAddress } from "viem";
import { z } from "zod";

import { reconcileDay, snapshotBuilderBalances } from "./builder-revenue";
import { computeDailyStats, utcDate } from "./market-stats";
import { snapshotAndCheck } from "./risk";

// scheduler: một bản active (leader lease). Hiện có job market stats hằng ngày; các job lịch khác
// (recurring buy, reset daily loss, nhắc key hết hạn) thêm ở phase của chúng.

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    LOG_LEVEL: z.string().default("info"),
    SODEX_EGRESS_KEY: z.string().default("default"),
    /** Ví builder của DRIFT (đối soát builder revenue); trống thì bỏ qua đối soát. */
    DRIFT_BUILDER_ADDRESS: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional()
      .or(z.literal("").transform(() => undefined)),
  })
  .parse(process.env);
const log = pino({ level: env.LOG_LEVEL, base: { service: "scheduler" } });
const { db, pool } = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const rest = new SodexRestClient({
  config: loadSodexConfig(process.env),
  rateLimit: new RedisRateLimitStore(redis),
  egressKey: env.SODEX_EGRESS_KEY,
  priority: "background",
});
// Risk engine và đối soát: mức tương tác (an toàn tiền của người dùng), không bị job thống kê chặn.
const riskRest = new SodexRestClient({
  config: loadSodexConfig(process.env),
  rateLimit: new RedisRateLimitStore(redis),
  egressKey: env.SODEX_EGRESS_KEY,
});

async function wait<T>(read: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i += 1) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== ErrorCode.rateLimited || i >= 10)
        throw error;
      await new Promise((r) => setTimeout(r, Number(error.details.retryAfterMs ?? 1000)));
    }
  }
}

async function prices(markets: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const keys = [...new Set(markets)];
  if (keys.length === 0) return out;
  const raw = await redis.mget(...keys.map((m) => `md:last:${m}`));
  keys.forEach((m, i) => {
    const v = raw[i];
    if (v == null) return;
    const parsed = z.object({ price: z.string() }).safeParse(JSON.parse(v));
    if (parsed.success) out[m] = parsed.data.price;
  });
  return out;
}

/** Đọc SoDEX cho risk / revenue: chạm giới hạn tốc độ thì chờ rồi đọc lại (chỉ đọc, an toàn khi lặp). */
const patient = {
  getSpotBalances: (...a: Parameters<SodexRestClient["getSpotBalances"]>) =>
    wait(() => riskRest.getSpotBalances(...a)),
  getPerpsAccountState: (...a: Parameters<SodexRestClient["getPerpsAccountState"]>) =>
    wait(() => riskRest.getPerpsAccountState(...a)),
};

async function riskTick() {
  const r = await snapshotAndCheck({ db, rest: patient, prices, now: () => Date.now() });
  if (r.paused > 0) log.warn(r, "risk limits paused bots");
}

async function revenueTick() {
  if (env.DRIFT_BUILDER_ADDRESS === undefined) return;
  const today = utcDate(Date.now());
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(builderBalanceSnapshots)
    .where(eq(builderBalanceSnapshots.date, today));
  if (n > 0) return;
  await snapshotBuilderBalances({
    db,
    rest: patient,
    builderAddress: getAddress(env.DRIFT_BUILDER_ADDRESS),
    now: () => Date.now(),
  });
  await reconcileDay(db, utcDate(Date.now() - 86_400_000));
  log.info({ date: today }, "builder balances snapshotted, yesterday reconciled");
}

let timer: ReturnType<typeof setInterval> | null = null;
let riskTimer: ReturnType<typeof setInterval> | null = null;
async function tick() {
  const today = utcDate(Date.now());
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(marketStatsDaily)
    .where(eq(marketStatsDaily.date, today));
  if (n > 0) return;
  const result = await computeDailyStats({ db, rest, now: () => new Date(), wait });
  log.info({ date: today, ...result }, "market stats computed");
}

const stopLeader = runAsLeader(new Lease(redis, "lease:scheduler"), {
  onLead: () => {
    void tick().catch((error: unknown) => {
      log.error({ err: error }, "tick failed");
    });
    riskTimer = setInterval(() => {
      void riskTick()
        .then(revenueTick)
        .catch((error: unknown) => {
          log.error({ err: error }, "risk/revenue tick failed");
        });
    }, 60_000);
    timer = setInterval(() => {
      void tick().catch((error: unknown) => {
        log.error({ err: error }, "tick failed");
      });
    }, 10 * 60_000);
  },
  onLose: () => {
    if (timer !== null) clearInterval(timer);
    if (riskTimer !== null) clearInterval(riskTimer);
    timer = null;
    riskTimer = null;
  },
});

async function shutdown() {
  await stopLeader();
  await pool.end();
  redis.disconnect();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
