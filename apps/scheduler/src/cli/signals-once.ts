import { createDb } from "@drift/db";
import {
  loadSodexConfig,
  MemoryRateLimitStore,
  RedisRateLimitStore,
  SodexRestClient,
} from "@drift/sodex";
import { Redis } from "ioredis";
import pino from "pino";
import { z } from "zod";

import { countPrefixTokens, emptyUsage, type NewsClassifier } from "../signal-research/classifier";
import {
  createSignalResearch,
  parseSignalEnv,
  type PerpsSymbolInfo,
  type RedisLike,
} from "../signal-research/index";

// `pnpm --filter @drift/scheduler signals:once [-- --cycles N] [--gap-sec S] [--mock-classifier]`: chạy N chu kỳ của lane
// tin tức ngay (không cần leader lease, không NATS), ghi vào DATABASE_URL. Chỉ dùng với DB local để thử với SoSoValue /
// Claude thật. Đi cùng đường với scheduler: đọc danh sách perps SoDEX MỘT lần (REST công khai, chỉ đọc, như lúc scheduler
// nhận lease); không đọc được thì chu kỳ chỉ Collect. File này nằm ngoài thư mục lane vì là nơi DUY NHẤT của lane dùng
// client SoDEX, và chỉ gọi `getPerpsSymbols` (có test kiểm). Khi có `DESK_AI_API_KEY`: đếm token của prefix được cache bằng
// `messages.countTokens` (miễn phí) trước chu kỳ đầu.

const base = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().default(""),
    SODEX_EGRESS_KEY: z.string().default("default"),
  })
  .parse(process.env);
const parsed = parseSignalEnv(process.env);
if (parsed.env === null) {
  console.error(`signal research env: ${parsed.warning ?? "invalid"}`);
  process.exit(2);
}
const env = parsed.env;
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
const { db, pool } = createDb(base.DATABASE_URL);
const redis = base.REDIS_URL === "" ? null : new Redis(base.REDIS_URL, { maxRetriesPerRequest: 1 });
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

let perps: PerpsSymbolInfo[] | null = null;
try {
  const rest = new SodexRestClient({
    config: loadSodexConfig(process.env),
    rateLimit: redis === null ? new MemoryRateLimitStore() : new RedisRateLimitStore(redis),
    egressKey: base.SODEX_EGRESS_KEY,
    priority: "background",
  });
  perps = (await rest.getPerpsSymbols()).map((m) => ({
    name: m.name,
    status: m.status,
    tickSize: m.tickSize,
    takerFee: m.takerFee,
  }));
} catch (error) {
  log.warn(
    { err: error instanceof Error ? error.name : "error" },
    "SoDEX market list unavailable, collect only",
  );
}

try {
  if (!mock && perps !== null) {
    const universe = perps.filter((p) => p.status === "TRADING").map((p) => p.name);
    const t = await countPrefixTokens(env.DESK_AI_API_KEY, [...universe].sort());
    log.info(
      { ...t, cacheMinimum: 4096, markets: universe.length },
      "claude cached prefix tokens (countTokens)",
    );
  }
  const sr = createSignalResearch({
    db,
    redis: redis ?? noRedis,
    log,
    env,
    perps: () => perps,
    ...(mock ? { classifier: mockClassifier } : {}),
  });
  for (let i = 0; i < cycles; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, gapSec * 1000));
    await sr.runCycle();
  }
} finally {
  redis?.disconnect();
  await pool.end();
}
