import { createDb } from "@drift/db";
import { loadSodexConfig, RedisRateLimitStore, SodexRestClient } from "@drift/sodex";
import { Redis } from "ioredis";
import pino from "pino";
import { z } from "zod";

import { buildRecoApp } from "./app";
import { marketLoader } from "./markets";

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    RECO_PORT: z.coerce.number().int().positive().default(8095),
    LOG_LEVEL: z.string().default("info"),
    SODEX_EGRESS_KEY: z.string().default("default"),
  })
  .parse(process.env);
const log = pino({ level: env.LOG_LEVEL, base: { service: "reco" } });
const { db, pool } = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const rest = new SodexRestClient({
  config: loadSodexConfig(process.env),
  rateLimit: new RedisRateLimitStore(redis),
  egressKey: env.SODEX_EGRESS_KEY,
});
const app = buildRecoApp({
  markets: marketLoader({ db, rest, now: () => Date.now() }),
  logLevel: env.LOG_LEVEL,
});
log.info({ port: env.RECO_PORT }, "reco listening");
await app.listen({ host: "0.0.0.0", port: env.RECO_PORT });

async function shutdown() {
  await app.close();
  await pool.end();
  redis.disconnect();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
