import { candles1m, createDb, fundingRates } from "@drift/db";
import { Lease, runAsLeader } from "@drift/runtime";
import { AppError, ErrorCode } from "@drift/shared";
import {
  loadSodexConfig,
  MarketStream,
  RedisRateLimitStore,
  SodexRestClient,
  type Engine,
  type WsCandle,
} from "@drift/sodex";
import { connect } from "@nats-io/transport-node";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import pino from "pino";
import { z } from "zod";

import { CandleTracker, FundingTracker, marketSubject } from "./trackers";

// marketdata: nơi duy nhất mở WS thị trường SoDEX (ARCHITECTURE.md mục 3.3.7). Một bản active nhờ
// leader lease; các bản khác chờ. Ghi `candles_1m`, `funding_rates`, publish `md.<market>.*`.

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    NATS_URL: z.string().min(1),
    LOG_LEVEL: z.string().default("info"),
    SODEX_EGRESS_KEY: z.string().default("default"),
    /** Số phút backfill bằng REST khi lên leader hoặc kết nối lại. */
    MARKETDATA_BACKFILL_MINUTES: z.coerce.number().int().positive().default(360),
  })
  .parse(process.env);
const log = pino({ level: env.LOG_LEVEL, base: { service: "marketdata" } });
const sodex = loadSodexConfig(process.env);
const { db, pool } = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const rest = new SodexRestClient({
  config: sodex,
  rateLimit: new RedisRateLimitStore(redis),
  egressKey: env.SODEX_EGRESS_KEY,
  priority: "background",
});
const nc = await connect({ servers: env.NATS_URL });

async function saveCandles(
  candles: readonly {
    market: string;
    t: number;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
  }[],
) {
  if (candles.length === 0) return;
  await db
    .insert(candles1m)
    .values(
      candles.map((k) => ({
        market: k.market,
        ts: new Date(k.t),
        open: k.o,
        high: k.h,
        low: k.l,
        close: k.c,
        volume: k.v,
      })),
    )
    .onConflictDoUpdate({
      target: [candles1m.market, candles1m.ts],
      set: {
        open: sql`excluded.open`,
        high: sql`excluded.high`,
        low: sql`excluded.low`,
        close: sql`excluded.close`,
        volume: sql`excluded.volume`,
      },
    });
}

/** Đọc lại khi hết hạn mức của chính DRIFT: chờ đúng retryAfterMs (đọc được retry, C10). */
async function withRateLimitWait<T>(read: () => Promise<T>, attempts = 10): Promise<T> {
  for (let i = 0; ; i += 1) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== ErrorCode.rateLimited || i >= attempts)
        throw error;
      await new Promise((r) => setTimeout(r, Number(error.details.retryAfterMs ?? 1000)));
    }
  }
}

async function backfill(engine: Engine, symbols: readonly string[]) {
  const now = Date.now();
  const openMinute = now - (now % 60_000);
  for (const symbol of symbols) {
    try {
      const rows = await withRateLimitWait(() =>
        rest.getKlines(engine, symbol, {
          interval: "1m",
          limit: Math.min(env.MARKETDATA_BACKFILL_MINUTES, 1000),
        }),
      );
      await saveCandles(
        rows.filter((k) => k.t < openMinute).map((k) => ({ ...k, market: symbol })),
      );
    } catch (error) {
      log.warn({ err: error, symbol }, "backfill failed");
    }
  }
}

function onCandles(closed: WsCandle[]) {
  if (closed.length === 0) return;
  void saveCandles(closed.map((k) => ({ ...k, market: k.s }))).catch((error: unknown) => {
    log.error({ err: error }, "save candles failed");
  });
  for (const k of closed) nc.publish(marketSubject(k.s, "kline.1m"), JSON.stringify(k));
}

let streams: MarketStream[] = [];

async function start() {
  const [spot, perps] = await Promise.all([rest.getSpotSymbols(), rest.getPerpsSymbols()]);
  const spotSymbols = spot.filter((s) => s.status === "TRADING").map((s) => s.name);
  const perpsSymbols = perps.filter((s) => s.status === "TRADING").map((s) => s.name);
  const funding = new FundingTracker();
  const make = (engine: Engine, symbols: string[]) => {
    const tracker = new CandleTracker();
    return new MarketStream({
      baseUrl: sodex.wsUrl,
      engine,
      symbols,
      markPrices: engine === "perps",
      callbacks: {
        onCandle: (k) => {
          // Giá gần nhất cho engine (khoảng 2 s một lần) và nến đã đóng cho candles_1m.
          nc.publish(marketSubject(k.s, "price"), JSON.stringify({ s: k.s, c: k.c, T: k.T }));
          // Giá gần nhất cho api (kiểm tra "Giá được cập nhật trong vòng ≤ 5 s", SCREENS.md mục 8.2).
          void redis
            .set(`md:last:${k.s}`, JSON.stringify({ price: k.c, at: k.T }), "PX", 60_000)
            .catch(() => undefined);
          onCandles(tracker.push(k));
        },
        onMarkPrices: (marks) => {
          for (const m of marks) nc.publish(marketSubject(m.s, "mark"), JSON.stringify(m));
          const settled = funding.push(marks);
          if (settled.length > 0) {
            // Engine nhận kỳ funding đã chốt (tỷ lệ thô) để chiến lược Funding Arb quyết định.
            for (const f of settled)
              nc.publish(
                marketSubject(f.market, "funding"),
                JSON.stringify({ s: f.market, rate: f.rate, T: f.fundingTime }),
              );
            void db
              .insert(fundingRates)
              .values(
                settled.map((f) => ({
                  market: f.market,
                  fundingTime: new Date(f.fundingTime),
                  rate: f.rate,
                })),
              )
              .onConflictDoNothing()
              .catch((error: unknown) => {
                log.error({ err: error }, "save funding failed");
              });
          }
        },
        onReconnect: () => void backfill(engine, symbols),
        onError: (error) => {
          log.warn({ err: error.message, engine }, "market stream error");
        },
      },
    });
  };
  streams = [make("spot", spotSymbols), make("perps", perpsSymbols)];
  for (const s of streams) s.connect();
  log.info({ spot: spotSymbols.length, perps: perpsSymbols.length }, "marketdata leading");
  await Promise.all([backfill("spot", spotSymbols), backfill("perps", perpsSymbols)]);
}

function stop() {
  for (const s of streams) s.close();
  streams = [];
}

const stopLeader = runAsLeader(new Lease(redis, "lease:marketdata"), {
  onLead: () => {
    void start().catch((error: unknown) => {
      log.error({ err: error }, "marketdata start failed");
      stop();
    });
  },
  onLose: () => {
    log.warn("marketdata lost leadership");
    stop();
  },
  onError: (error) => {
    log.warn({ err: error }, "lease error");
  },
});

async function shutdown() {
  await stopLeader();
  await nc.drain();
  await pool.end();
  redis.disconnect();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
