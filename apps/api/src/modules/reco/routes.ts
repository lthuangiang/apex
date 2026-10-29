import { aiParamsBodySchema, goalsBodySchema } from "@drift/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { parseOrThrow } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { requireAuth } from "../../plugins/session";

import {
  aiParams,
  assetOptions,
  getGoals,
  getSuggestion,
  plan,
  saveGoals,
  type RecoDeps,
} from "./service";

export function registerRecoRoutes(app: FastifyInstance, deps: RecoDeps): void {
  app.get("/api/v1/goals", async (request) => ({
    goals: await getGoals(deps, requireAuth(request).userId),
  }));
  app.get("/api/v1/goals/options", async (request) =>
    assetOptions(deps, requireAuth(request).userId),
  );

  app.put("/api/v1/goals", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(goalsBodySchema, request.body);
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => ({
      status: 200,
      body: await saveGoals(deps, auth.userId, body),
    }));
  });

  // Tính lại kế hoạch là thao tác ghi (lưu ai_suggestions) nên dùng POST + Idempotency-Key.
  app.post("/api/v1/reco/plan", async (request, reply) => {
    const auth = requireAuth(request);
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => ({
      status: 200,
      body: await plan(deps, auth.userId),
    }));
  });

  app.get("/api/v1/reco/suggestions/:id", async (request) => {
    const { id } = parseOrThrow(z.object({ id: z.uuid() }), request.params);
    return getSuggestion(deps, requireAuth(request).userId, id);
  });

  app.post("/api/v1/reco/params", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(aiParamsBodySchema, request.body);
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => ({
      status: 200,
      body: { suggestion: await aiParams(deps, auth.userId, body) },
    }));
  });
}
