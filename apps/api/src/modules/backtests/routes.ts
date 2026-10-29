import { startBacktestBodySchema } from "@drift/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { parseOrThrow } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { requireAuth } from "../../plugins/session";

import { getBacktest, startBacktest, type BacktestDeps } from "./service";

export function registerBacktestRoutes(app: FastifyInstance, deps: BacktestDeps): void {
  app.post("/api/v1/backtests", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(startBacktestBodySchema, request.body);
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => ({
      status: 202,
      body: await startBacktest(deps, auth.userId, body),
    }));
  });
  app.get("/api/v1/backtests/:id", async (request) => {
    const { id } = parseOrThrow(z.object({ id: z.uuid() }), request.params);
    return getBacktest(deps, requireAuth(request).userId, id);
  });
}
