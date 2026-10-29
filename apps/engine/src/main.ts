import { apiKeys, createDb } from "@drift/db";
import { loadClientTls } from "@drift/runtime";
import { dec } from "@drift/shared";
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
    /** Chỉ bật khi có xác nhận bằng văn bản của SoDEX (VOLUME_MAKER.md mục 17.5). */
    VOLUME_MAKER_ENABLED: z.stringbool().default(false),
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
);
const engine = new Engine({
  db,
  redis,
  gateway,
  workerId: env.ENGINE_WORKER_ID,
  log,
  leaseTtlMs: env.ENGINE_SHARD_LEASE_TTL_MS,
  feeCheckMs: env.ENGINE_FEE_CHECK_MS,
  volumeMakerEnabled: env.VOLUME_MAKER_ENABLED,
  rules: (market) => marketInfo(rest, market),
});

const nc = await connect({ servers: env.NATS_URL });
const priceSub = nc.subscribe("md.*.price");
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
            log.info(
              { accountId: id, kind },
              "user stream reconnected; unknown orders are reconciled by the loop",
            );
          },
          onError: (error) => {
            log.warn({ err: error.message, accountId: id }, "user stream error");
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
