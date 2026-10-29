import { createDb } from "@drift/db";
import { loadClientTls } from "@drift/runtime";
import { RedisRateLimitStore, SignedWriteClient, SodexRestClient } from "@drift/sodex";
import { Redis } from "ioredis";
import { z } from "zod";

import { buildApp } from "./app";
import { loadApiConfig } from "./config";
import { smtpMailer } from "./lib/mailer";
import { httpRecoClient } from "./lib/reco-client";
import { httpSignerClient } from "./lib/signer-client";
import { redisRateLimiter } from "./plugins/rate-limit";

const config = loadApiConfig(process.env);
const { db, pool } = createDb(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
const rateLimit = new RedisRateLimitStore(redis);
const sodexOptions = { config: config.sodex, rateLimit, egressKey: config.SODEX_EGRESS_KEY };

const lastPrice = async (market: string) => {
  const raw = await redis.get(`md:last:${market}`);
  if (raw === null) return null;
  const parsed = z.object({ price: z.string(), at: z.number() }).safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
};

const prices = async (markets: readonly string[]) => {
  const keys = [...new Set(markets)];
  const out: Record<string, string> = {};
  if (keys.length === 0) return out;
  const raw = await redis.mget(...keys.map((m) => `md:last:${m}`));
  keys.forEach((m, i) => {
    const v = raw[i];
    if (v == null) return;
    const parsed = z.object({ price: z.string() }).safeParse(JSON.parse(v));
    if (parsed.success) out[m] = parsed.data.price;
  });
  return out;
};

const app = await buildApp({
  rateLimiter: redisRateLimiter(redis),
  rateLimits: {
    perIp: config.API_RATE_LIMIT_PER_IP,
    perUser: config.API_RATE_LIMIT_PER_USER,
    windowMs: 60_000,
  },
  volumeMakerEnabled: config.VOLUME_MAKER_ENABLED,
  lastPrice,
  prices,
  reco: httpRecoClient(config.RECO_URL),
  db,
  mailer: smtpMailer(config.SMTP_URL, config.MAIL_FROM),
  totpKey: Buffer.from(config.API_TOTP_ENC_KEY, "base64"),
  cookieSecure: config.API_COOKIE_SECURE,
  logLevel: config.LOG_LEVEL,
  sodex: {
    rest: new SodexRestClient(sodexOptions),
    writer: new SignedWriteClient(sodexOptions),
    signer: httpSignerClient(config.SIGNER_URL, loadClientTls(process.env, "SIGNER_CLIENT")),
    builderId: config.sodex.builderId,
    connectEnabled: config.SODEX_CONNECT_ENABLED,
  },
});

const shutdown = async () => {
  await app.close();
  await pool.end();
  redis.disconnect();
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

await app.listen({ host: "0.0.0.0", port: config.API_PORT });
