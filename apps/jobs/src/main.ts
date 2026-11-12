import { createDb } from "@drift/db";
import {
  consume,
  createBotApi,
  ensureConsumer,
  ensureStreams,
  isQueueSubject,
} from "@drift/runtime";
import { loadSodexConfig, RedisRateLimitStore, SodexRestClient } from "@drift/sodex";
import { connect } from "@nats-io/transport-node";
import { Redis } from "ioredis";
import nodemailer from "nodemailer";
import pino from "pino";
import { z } from "zod";

import { runImport } from "./import";
import { handleNotify } from "./notify";
import { relayOnce } from "./outbox";
import {
  handleTelegram,
  markFailed,
  TELEGRAM_ALERT_SUBJECT,
  TELEGRAM_MAX_DELIVER,
  TELEGRAM_SUBJECT,
} from "./telegram";

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    NATS_URL: z.string().min(1),
    LOG_LEVEL: z.string().default("info"),
    /** Email thông báo; trống thì chỉ có in-app. */
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().optional(),
    SODEX_EGRESS_KEY: z.string().default("default"),
    /** Kênh Telegram (DEC-170). Bật mà thiếu token thì không khởi động. */
    TELEGRAM_ENABLED: z.stringbool().default(false),
    DRIFT_TELEGRAM_BOT_TOKEN: z.string().optional(),
    /** Gốc URL web app cho nút trong tin Telegram (không chứa token đăng nhập). */
    DRIFT_APP_URL: z.url().default("https://desklabs.xyz"),
  })
  .refine((e) => !e.TELEGRAM_ENABLED || (e.DRIFT_TELEGRAM_BOT_TOKEN ?? "").length >= 20, {
    message: "TELEGRAM_ENABLED=true needs DRIFT_TELEGRAM_BOT_TOKEN",
  })
  .parse(process.env);
const log = pino({ level: env.LOG_LEVEL, base: { service: "jobs" } });
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
const js = await ensureStreams(nc);
await ensureConsumer(nc, "jobs-import", "jobs.import");

await ensureConsumer(nc, "jobs-notify", "jobs.notify");
// SMTP_URL=log (DEC-75): api in mã đăng nhập ra log; thông báo của jobs chỉ còn trong app, không gửi email.
const transport =
  env.SMTP_URL === undefined || env.SMTP_URL === "" || env.SMTP_URL === "log"
    ? null
    : nodemailer.createTransport(env.SMTP_URL);
const sendEmail =
  transport === null || env.MAIL_FROM === undefined
    ? null
    : async (to: string, subject: string, text: string) => {
        await transport.sendMail({ from: env.MAIL_FROM, to, subject, text });
      };
const stopNotify = await consume(
  js,
  "jobs-notify",
  "jobs.notify",
  (payload) => handleNotify({ db, sendEmail, telegramEnabled: env.TELEGRAM_ENABLED }, payload),
  (msg, extra) => {
    log.warn(extra, msg);
  },
);

// Worker gửi Telegram (docs/NOTIFICATIONS.md mục 6): hàng ưu tiên cho Bot problems và hàng thường.
const telegramStops: (() => Promise<void>)[] = [];
if (env.TELEGRAM_ENABLED) {
  const telegramDeps = {
    db,
    counter: {
      async incr(key: string, ttlMs: number) {
        const res = await redis.multi().incr(key).pexpire(key, ttlMs, "NX").exec();
        return Number(res?.[0]?.[1] ?? 0);
      },
    },
    botApi: createBotApi({ token: env.DRIFT_TELEGRAM_BOT_TOKEN ?? "" }),
    appUrl: env.DRIFT_APP_URL,
    now: () => new Date(),
    warn: (msg: string, data: Record<string, unknown>) => {
      log.warn(data, msg);
    },
  };
  for (const [name, subject, urgent] of [
    ["jobs-telegram-alert", TELEGRAM_ALERT_SUBJECT, true],
    ["jobs-telegram", TELEGRAM_SUBJECT, false],
  ] as const) {
    await ensureConsumer(nc, name, subject, { maxDeliver: TELEGRAM_MAX_DELIVER });
    telegramStops.push(
      await consume(
        js,
        name,
        subject,
        (payload) => handleTelegram(telegramDeps, payload, urgent),
        (msg, extra) => {
          log.warn(extra, msg);
        },
        { maxDeliver: TELEGRAM_MAX_DELIVER, onDeadLetter: (payload) => markFailed(db, payload) },
      ),
    );
  }
}

const importSchema = z.object({ importId: z.uuid() });
const stopImport = await consume(
  js,
  "jobs-import",
  "jobs.import",
  async (payload) =>
    runImport({ db, rest, now: () => new Date() }, importSchema.parse(payload).importId),
  (msg, extra) => {
    log.warn(extra, msg);
  },
);

const state = { running: true };
const relay = (async () => {
  while (state.running) {
    try {
      const n = await relayOnce(db, async (topic, payload, msgId) => {
        // jobs.* và backtest.run đi qua JetStream (work queue); sự kiện cho người dùng (user.*) là NATS thường cho realtime.
        if (isQueueSubject(topic))
          await js.publish(topic, JSON.stringify(payload), { msgID: msgId });
        else nc.publish(topic, JSON.stringify(payload));
      });
      if (n === 0) await new Promise((r) => setTimeout(r, 500));
    } catch (error) {
      log.error({ err: error }, "outbox relay failed");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
})();

async function shutdown() {
  state.running = false;
  await stopImport();
  await stopNotify();
  for (const stop of telegramStops) await stop();
  await relay;
  await nc.drain();
  await pool.end();
  redis.disconnect();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
log.info("jobs started");
