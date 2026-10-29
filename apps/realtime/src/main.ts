import { createDb } from "@drift/db";
import { connect } from "@nats-io/transport-node";
import pino from "pino";
import { z } from "zod";

import { startRealtime } from "./server";

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    NATS_URL: z.string().min(1),
    REALTIME_PORT: z.coerce.number().int().default(8081),
    LOG_LEVEL: z.string().default("info"),
  })
  .parse(process.env);
const log = pino({ level: env.LOG_LEVEL, base: { service: "realtime" } });
const { db, pool } = createDb(env.DATABASE_URL);
const nc = await connect({ servers: env.NATS_URL });
const server = await startRealtime({ db, nc, port: env.REALTIME_PORT });
log.info({ port: env.REALTIME_PORT }, "realtime started");

async function shutdown() {
  server.close();
  await nc.drain();
  await pool.end();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
