import {
  candles1m,
  copiedLeaders,
  createDb,
  followedLeaders,
  fundingRates,
  latestTypicalHold,
  liveCopyBots,
} from "@drift/db";
import { chargedFetch, HlUserFillsStream, HyperliquidClient } from "@drift/hyperliquid";
import { Lease, runAsLeader } from "@drift/runtime";
import {
  AppError,
  coinIndex,
  ErrorCode,
  type CoinIndex,
  type LeaderFillMessage,
  type LeaderPositionMessage,
} from "@drift/shared";
import {
  loadSodexConfig,
  MarketStream,
  RedisRateLimitStore,
  SodexRestClient,
  type Engine,
  type WsCandle,
  WsUserStream,
} from "@drift/sodex";
import { connect } from "@nats-io/transport-node";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import pino from "pino";
import { z } from "zod";

import { CopyAllocator } from "./copy-allocator";
import { HlLeaderTracker } from "./hl-leaders";
import { getCursor, saveLeaderEvents, setCursor } from "./leader-store";
import { LeaderWatcher } from "./leaders";
import { LiquidationScanner } from "./liquidations";
import { MmCostCollector } from "./mm-cost";
import {
  mmBotMarkets,
  purgeMmCost,
  saveFlush,
  seedCurrentHour,
  topVolumeMarkets,
} from "./mm-cost-store";
import { MmRawRecorder } from "./mm-raw";
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
    /** `hyperliquid`: quét bản đồ thanh lý từ dữ liệu công khai (DEC-92). */
    LIQUIDATION_PROVIDER: z.enum(["none", "hyperliquid"]).default("none"),
    /** Chu kỳ đọc lại danh sách và vị thế ví leader của Copy Trade (DEC-161). */
    LEADER_SYNC_MS: z.coerce.number().int().positive().default(30_000),
    /** Số WS ví leader tối đa (SoDEX: 10 user mỗi IP trên WS). */
    LEADER_MAX_STREAMS: z.coerce.number().int().nonnegative().default(8),
    /**
     * Thư mục lưu thô bookTicker + trade theo giờ, giữ 48 giờ (DEC-228); trống = không lưu.
     */
    MM_RAW_DIR: z.string().default(""),
    /** Cảnh báo "big move" (DEC-163 mục 11): notional tối thiểu USD; trống = tắt (OPEN_QUESTIONS 21a). */
    COPY_BIG_MOVE_MIN_USD: z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .optional()
      .or(z.literal("").transform(() => undefined)),
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
let scanner: LiquidationScanner | null = null;
let leaderTimer: ReturnType<typeof setInterval> | null = null;

// Copy Trading (DEC-163 mục 5, 9): hạn mức cho tín hiệu mở / tăng (minHold, ≤ 50% độ sâu sổ SoDEX). Sổ lệnh đọc ở mức
// tương tác (không phải job nền) vì nằm trên đường đi của tín hiệu.
const bookRest = new SodexRestClient({
  config: sodex,
  rateLimit: new RedisRateLimitStore(redis),
  egressKey: env.SODEX_EGRESS_KEY,
});
const allocator = new CopyAllocator({
  bots: () => liveCopyBots(db),
  holds: (addresses) => latestTypicalHold(db, "hyperliquid", addresses),
  orderbook: async (market) => {
    const b = await bookRest.getOrderbook("perps", market, 20);
    return { bids: b.bids, asks: b.asks };
  },
  warn: (detail, message) => {
    log.warn(detail, message);
  },
});
/** Publish tín hiệu leader theo thứ tự cho từng ví (fill cần đọc sổ lệnh trước khi đi). */
const leaderChains = new Map<string, Promise<void>>();
function publishLeader(subject: string, payload: LeaderFillMessage | LeaderPositionMessage) {
  const key = `${payload.source}:${payload.address}`;
  const prev = leaderChains.get(key) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const out = "market" in payload ? await allocator.enrich(payload) : payload;
      nc.publish(subject, JSON.stringify(out));
    })
    .catch((error: unknown) => {
      log.warn({ err: error, subject }, "leader publish failed");
    });
  leaderChains.set(key, next);
  void next.then(() => {
    if (leaderChains.get(key) === next) leaderChains.delete(key);
  });
}

// Copy Trade (DEC-161): ví leader (nguồn SoDEX) của các bot copy đang chạy, kể cả bot paper.
const leaders = new LeaderWatcher({
  activeLeaders: () => copiedLeaders(db, "sodex"),
  readPositions: async (address) => {
    const state = await rest.getPerpsAccountState(address as `0x${string}`);
    return Object.fromEntries(state.P.map((p) => [p.s, p.sz]));
  },
  openStream: (address, handlers) => {
    const stream = new WsUserStream({
      baseUrl: sodex.wsUrl,
      engine: "perps",
      user: address as `0x${string}`,
      callbacks: {
        onOrderUpdate: () => undefined,
        onTrade: (trades) => {
          handlers.onTrades(
            trades.map((t) => ({
              market: t.s,
              side: t.S === "BUY" ? "buy" : "sell",
              price: t.p,
              quantity: t.q,
              at: t.T,
            })),
          );
        },
        onReconnect: () => {
          handlers.onReconnect();
        },
        onError: (error) => {
          log.warn({ err: error, address }, "leader stream error");
        },
      },
    });
    stream.connect();
    return stream;
  },
  publish: publishLeader,
  now: Date.now,
  warn: (detail, message) => {
    log.warn(detail, message);
  },
  maxStreams: env.LEADER_MAX_STREAMS,
});

// Copy Trading v1 (DEC-163): ví leader Hyperliquid, chỉ đọc. Bucket weight chung theo IP với scheduler (T2).
const hl = new HyperliquidClient({
  limiter: new RedisRateLimitStore(redis),
  bucketKey: `hl:ip:${env.SODEX_EGRESS_KEY}`,
});
let hlIndex: CoinIndex = coinIndex([]);
const hlStream = new HlUserFillsStream({
  callbacks: {
    onFills: (user, fills) => {
      hlLeaders.onWsFills(user, fills);
    },
    onReconnect: () => {
      for (const a of hlLeaders.streaming)
        void hlLeaders.refreshPositions(a).catch((error: unknown) => {
          log.warn({ err: error, address: a }, "hyperliquid leader read after reconnect failed");
        });
    },
    onError: (error) => {
      log.warn({ err: error }, "hyperliquid leader stream error");
    },
  },
});
const hlLeaders = new HlLeaderTracker({
  copied: () => copiedLeaders(db, "hyperliquid"),
  followed: () => followedLeaders(db, "hyperliquid"),
  stream: hlStream,
  hl,
  index: () => hlIndex,
  publish: publishLeader,
  getCursor: (a) => getCursor(db, "hyperliquid", a),
  setCursor: (a, ms) => setCursor(db, "hyperliquid", a, ms),
  onEvents: (a, events, seenAt) =>
    saveLeaderEvents(db, "hyperliquid", a, events, seenAt, {
      minUsd: env.COPY_BIG_MOVE_MIN_USD ?? null,
    }),
  now: Date.now,
  warn: (detail, message) => {
    log.warn(detail, message);
  },
});
let hlTimers: ReturnType<typeof setInterval>[] = [];

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
let mmTimers: ReturnType<typeof setInterval>[] = [];
/** Bộ lưu thô của lần làm leader hiện tại; ghi nốt phần đệm khi dừng. */
let mmRawNow: MmRawRecorder | null = null;

async function start() {
  const [spot, perps] = await Promise.all([rest.getSpotSymbols(), rest.getPerpsSymbols()]);
  const spotSymbols = spot.filter((s) => s.status === "TRADING").map((s) => s.name);
  const perpsSymbols = perps.filter((s) => s.status === "TRADING").map((s) => s.name);
  const funding = new FundingTracker();
  // Chi phí làm market (DEC-227): book ticker + giao dịch công khai trên CHÍNH kết nối perps.
  const mmCost = new MmCostCollector();
  const mmRaw = env.MM_RAW_DIR === "" ? null : new MmRawRecorder(env.MM_RAW_DIR);
  mmRawNow = mmRaw;
  mmCost.setTickSizes(
    Object.fromEntries(
      perps.filter((s) => s.status === "TRADING").map((s) => [s.name, s.tickSize]),
    ),
  );
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
        ...(engine === "perps"
          ? {
              onBookTickers: (
                tickers: { s: string; b: string; B: string; a: string; A: string; E: number }[],
              ) => {
                const at = Date.now();
                for (const t of tickers) {
                  mmCost.onBook(t.s, t.b, t.a, at);
                  mmRaw?.book(t, at);
                }
              },
              onTrades: (
                trades: {
                  s: string;
                  T: number;
                  t?: number | string | undefined;
                  S: "BUY" | "SELL";
                  p: string;
                  q: string;
                }[],
              ) => {
                const at = Date.now();
                for (const t of trades) {
                  mmCost.onTrade(t.s, t.T, t.S, t.p, t.q);
                  mmRaw?.trade(t, at);
                }
              },
            }
          : {}),
        onReconnect: () => void backfill(engine, symbols),
        onError: (error) => {
          log.warn({ err: error.message, engine }, "market stream error");
        },
      },
    });
  };
  const perpsStream = make("perps", perpsSymbols);
  streams = [make("spot", spotSymbols), perpsStream];
  for (const s of streams) s.connect();
  await seedCurrentHour(db, mmCost, Date.now()).catch((error: unknown) => {
    log.warn({ err: error }, "mm cost seed failed");
  });
  const mmWatch = async () => {
    const [top, mm] = await Promise.all([
      topVolumeMarkets(db, perpsSymbols, Date.now()),
      mmBotMarkets(db),
    ]);
    const watched = [...new Set([...top, ...mm])].filter((m) => perpsSymbols.includes(m));
    perpsStream.watchMicro(watched);
    mmCost.setMidMarkets(mm);
  };
  const mmEvery = (ms: number, run: () => Promise<void> | void, what: string) => {
    const go = () => {
      void Promise.resolve()
        .then(run)
        .catch((error: unknown) => {
          log.warn({ err: error }, what);
        });
    };
    go();
    mmTimers.push(setInterval(go, ms));
  };
  mmEvery(5 * 60_000, mmWatch, "mm cost watch list failed");
  mmTimers.push(
    setInterval(() => {
      mmCost.tick(Date.now());
    }, 1_000),
  );
  mmEvery(60_000, () => saveFlush(db, mmCost.flush(Date.now())), "mm cost save failed");
  mmEvery(3_600_000, () => purgeMmCost(db, Date.now()), "mm cost purge failed");
  if (mmRaw !== null) {
    mmEvery(
      5_000,
      async () => {
        await mmRaw.flush();
      },
      "mm raw write failed",
    );
    mmEvery(
      3_600_000,
      async () => {
        await mmRaw.purge(Date.now());
      },
      "mm raw purge failed",
    );
  }
  log.info({ spot: spotSymbols.length, perps: perpsSymbols.length }, "marketdata leading");
  if (env.LIQUIDATION_PROVIDER === "hyperliquid") {
    // Chỉ leader quét: hạn mức Hyperliquid tính theo IP, chạy hai bản là gấp đôi weight.
    scanner = new LiquidationScanner({
      store: redis,
      // Cùng bucket weight Hyperliquid với Copy Trading (DEC-163 mục 10).
      fetch: chargedFetch(new RedisRateLimitStore(redis), `hl:ip:${env.SODEX_EGRESS_KEY}`),
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      warn: (detail, message) => {
        log.warn(detail, message);
      },
    });
    void scanner.run();
  }
  await Promise.all([backfill("spot", spotSymbols), backfill("perps", perpsSymbols)]);
  const syncLeaders = () => {
    void allocator.refresh().catch((error: unknown) => {
      log.warn({ err: error }, "copy allocator refresh failed");
    });
    void leaders.sync().catch((error: unknown) => {
      log.warn({ err: error }, "leader sync failed");
    });
  };
  syncLeaders();
  leaderTimer = setInterval(syncLeaders, env.LEADER_SYNC_MS);

  hlIndex = coinIndex(perpsSymbols);
  const every = (ms: number, run: () => Promise<void>, what: string) => {
    const go = () => {
      void run().catch((error: unknown) => {
        log.warn({ err: error }, what);
      });
    };
    go();
    hlTimers.push(setInterval(go, ms));
  };
  every(env.LEADER_SYNC_MS, () => hlLeaders.sync(), "hyperliquid leader sync failed");
  every(120_000, () => hlLeaders.poll(), "hyperliquid follow poll failed");
  every(10_000, () => hlLeaders.flush(), "hyperliquid leader flush failed");
}

function stop() {
  for (const s of streams) s.close();
  for (const t of mmTimers) clearInterval(t);
  mmTimers = [];
  // Ghi nốt phần đệm (không chờ: stop chạy đồng bộ khi mất leader).
  void mmRawNow?.flush().catch((error: unknown) => {
    log.warn({ err: error }, "mm raw write failed");
  });
  mmRawNow = null;
  streams = [];
  scanner?.stop();
  scanner = null;
  if (leaderTimer !== null) clearInterval(leaderTimer);
  leaderTimer = null;
  leaders.stop();
  for (const t of hlTimers) clearInterval(t);
  hlTimers = [];
  hlStream.setUsers([]);
}

// Khởi động thất bại (SoDEX lỗi đúng lúc nhận leader) thì thử lại khi vẫn còn là leader. Trước đây chỉ ghi log rồi
// dừng: bản này giữ lease mà không phát giá, bản kia không được lên thay, giá đứng vô hạn (local 2026-11-09).
const START_RETRY_MAX_MS = 60_000;
let leading = false;
let startRetry: ReturnType<typeof setTimeout> | null = null;
function launch(attempt = 0) {
  void start().catch((error: unknown) => {
    stop();
    if (!leading) return;
    const delay = Math.min(START_RETRY_MAX_MS, 5_000 * 2 ** attempt);
    log.error({ err: error, retryInMs: delay }, "marketdata start failed; retrying");
    startRetry = setTimeout(() => {
      startRetry = null;
      if (leading) launch(attempt + 1);
    }, delay);
  });
}

const stopLeader = runAsLeader(new Lease(redis, "lease:marketdata"), {
  onLead: () => {
    leading = true;
    launch();
  },
  onLose: () => {
    leading = false;
    if (startRetry !== null) clearTimeout(startRetry);
    startRetry = null;
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
