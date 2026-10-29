import { createDb } from "@drift/db";
import { consume, ensureConsumer, ensureStreams } from "@drift/runtime";
import { loadSodexConfig, RedisRateLimitStore, SodexRestClient } from "@drift/sodex";
import { connect } from "@nats-io/transport-node";
import { Redis } from "ioredis";
import pino from "pino";
import { z } from "zod";

import { runJob } from "./run";

// backtest: worker CPU nặng, kéo job `backtest.run` từ JetStream (consumer group), scale bằng replica.

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    NATS_URL: z.string().min(1),
    LOG_LEVEL: z.string().default("info"),
    SODEX_EGRESS_KEY: z.string().default("default"),
  })
  .parse(process.env);
const log = pino({ level: env.LOG_LEVEL, base: { service: "backtest" } });
const { db, pool } = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const rest = new SodexRestClient({
  config: loadSodexConfig(process.env),
  rateLimit: new RedisRateLimitStore(redis),
  egressKey: env.SODEX_EGRESS_KEY,
  priority: "background",
});
const nc = await connect({ servers: env.NATS_URL });
const js = await ensureStreams(nc);
await ensureConsumer(nc, "backtest-run", "backtest.run");
const payload = z.object({ runId: z.uuid() });
const stop = await consume(
  js,
  "backtest-run",
  "backtest.run",
  async (p) => {
    const started = Date.now();
    const { runId } = payload.parse(p);
    await runJob({ db, rest, now: () => new Date() }, runId);
    log.info({ runId, ms: Date.now() - started }, "backtest finished");
  },
  (msg, extra) => {
    log.warn(extra, msg);
  },
);
log.info("backtest worker ready");

async function shutdown() {
  await stop();
  await nc.drain();
  await pool.end();
  redis.disconnect();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
