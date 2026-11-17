import { monitorEventLoopDelay } from "node:perf_hooks";

import { apiKeys, createDb } from "@drift/db";
import { loadClientTls } from "@drift/runtime";
import {
  dec,
  leaderFillMessageSchema,
  leaderPositionMessageSchema,
  mmBookMessageSchema,
  mmFairMessageSchema,
  type MmBookMessage,
} from "@drift/shared";
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

import { BookCoalescer } from "./book-coalescer";
import { Engine } from "./engine";
import type { AccountRef } from "./gateway";
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
    /**
     * Vòng tick chờ các shard tối đa chừng này; shard còn chờ SoDEX chạy tiếp ngoài vòng (DEC-308).
     */
    ENGINE_TICK_WAIT_MS: z.coerce.number().int().positive().default(2_000),
    /** Timeout mỗi lời gọi REST chỉ đọc của đối soát (tra lệnh, lịch sử khớp, vị thế). Lệnh ghi giữ timeout cũ. */
    ENGINE_SODEX_READ_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  })
  .parse(process.env);
const log = pino({
  level: env.LOG_LEVEL,
  base: { service: "engine", worker: env.ENGINE_WORKER_ID },
});
const sodex = loadSodexConfig(process.env);
// Các shard / account chạy song song dùng chung pool 10 kết nối: chờ kết nối có giới hạn, lỗi thì bước đó thử lại ở lượt
// sau thay vì treo (DEC-308).
const { db, pool } = createDb(env.DATABASE_URL, { connectionTimeoutMillis: 10_000 });
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
  // Cùng bucket rate limit IP (cùng store + egressKey), timeout ngắn hơn cho đọc của đối soát.
  new SodexRestClient({ ...options, timeoutMs: env.ENGINE_SODEX_READ_TIMEOUT_MS }),
);
// User stream cho từng account + engine mà bot thật trong shard của worker này giao dịch (account chỉ chạy Perps không mở
// stream Spot). Engine mở stream ngay khi nạp bot (trong vòng tick) và lệnh mở vị thế chỉ đi khi stream của engine đó
// đã được SoDEX nhận subscribe (DEC-303).
type StreamKind = "spot" | "perps";
const streams = new Map<string, Partial<Record<StreamKind, WsUserStream>>>();
/** Lần cuối ghi log error "subscribe rejected" theo `account:engine` (tối đa một lần mỗi 10 phút). */
const rejectLoggedAt = new Map<string, number>();
const REJECT_LOG_EVERY_MS = 600_000;
function openStream(account: AccountRef, kind: StreamKind): void {
  const id = account.id;
  const pair = streams.get(id) ?? {};
  if (pair[kind] !== undefined) return;
  const make = () =>
    new WsUserStream({
      baseUrl: sodex.wsUrl,
      engine: kind,
      user: account.address,
      accountID: account.sodexAccountId,
      callbacks: {
        onOrderUpdate: (updates) => {
          for (const u of updates) {
            // Lệnh kết thúc (FILLED / CANCELED / EXPIRED / REJECTED): ghi phần mới khớp trước, rồi báo chiến lược lệnh
            // đã xong đúng một lần, kể cả khi đã khớp một phần (P0.1). Chưa khớp gì thì cập nhật luôn, không để lệnh
            // kẹt "open" (DEC-122).
            const closed =
              u.X === "REJECTED"
                ? "rejected"
                : u.X === "CANCELED" || u.X === "EXPIRED"
                  ? "cancelled"
                  : u.X === "FILLED"
                    ? "filled"
                    : null;
            const filled = dec(u.z).gt(0);
            if (closed === null && !filled) continue;
            void (async () => {
              if (filled)
                await engine.onFill(id, u.c, u.z, dec(u.v).div(u.z).toString(), u.n ?? "0", u.E);
              if (closed !== null) await engine.onOrderClosed(id, u.c, closed, u.E, u.r ?? null);
            })().catch((error: unknown) => {
              log.warn({ err: error }, "order update handling failed");
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
          log.info({ accountId: id, kind }, "user stream reconnected");
        },
        // Khoảng trống chỉ khi subscribe XONG (lần đầu: bot có thể đã có lệnh từ worker trước / lệnh đóng gửi trước khi
        // stream sẵn sàng; các lần sau: stream đã subscribe bị đứt). Subscribe bị từ chối không phải khoảng trống.
        onSubscribed: () => {
          engine.onStreamGap(id, kind);
          log.info({ accountId: id, kind }, "user stream subscribed");
        },
        onError: (error) => {
          if (error.message.includes("rejected")) {
            // Lệnh mở vị thế trên engine này chờ tới khi subscribe lại được: lỗi thật, nhưng chỉ ghi mỗi 10 phút.
            const key = `${id}:${kind}`;
            const at = Date.now();
            if (at - (rejectLoggedAt.get(key) ?? 0) >= REJECT_LOG_EVERY_MS) {
              rejectLoggedAt.set(key, at);
              log.error(
                { err: error.message, accountId: id, kind },
                "user stream subscribe rejected",
              );
            }
          } else log.warn({ err: error.message, accountId: id }, "user stream error");
          // Một tin không đọc được có thể là fill: đối soát lệnh của account như khi stream đứt (DEC-118).
          if (error.message.includes("did not match schema")) engine.onStreamGap(id, kind);
        },
      },
    });
  const stream = make();
  stream.connect();
  streams.set(id, { ...pair, [kind]: stream });
  log.info({ accountId: id, kind }, "user stream connecting");
}
/** Đóng stream (account + engine) không còn bot cần; mở cái còn thiếu (đường dự phòng, engine đã mở trong tick). */
async function syncStreams() {
  const wanted = new Map((await engine.activeStreams()).map((a) => [a.account.id, a]));
  for (const [id, pair] of streams) {
    const want = wanted.get(id);
    const kept: Partial<Record<StreamKind, WsUserStream>> = {};
    for (const kind of ["spot", "perps"] as const) {
      const stream = pair[kind];
      if (stream === undefined) continue;
      if (want?.engines.has(kind) === true) kept[kind] = stream;
      else stream.close();
    }
    if (kept.spot === undefined && kept.perps === undefined) streams.delete(id);
    else streams.set(id, kept);
  }
  for (const { account, engines } of wanted.values())
    for (const kind of engines) openStream(account, kind);
}

// Độ trễ event loop (DEC-302): ghi kèm log `tick slow` và mỗi phút một dòng `event loop delay`.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
const loopDelayMs = () => ({
  p99Ms: Math.round(loopDelay.percentile(99) / 1e6),
  maxMs: Math.round(loopDelay.max / 1e6),
});
setInterval(() => {
  log.info({ ...loopDelayMs(), meanMs: Math.round(loopDelay.mean / 1e6) }, "event loop delay");
  loopDelay.reset();
}, 60_000).unref();
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
  tickWaitMs: env.ENGINE_TICK_WAIT_MS,
  loopDelay: loopDelayMs,
  rules: (market) => marketInfo(rest, market),
  builderId: sodex.builderId,
  builderExempt: sodex.builderExempt,
  userStreams: {
    open: openStream,
    ready: (accountId, kind) => streams.get(accountId)?.[kind]?.subscribed === true,
  },
  // Volume Farm (DEC-80): 10 mức mỗi phía, như apex `get_orderbook_depth(symbol, 10)`.
  // Rebalancing (Spot) cũng đọc đỉnh sổ lệnh để đặt IOC theo ask / bid.
  orderbook: async (market, engine = "perps") => {
    const b = await rest.getOrderbook(engine, market, 10);
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
// Giá Binance quy đổi cho Smart quoting của Market Making (marketdata publish).
const fairSub = nc.subscribe("md.*.fair");
void (async () => {
  for await (const m of fairSub) {
    try {
      await engine.onMmFair(mmFairMessageSchema.parse(m.json()), Date.now());
    } catch (error) {
      log.warn({ err: error }, "mm binance price handling failed");
    }
  }
})();
// Giá tốt nhất SoDEX thời gian thực (DEC-248, marketdata publish). Đóng dấu giờ nhận ngay lúc NATS giao tin.
// Volume Farm: chỉ lưu giá mới nhất trong bộ nhớ, đọc lúc bước chiến lược (DEC-298). Market Making: mỗi
// market xử lý tin mới nhất, tin cũ hơn đang chờ bị bỏ, các market chạy song song.
const mmBooks = new BookCoalescer<MmBookMessage>(
  (msg, recvAt) => engine.onMmBook(msg, recvAt),
  (error) => {
    log.warn({ err: error }, "mm sodex book handling failed");
  },
);
nc.subscribe("md.*.book", {
  callback: (err, m) => {
    const recvAt = Date.now();
    if (err !== null) {
      log.warn({ err }, "sodex book subscription failed");
      return;
    }
    try {
      const msg = mmBookMessageSchema.parse(m.json());
      engine.onFarmBook(msg, recvAt);
      if (msg.refresh !== true) mmBooks.push(msg.s, msg, recvAt);
    } catch (error) {
      log.warn({ err: error }, "sodex book message invalid");
    }
  },
});
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
  // Dừng engine trước (chặn mọi lệnh mới, chờ các shard đang chạy dở), rồi mới đóng user stream: fill của lệnh vừa gửi
  // vẫn tới qua stream; DB đóng sau cùng (review #216 M2).
  await engine.stop();
  for (const pair of streams.values()) {
    pair.spot?.close();
    pair.perps?.close();
  }
  await nc.drain();
  await pool.end();
  redis.disconnect();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
log.info("engine started");
