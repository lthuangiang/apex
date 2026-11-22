import {
  newsBotCreateBodySchema,
  newsBotParamsSchema,
  newsTpslBodySchema,
  newsTradeParamsSchema,
} from "@drift/shared";
import type { FastifyInstance } from "fastify";

import { parseOrThrow } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { requireAuth } from "../../plugins/session";
import { researchViewer } from "../signal-research/routes";

import {
  assertNewsBotsEnabled,
  createNewsBot,
  listNewsBots,
  listNewsBotSignals,
  listNewsTrades,
  queueNewsCommand,
  type NewsBotDeps,
} from "./service";

// REST bot `news_signal` mainnet (#420). Quyền: team HOẶC `users.signal_research` (`researchViewer`, 403), kiểm trước khi
// parse và trước Idempotency-Key; bot / trade của người khác → 404. Tạo bot kiểm cờ `SIGNAL_NEWS_BOTS_ENABLED` trước cả
// quyền (409 cho mọi người khi tắt). Close now không cần quyền Signal Research: chỉ giảm rủi ro, chủ bot luôn đóng được
// (như Stop / Pause ở route chung). Start / Pause / Resume / Stop: `/api/v1/bots/:id/actions/*`.

const base = "/api/v1/signal-research/bots";

export function registerNewsBotRoutes(app: FastifyInstance, deps: NewsBotDeps): void {
  const { db } = deps;

  app.post(base, async (request, reply) => {
    const auth = requireAuth(request);
    assertNewsBotsEnabled(deps);
    const viewer = await researchViewer(db, auth.userId);
    return idempotent(db, request, reply, auth.userId, deps.now(), async () => {
      const body = parseOrThrow(newsBotCreateBodySchema, request.body);
      return { status: 201, body: await createNewsBot(deps, viewer, body, request.ip) };
    });
  });

  app.get(base, async (request) => {
    const auth = requireAuth(request);
    await researchViewer(db, auth.userId);
    return { items: await listNewsBots(deps, auth.userId) };
  });

  app.get(`${base}/:id/trades`, async (request) => {
    const auth = requireAuth(request);
    await researchViewer(db, auth.userId);
    const { id } = parseOrThrow(newsBotParamsSchema, request.params);
    return { items: await listNewsTrades(deps, auth.userId, id) };
  });

  app.get(`${base}/:id/signals`, async (request) => {
    const auth = requireAuth(request);
    await researchViewer(db, auth.userId);
    const { id } = parseOrThrow(newsBotParamsSchema, request.params);
    return { items: await listNewsBotSignals(deps, auth.userId, id) };
  });

  app.post(`${base}/:id/trades/:tradeId/close`, async (request, reply) => {
    const auth = requireAuth(request);
    const { id, tradeId } = parseOrThrow(newsTradeParamsSchema, request.params);
    return idempotent(db, request, reply, auth.userId, deps.now(), async () => ({
      status: 202,
      body: await queueNewsCommand(deps, auth.userId, id, tradeId, "close", null, request.ip),
    }));
  });

  app.post(`${base}/:id/trades/:tradeId/tpsl`, async (request, reply) => {
    const auth = requireAuth(request);
    await researchViewer(db, auth.userId);
    const { id, tradeId } = parseOrThrow(newsTradeParamsSchema, request.params);
    return idempotent(db, request, reply, auth.userId, deps.now(), async () => {
      const body = parseOrThrow(newsTpslBodySchema, request.body);
      return {
        status: 202,
        body: await queueNewsCommand(deps, auth.userId, id, tradeId, "edit_tpsl", body, request.ip),
      };
    });
  });
}
