import { createDb } from "@drift/db";
import { Redis } from "ioredis";
import pino from "pino";
import { z } from "zod";

import { emptyUsage, type NewsClassifier } from "./classifier";

import { createSignalResearch, signalResearchEnvSchema, type RedisLike } from "./index";

// `pnpm --filter @drift/scheduler signals:once [--cycles N] [--gap-sec S] [--mock-classifier]`: chạy N chu kỳ của lane
// tin tức ngay (không cần leader lease, không NATS), ghi vào DATABASE_URL. Chỉ dùng với DB local để thử với SoSoValue /
// Claude thật. Không có đường nào tới SoDEX. Không cần SIGNAL_RESEARCH_ENABLED (công cụ chạy tay).

const env = z
  .object({ DATABASE_URL: z.string().min(1), REDIS_URL: z.string().default("") })
  .extend(signalResearchEnvSchema.shape)
  .parse(process.env);
const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : d;
};
const cycles = arg("--cycles", 1);
const gapSec = arg("--gap-sec", 60);
const mock = process.argv.includes("--mock-classifier") || env.DESK_AI_API_KEY.trim() === "";
if (env.SOSO_API_KEY.trim() === "") {
  console.error("SOSO_API_KEY is not set");
  process.exit(2);
}

const log = pino({ base: { service: "scheduler", tool: "signals:once" } });
const { db, pool } = createDb(env.DATABASE_URL);
const redis = env.REDIS_URL === "" ? null : new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
const noRedis: RedisLike = { mget: (...keys) => Promise.resolve(keys.map(() => null)) };
/** Bộ phân loại giả (khi không có key Claude): luôn "none", không tốn token. */
const mockClassifier: NewsClassifier = {
  classify: () =>
    Promise.resolve({
      ok: true,
      value: {
        catalyst: "none",
        market: null,
        relevance: "passing_mention",
        promotional: false,
        eventDate: null,
      },
      usage: emptyUsage(),
    }),
};
if (mock) log.warn("classifier is mocked (no DESK_AI_API_KEY or --mock-classifier)");

const sr = createSignalResearch({
  db,
  redis: redis ?? noRedis,
  log,
  env,
  perps: () => null,
  ...(mock ? { classifier: mockClassifier } : {}),
});
try {
  for (let i = 0; i < cycles; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, gapSec * 1000));
    await sr.runCycle();
  }
} finally {
  redis?.disconnect();
  await pool.end();
}
