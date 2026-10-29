import { createDb } from "@drift/db";
import { consume, ensureConsumer, ensureStreams, isQueueSubject } from "@drift/runtime";
import { loadSodexConfig, RedisRateLimitStore, SodexRestClient } from "@drift/sodex";
import { connect } from "@nats-io/transport-node";
import { Redis } from "ioredis";
import nodemailer from "nodemailer";
import pino from "pino";
import { z } from "zod";

import { runImport } from "./import";
import { handleNotify } from "./notify";
import { relayOnce } from "./outbox";

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
  (payload) => handleNotify({ db, sendEmail }, payload),
  (msg, extra) => {
    log.warn(extra, msg);
  },
);

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
  await relay;
  await nc.drain();
  await pool.end();
  redis.disconnect();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
log.info("jobs started");
