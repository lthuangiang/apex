import type { Db } from "@drift/db";
import { fastifyCookie as cookie } from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";

import { registerErrorHandler } from "./lib/http";
import type { Mailer } from "./lib/mailer";
import type { RecoClient } from "./lib/reco-client";
import { registerAccountRoutes } from "./modules/account/routes";
import { registerAuthRoutes } from "./modules/auth/routes";
import { registerBacktestRoutes } from "./modules/backtests/routes";
import { registerBotRoutes } from "./modules/bots/routes";
import { registerDataRoutes } from "./modules/data/routes";
import { registerProfileRoutes } from "./modules/profile/routes";
import { registerRecoRoutes } from "./modules/reco/routes";
import { registerSodexRoutes } from "./modules/sodex/routes";
import type { SodexDeps } from "./modules/sodex/service";
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
  sodex: Pick<SodexDeps, "rest" | "writer" | "signer" | "builderId" | "connectEnabled">;
  /** Giá gần nhất (Redis `md:last:<market>`, do marketdata ghi). */
  lastPrice: (market: string) => Promise<{ price: string; at: number } | null>;
  reco: RecoClient;
  /** Giá gần nhất của nhiều market (Redis `md:last:*`). */
  prices: (markets: readonly string[]) => Promise<Record<string, string>>;
  rateLimiter: RateLimiter;
  volumeMakerEnabled?: boolean;
  /** Ghi đè giới hạn (test). */
  rateLimits?: { perIp: number; perUser: number; windowMs: number };
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
  const volumeMakerEnabled = deps.volumeMakerEnabled === true;
  app.get("/api/v1/features", () => ({ volumeMaker: volumeMakerEnabled }));
  registerBotRoutes(app, {
    db: deps.db,
    totpKey: deps.totpKey,
    now,
    rest: deps.sodex.rest,
    builderId: deps.sodex.builderId,
    lastPrice: deps.lastPrice,
    prices: deps.prices,
    volumeMakerEnabled,
    verifyApiKey: (id: string) => deps.sodex.signer.verifyApiKey(id),
  });
  registerBacktestRoutes(app, { db: deps.db, now, volumeMakerEnabled });
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
  });
  registerRecoRoutes(app, { db: deps.db, reco: deps.reco, rest: deps.sodex.rest, now });
  registerSodexRoutes(app, { ...deps.sodex, db: deps.db, totpKey: deps.totpKey, now });
  return app;
}
