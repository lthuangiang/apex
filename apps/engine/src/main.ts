import { apiKeys, createDb } from "@drift/db";
import { loadClientTls } from "@drift/runtime";
import { dec, leaderFillMessageSchema, leaderPositionMessageSchema } from "@drift/shared";
import {
  loadSodexConfig,
  RedisRateLimitStore,
  SignedWriteClient,
  SodexRestClient,
  WsUserStream,
} from "@drift/sodex";
import { connect } from "@nats-io/transport-node";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import pino from "pino";
import { z } from "zod";

import { Engine } from "./engine";
import { HttpGateway, httpSigner, marketInfo } from "./http-gateway";
import { withLastUsed } from "./last-used";
import { PaperGateway } from "./paper-gateway";

// engine: chạy bot cho các shard mình giữ (ARCHITECTURE.md mục 3.3). Giá từ NATS (marketdata), fill từ
// user stream SoDEX của account thuộc shard. SIGTERM: trả lease, chờ việc dở (stop_grace_period 30 s).

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    NATS_URL: z.string().min(1),
    SIGNER_URL: z.url(),
    LOG_LEVEL: z.string().default("info"),
    SODEX_EGRESS_KEY: z.string().default("default"),
    ENGINE_WORKER_ID: z.string().default(`engine-${String(process.pid)}`),
    ENGINE_SHARD_LEASE_TTL_MS: z.coerce.number().int().positive().default(15_000),
    /** Chu kỳ đọc lại approval builder fee của mỗi account (mặc định 60 s). */
    ENGINE_FEE_CHECK_MS: z.coerce.number().int().positive().default(60_000),
  })
  .parse(process.env);
const log = pino({
  level: env.LOG_LEVEL,
  base: { service: "engine", worker: env.ENGINE_WORKER_ID },
});
const sodex = loadSodexConfig(process.env);
const { db, pool } = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const options = {
  config: sodex,
  rateLimit: new RedisRateLimitStore(redis),
  egressKey: env.SODEX_EGRESS_KEY,
};
const rest = new SodexRestClient(options);
const gateway = new HttpGateway(
  rest,
  new SignedWriteClient(options),
  withLastUsed(
    httpSigner(env.SIGNER_URL, loadClientTls(process.env, "SIGNER_CLIENT")),
    async (id, at) => {
      await db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, id));
    },
    {
      onError: (error) => {
        log.warn({ err: error }, "api key last_used_at update failed");
      },
    },
  ),
  sodex.builderId,
  sodex.builderExempt,
);
// Bot paper (DEC-105): cổng mô phỏng riêng, không có client SoDEX hay signer.
const paper = new PaperGateway({ db, now: () => Date.now() });
const engine = new Engine({
  db,
  redis,
  gateway,
  paper,
  workerId: env.ENGINE_WORKER_ID,
  log,
  leaseTtlMs: env.ENGINE_SHARD_LEASE_TTL_MS,
  feeCheckMs: env.ENGINE_FEE_CHECK_MS,
  rules: (market) => marketInfo(rest, market),
  builderId: sodex.builderId,
  builderExempt: sodex.builderExempt,
  // Volume Farm (DEC-80): 10 mức mỗi phía, như apex `get_orderbook_depth(symbol, 10)`.
  orderbook: async (market) => {
    const b = await rest.getOrderbook("perps", market, 10);
    const [bid] = b.bids;
    const [ask] = b.asks;
    if (bid === undefined || ask === undefined) return null;
    const notional = (levels: readonly (readonly [string, string])[]) =>
      levels.reduce((sum, [p, q]) => sum.add(dec(p).mul(q)), dec("0")).toString();
    return {
      bid: bid[0],
      ask: ask[0],
      bidNotional: notional(b.bids),
      askNotional: notional(b.asks),
    };
  },
});

const nc = await connect({ servers: env.NATS_URL });
const priceSub = nc.subscribe("md.*.price");
// Copy Trade (DEC-161): fill và vị thế của ví leader, `marketdata` publish.
const leaderSub = nc.subscribe("leader.*.*.*");
void (async () => {
  for await (const m of leaderSub) {
    try {
      const kind = m.subject.split(".")[3];
      if (kind === "fill")
        await engine.onLeaderFill(leaderFillMessageSchema.parse(m.json()), Date.now());
      else if (kind === "position")
        await engine.onLeaderPosition(leaderPositionMessageSchema.parse(m.json()), Date.now());
    } catch (error) {
      log.warn({ err: error }, "leader signal handling failed");
    }
  }
})();
const fundingSub = nc.subscribe("md.*.funding");
void (async () => {
  for await (const m of fundingSub) {
    try {
      const f = z.object({ s: z.string(), rate: z.string(), T: z.number() }).parse(m.json());
      await engine.onFunding(f.s, f.rate, f.T);
    } catch (error) {
      log.warn({ err: error }, "funding handling failed");
    }
  }
})();
void (async () => {
  for await (const m of priceSub) {
    try {
      const k = z.object({ s: z.string(), c: z.string(), T: z.number() }).parse(m.json());
      await engine.onPrice(k.s, k.c, k.T);
    } catch (error) {
      log.warn({ err: error }, "price handling failed");
    }
  }
})();

// User stream cho từng account đang có bot trong shard của worker này.
const streams = new Map<string, WsUserStream[]>();
async function syncStreams() {
  const wanted = new Map((await engine.activeAccounts()).map((a) => [a.id, a]));
  for (const [id, list] of streams) {
    if (!wanted.has(id)) {
      for (const s of list) s.close();
      streams.delete(id);
    }
  }
  for (const [id, account] of wanted) {
    if (streams.has(id)) continue;
    const make = (kind: "spot" | "perps") =>
      new WsUserStream({
        baseUrl: sodex.wsUrl,
        engine: kind,
        user: account.address,
        accountID: account.sodexAccountId,
        callbacks: {
          onOrderUpdate: (updates) => {
            for (const u of updates) {
              // Kết thúc mà chưa khớp gì: cập nhật ngay, không để lệnh kẹt "open" (DEC-122).
              const closed =
                u.X === "REJECTED"
                  ? "rejected"
                  : u.X === "CANCELED" || u.X === "EXPIRED"
                    ? "cancelled"
                    : null;
              if (closed !== null && !dec(u.z).gt(0)) {
                void engine
                  .onOrderClosed(id, u.c, closed, u.E, u.r ?? null)
                  .catch((error: unknown) => {
                    log.warn({ err: error }, "order close handling failed");
                  });
                continue;
              }
              if (!dec(u.z).gt(0)) continue;
              void engine
                .onFill(id, u.c, u.z, dec(u.v).div(u.z).toString(), u.n ?? "0", u.E)
                .catch((error: unknown) => {
                  log.warn({ err: error }, "fill handling failed");
                });
            }
          },
          onTrade: (trades) => {
            for (const tr of trades) {
              void engine
                .onTrade(id, {
                  tradeId: tr.t,
                  clOrdID: tr.c,
                  price: tr.p,
                  quantity: tr.q,
                  fee: tr.f,
                  builderFee: tr.bf ?? null,
                  isMaker: tr.m,
                  at: tr.T,
                })
                .catch((error: unknown) => {
                  log.warn({ err: error }, "trade handling failed");
                });
            }
          },
          onReconnect: () => {
            engine.onStreamGap(id);
            log.info(
              { accountId: id, kind },
              "user stream reconnected; unknown orders are reconciled by the loop",
            );
          },
          onError: (error) => {
            log.warn({ err: error.message, accountId: id }, "user stream error");
            // Một tin không đọc được có thể là fill: đối soát lệnh của account như khi stream đứt (DEC-118).
            if (error.message.includes("did not match schema")) engine.onStreamGap(id);
          },
        },
      });
    const list = [make("spot"), make("perps")];
    for (const s of list) s.connect();
    streams.set(id, list);
  }
}

const state = { running: true };
const loop = (async () => {
  while (state.running) {
    try {
      await engine.tick();
      await syncStreams();
    } catch (error) {
      log.error({ err: error }, "engine tick failed");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
})();

async function shutdown() {
  state.running = false;
  await loop;
  for (const list of streams.values()) for (const s of list) s.close();
  await engine.stop();
  await nc.drain();
  await pool.end();
  redis.disconnect();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
log.info("engine started");
