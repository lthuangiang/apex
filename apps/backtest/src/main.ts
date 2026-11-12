import { createDb } from "@drift/db";
import { consume, ensureConsumer, ensureStreams } from "@drift/runtime";
import { loadSodexConfig, RedisRateLimitStore, SodexRestClient } from "@drift/sodex";
import { connect } from "@nats-io/transport-node";
import { Redis } from "ioredis";
import pino from "pino";
import { z } from "zod";

import { runRecord } from "./record";
import { runReview } from "./review";
import { runJob } from "./run";
import { runWhatif } from "./whatif";

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
// Cùng hàng đợi `backtest.run` cho backtest (`runId`), review sau khi chạy (`reviewId`, DEC-131) và what-if của AI Desk
// B+ (`whatifId`, DEC-166) và đo thành tích (`applyId`): không phải thêm subject vào stream BACKTEST đã có trên prod.
const payload = z.union([
  z.object({ runId: z.uuid() }),
  z.object({ reviewId: z.uuid() }),
  z.object({ whatifId: z.uuid() }),
  z.object({ applyId: z.uuid() }),
]);
const stop = await consume(
  js,
  "backtest-run",
  "backtest.run",
  async (p) => {
    const started = Date.now();
    const job = payload.parse(p);
    const deps = { db, rest, now: () => new Date() };
    if ("runId" in job) {
      await runJob(deps, job.runId);
      log.info({ runId: job.runId, ms: Date.now() - started }, "backtest finished");
    } else if ("applyId" in job) {
      await runRecord(deps, job.applyId);
      log.info({ applyId: job.applyId, ms: Date.now() - started }, "desk record measured");
    } else if ("whatifId" in job) {
      await runWhatif(deps, job.whatifId);
      log.info({ whatifId: job.whatifId, ms: Date.now() - started }, "what-if finished");
    } else {
      await runReview(deps, job.reviewId);
      log.info({ reviewId: job.reviewId, ms: Date.now() - started }, "review finished");
    }
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
