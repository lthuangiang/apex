import type { Db } from "@drift/db";
import type { BotApi } from "@drift/runtime";
import { fastifyCookie as cookie } from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";

import { registerErrorHandler } from "./lib/http";
import type { Mailer } from "./lib/mailer";
import type { RecoClient } from "./lib/reco-client";
import { builderFeesOf } from "./modules/account/builder-fees";
import { registerAccountRoutes } from "./modules/account/routes";
import { registerAuthRoutes } from "./modules/auth/routes";
import { registerBacktestRoutes } from "./modules/backtests/routes";
import { registerBotRoutes } from "./modules/bots/routes";
import { aiDeskOn, listBots, volumeBotsOn } from "./modules/bots/service";
import { registerChartRoutes } from "./modules/chart/routes";
import { createChartService, type LiquidationProvider } from "./modules/chart/service";
import { registerCopyRoutes } from "./modules/copy/routes";
import { registerDataRoutes } from "./modules/data/routes";
import type { DeskLlm } from "./modules/desk/llm";
import { registerDeskRoutes } from "./modules/desk/routes";
import { registerProfileRoutes } from "./modules/profile/routes";
import { registerPublicRoutes } from "./modules/public/routes";
import { registerRecoRoutes } from "./modules/reco/routes";
import { registerSodexRoutes } from "./modules/sodex/routes";
import type { SodexDeps } from "./modules/sodex/service";
import { registerTelegramRoutes } from "./modules/telegram/routes";
import { registerPlainDecimals } from "./plugins/plain-decimals";
import { registerRateLimit, type RateLimiter } from "./plugins/rate-limit";
import { registerSession } from "./plugins/session";

// Danh sách redact cố định (CODING_STANDARDS C11). Có test đảm bảo không lộ.
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  "*.privateKey",
  "*.secret",
  "*.signature",
  "*.apiKey",
  "*.seed",
  "*.mnemonic",
  "*.code",
  "*.twoFactorCode",
];

export interface AppDeps {
  db: Db;
  mailer: Mailer;
  totpKey: Buffer;
  cookieSecure: boolean;
  logLevel: string;
  now?: () => Date;
  /** Thay stream log trong test. */
  logStream?: NodeJS.WritableStream;
  sodex: Pick<
    SodexDeps,
    "rest" | "writer" | "signer" | "builderId" | "builderExempt" | "connectEnabled"
  >;
  /** Giá gần nhất (Redis `md:last:<market>`, do marketdata ghi). */
  lastPrice: (market: string) => Promise<{ price: string; at: number } | null>;
  reco: RecoClient;
  /** Giá gần nhất của nhiều market (Redis `md:last:*`). */
  prices: (markets: readonly string[]) => Promise<Record<string, string>>;
  rateLimiter: RateLimiter;
  /** Nhà cung cấp bản đồ thanh lý (IMP-05). Không có / null: tab Liquidation map ẩn. */
  liquidations?: LiquidationProvider | null;
  /** Ghi đè giới hạn (test). */
  rateLimits?: { perIp: number; perUser: number; windowMs: number };
  /** Copy Trading: ngưỡng USD cảnh báo big move; trống = tắt (DEC-163, OPEN_QUESTIONS 21a). */
  copyBigMoveMinUsd?: string | null;
  /** Kênh Telegram (DEC-170). Không truyền = tắt: mọi route `/api/v1/telegram/*` trả 404. */
  telegram?: {
    enabled: boolean;
    botUsername: string;
    webhookSecret: string | null;
    appUrl: string;
    botApi: BotApi;
  };
  /** Desk AI (DEC-165): null = LLM tắt, trả lời bằng câu mẫu. */
  deskLlm?: DeskLlm | null;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const now = deps.now ?? (() => new Date());
  const app = Fastify({
    logger: {
      level: deps.logLevel,
      base: { service: "api" },
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      ...(deps.logStream === undefined ? {} : { stream: deps.logStream }),
    },
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });
  await app.register(cookie);
  registerErrorHandler(app);
  registerPlainDecimals(app);
  app.get("/healthz", () => ({ status: "ok" }));
  registerSession(app, { db: deps.db, cookieSecure: deps.cookieSecure, now });
  registerRateLimit(app, deps.rateLimiter, deps.rateLimits);
  registerAuthRoutes(app, {
    deps: { db: deps.db, mailer: deps.mailer, totpKey: deps.totpKey, now },
    cookieSecure: deps.cookieSecure,
  });
  registerDataRoutes(app, { db: deps.db, now });
  // Tính năng của người đang đăng nhập: bot khối lượng do admin bật ở Users (DEC-80). Chưa đăng nhập → tắt.
  app.get("/api/v1/features", async (request) => {
    const on = request.auth === null ? false : await volumeBotsOn(deps.db, request.auth.userId);
    const desk = request.auth === null ? false : await aiDeskOn(deps.db, request.auth.userId);
    // Builder fee hiệu lực của user (DEC-159); chưa đăng nhập → bảng mặc định.
    const builderFees =
      request.auth === null ? {} : await builderFeesOf(deps.db, request.auth.userId);
    return { volumeMaker: on, volumeFarm: on, aiDesk: desk, builderFees };
  });
  registerBotRoutes(app, {
    db: deps.db,
    totpKey: deps.totpKey,
    now,
    rest: deps.sodex.rest,
    builderId: deps.sodex.builderId,
    builderExempt: deps.sodex.builderExempt,
    lastPrice: deps.lastPrice,
    prices: deps.prices,
    verifyApiKey: (id: string) => deps.sodex.signer.verifyApiKey(id),
  });
  const chart = createChartService({
    rest: deps.sodex.rest,
    liquidations: deps.liquidations ?? null,
    now,
  });
  registerChartRoutes(app, chart);
  registerPublicRoutes(app, { db: deps.db, now, orderbook: (m) => chart.orderbook(m) });
  registerBacktestRoutes(app, { db: deps.db, now });
  registerProfileRoutes(app, {
    db: deps.db,
    totpKey: deps.totpKey,
    now,
    cookieSecure: deps.cookieSecure,
  });
  const botDeps = {
    db: deps.db,
    totpKey: deps.totpKey,
    now,
    rest: deps.sodex.rest,
    builderId: deps.sodex.builderId,
    builderExempt: deps.sodex.builderExempt,
    lastPrice: deps.lastPrice,
    prices: deps.prices,
    verifyApiKey: (id: string) => deps.sodex.signer.verifyApiKey(id),
  };
  registerAccountRoutes(app, {
    db: deps.db,
    totpKey: deps.totpKey,
    now,
    rest: deps.sodex.rest,
    prices: deps.prices,
    bots: botDeps,
    builderId: deps.sodex.builderId,
    builderExempt: deps.sodex.builderExempt,
  });
  const recoDeps = { db: deps.db, reco: deps.reco, rest: deps.sodex.rest, now };
  registerRecoRoutes(app, recoDeps);
  registerDeskRoutes(app, { bots: botDeps, reco: recoDeps, llm: deps.deskLlm ?? null });
  registerCopyRoutes(app, { bots: botDeps, bigMoveMinUsd: deps.copyBigMoveMinUsd ?? null });
  registerSodexRoutes(app, { ...deps.sodex, db: deps.db, totpKey: deps.totpKey, now });
  const tg = deps.telegram;
  registerTelegramRoutes(app, {
    enabled: tg?.enabled ?? false,
    webhookSecret: tg?.webhookSecret ?? null,
    deps: {
      db: deps.db,
      now,
      botUsername: tg?.botUsername ?? "desklabsbot",
      appUrl: tg?.appUrl ?? "https://desklabs.xyz",
      botApi: tg?.botApi ?? { sendMessage: () => Promise.resolve({ ok: true }) },
      rateLimiter: deps.rateLimiter,
      listBots: (userId) => listBots(botDeps, userId),
      warn: (msg, data) => {
        app.log.warn(data, msg);
      },
    },
  });
  return app;
}
