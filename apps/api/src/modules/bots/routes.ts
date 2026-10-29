import {
  botActionBodySchema,
  createBotBodySchema,
  dryRunChecksBodySchema,
  newVersionBodySchema,
} from "@drift/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { parseOrThrow } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { requireAuth } from "../../plugins/session";

import {
  botDetail,
  createBot,
  listBots,
  listOrders,
  newVersion,
  pauseBot,
  resumeBot,
  startBot,
  dryRunChecks,
  startChecks,
  stopBot,
  type BotDeps,
} from "./service";

const idParams = z.object({ id: z.uuid() });

// REST bot (CODING_STANDARDS C7): hành động trạng thái là POST /bots/:id/actions/<action>, trả 202 kèm
// trạng thái chuyển tiếp; mọi request ghi bắt buộc Idempotency-Key.
export function registerBotRoutes(app: FastifyInstance, deps: BotDeps): void {
  const { db } = deps;
  const run = (status: number, work: () => Promise<unknown>) => async () => ({
    status,
    body: await work(),
  });

  app.get("/api/v1/bots", async (request) => ({
    items: await listBots(deps, requireAuth(request).userId),
  }));

  app.post("/api/v1/bots", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(createBotBodySchema, request.body);
    return idempotent(
      db,
      request,
      reply,
      auth.userId,
      deps.now(),
      run(201, () => createBot(deps, auth.userId, body, request.ip)),
    );
  });

  app.get("/api/v1/bots/:id", async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    return botDetail(deps, requireAuth(request).userId, id);
  });

  // Dry run cho form chưa lưu (UI_REVIEW H2). POST vì gửi config; không đổi trạng thái nên không cần Idempotency-Key.
  app.post("/api/v1/bots/checks", async (request) => {
    const body = parseOrThrow(dryRunChecksBodySchema, request.body);
    return dryRunChecks(deps, requireAuth(request).userId, body);
  });

  app.get("/api/v1/bots/:id/checks", async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    return startChecks(deps, requireAuth(request).userId, id);
  });

  app.post("/api/v1/bots/:id/versions", async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parseOrThrow(idParams, request.params);
    const body = parseOrThrow(newVersionBodySchema, request.body);
    return idempotent(
      db,
      request,
      reply,
      auth.userId,
      deps.now(),
      run(202, () => newVersion(deps, auth.userId, id, body)),
    );
  });

  app.post("/api/v1/bots/:id/actions/:action", async (request, reply) => {
    const auth = requireAuth(request);
    const { id, action } = parseOrThrow(
      z.object({ id: z.uuid(), action: z.enum(["start", "pause", "resume", "stop"]) }),
      request.params,
    );
    const body = parseOrThrow(botActionBodySchema, request.body ?? {});
    const work = () => {
      switch (action) {
        case "start":
          return startBot(deps, auth.userId, id, body, request.ip);
        case "pause":
          return pauseBot(deps, auth.userId, id);
        case "resume":
          return resumeBot(deps, auth.userId, id);
        case "stop":
          return stopBot(deps, auth.userId, id, body.twoFactorCode, request.ip);
      }
    };
    return idempotent(db, request, reply, auth.userId, deps.now(), run(202, work));
  });

  app.get("/api/v1/markets", async (request) => {
    requireAuth(request);
    const [spot, perps] = await Promise.all([
      deps.rest.getSpotSymbols(),
      deps.rest.getPerpsSymbols(),
    ]);
    // Một lần MGET cho cả danh sách (ô chọn market hiện giá gần nhất, UI_REVIEW G6).
    const last = await deps.prices([...spot, ...perps].map((m) => m.name));
    return {
      items: [
        ...spot.map((m) => ({
          name: m.name,
          engine: "spot" as const,
          displayName: m.displayName ?? m.name,
          base: m.baseCoin,
          quote: m.quoteCoin,
          tickSize: m.tickSize,
          stepSize: m.stepSize,
          trading: m.status === "TRADING",
          minNotional: m.minNotional,
          maxLeverage: null,
          last: last[m.name] ?? null,
        })),
        ...perps.map((m) => ({
          name: m.name,
          engine: "perps" as const,
          displayName: m.displayName ?? m.name,
          base: m.baseCoin ?? null,
          quote: m.quoteCoin ?? null,
          tickSize: m.tickSize,
          stepSize: m.stepSize,
          trading: m.status === "TRADING",
          minNotional: m.minNotional,
          maxLeverage: m.maxLeverage,
          last: last[m.name] ?? null,
        })),
      ],
    };
  });

  // Giá gần nhất cho Preview của màn Create (đường "Last" và các ô chỉ số tính theo giá).
  app.get("/api/v1/markets/:market/last", async (request) => {
    requireAuth(request);
    const { market } = parseOrThrow(
      z.object({ market: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }),
      request.params,
    );
    const last = await deps.lastPrice(market);
    return { market, price: last?.price ?? null, at: last?.at ?? null };
  });

  app.get("/api/v1/orders", async (request) => {
    const { botId } = parseOrThrow(z.object({ botId: z.uuid().optional() }), request.query);
    return { items: await listOrders(deps, requireAuth(request).userId, botId) };
  });
}
