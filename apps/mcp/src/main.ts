import { Redis } from "ioredis";
import pino from "pino";
import { z } from "zod";

import { httpApiClient, type ApiClient } from "./api-client";
import { redisCounter } from "./rate-limit";
import { buildMcpApp } from "./server";
import { TOOLS } from "./tools";

// DeskLabs MCP (docs/MCP.md, DEC-167). Không trạng thái, tăng replica được. Chỉ gọi api; không chạm signer, engine,
// SoDEX hay database. `MCP_INTROSPECT_SECRET` không bao giờ log.
const env = z
  .object({
    MCP_PORT: z.coerce.number().int().positive().default(8097),
    API_INTERNAL_URL: z.url().default("http://api:8080"),
    MCP_PUBLIC_URL: z.url().default("https://mcp.desklabs.xyz"),
    DRIFT_APP_URL: z.url().default("https://desklabs.xyz"),
    // Trống = MCP tắt: chỉ /healthz và metadata trả lời, mọi lần gọi /mcp nhận 503 (không crash-loop trên VPS).
    MCP_INTROSPECT_SECRET: z.union([z.literal(""), z.string().min(32)]).default(""),
    REDIS_URL: z.string().min(1),
    LOG_LEVEL: z.string().default("info"),
  })
  .parse(process.env);
const log = pino({ level: env.LOG_LEVEL, base: { service: "mcp" } });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const disabled: ApiClient = {
  introspect: () => Promise.reject(new Error("MCP_INTROSPECT_SECRET is not set")),
  recordCall: () => Promise.resolve(),
  get: () => Promise.reject(new Error("MCP_INTROSPECT_SECRET is not set")),
  post: () => Promise.reject(new Error("MCP_INTROSPECT_SECRET is not set")),
  stepUp: () => Promise.resolve(),
};
const app = buildMcpApp({
  api:
    env.MCP_INTROSPECT_SECRET === ""
      ? disabled
      : httpApiClient(env.API_INTERNAL_URL, env.MCP_INTROSPECT_SECRET),
  counter: redisCounter(redis),
  publicUrl: env.MCP_PUBLIC_URL,
  issuer: env.DRIFT_APP_URL,
  tools: TOOLS,
  logLevel: env.LOG_LEVEL,
});
if (env.MCP_INTROSPECT_SECRET === "") log.warn("MCP_INTROSPECT_SECRET is empty: MCP is disabled");
log.info({ port: env.MCP_PORT }, "mcp listening");
await app.listen({ host: "0.0.0.0", port: env.MCP_PORT });

async function shutdown() {
  await app.close();
  redis.disconnect();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
