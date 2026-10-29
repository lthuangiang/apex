import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";

import { createDb, runMigrations, sessions, sodexAccounts, users, type Db } from "@drift/db";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { startRealtime } from "../src/server";

let pg: StartedPostgreSqlContainer;
let natsC: StartedTestContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];
let nc: NatsConnection;
let server: Server;
const PORT = 18181;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  natsC = await new GenericContainer("nats:2.10-alpine")
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage("Server is ready"))
    .start();
  await runMigrations(pg.getConnectionUri());
  ({ db, pool } = createDb(pg.getConnectionUri()));
  nc = await connect({ servers: `nats://${natsC.getHost()}:${String(natsC.getMappedPort(4222))}` });
  server = await startRealtime({ db, nc, port: PORT });
});
afterAll(async () => {
  server.close();
  await nc.drain();
  await pool.end();
  await Promise.all([pg.stop(), natsC.stop()]);
});

async function sessionFor(email: string) {
  const [user] = await db.insert(users).values({ email }).returning();
  const [account] = await db
    .insert(sodexAccounts)
    .values({
      userId: user?.id ?? "",
      address: "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db",
      sodexAccountId: BigInt(Math.floor(Math.random() * 1e9)),
      network: "mainnet",
      status: "connected",
    })
    .returning();
  const token = randomBytes(16).toString("hex");
  const far = new Date(Date.now() + 86_400_000);
  await db.insert(sessions).values({
    userId: user?.id ?? "",
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: far,
    absoluteExpiresAt: far,
  });
  return { token, accountId: account?.id ?? "" };
}

function open(token?: string) {
  return new WebSocket(`ws://127.0.0.1:${String(PORT)}/ws`, {
    headers: token === undefined ? {} : { cookie: `drift_session=${token}` },
  });
}

describe("realtime", () => {
  it("rejects connections without a valid session", async () => {
    const ws = open("nope");
    const code = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
      });
    });
    expect(code).toBe(401);
  });

  it("pushes only the user's own account events", async () => {
    const mine = await sessionFor("mine@x.test");
    const other = await sessionFor("other@x.test");
    const ws = open(mine.token);
    const received: string[] = [];
    await new Promise<void>((resolve) => {
      ws.on("message", (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as { subject: string };
        received.push(msg.subject);
        if (msg.subject === "realtime.ready") {
          nc.publish(`user.${other.accountId}.bot`, JSON.stringify({ botId: "x" }));
          nc.publish(
            `user.${mine.accountId}.bot`,
            JSON.stringify({ botId: "y", state: "running" }),
          );
        }
        if (msg.subject.startsWith("user.")) resolve();
      });
    });
    ws.close();
    expect(received).toEqual(["realtime.ready", `user.${mine.accountId}.bot`]);
  });
});
