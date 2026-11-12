import {
  copyRequestSchema,
  copyStartSchema,
  traderAddressSchema,
  traderListQuerySchema,
} from "@drift/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { parseOrThrow } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { requireAuth } from "../../plugins/session";

import {
  copyPreview,
  follow,
  following,
  listTraders,
  startCopy,
  traderProfile,
  unfollow,
  type CopyDeps,
} from "./service";

const addressParams = z.object({ address: traderAddressSchema });

// Copy Trading v1 (DEC-163, SCREENS.md 8.x; route [confirm] OPEN_QUESTIONS 21b). Cần AI Desk; ghi qua Idempotency-Key.
export function registerCopyRoutes(app: FastifyInstance, deps: CopyDeps): void {
  app.get("/api/v1/traders", async (request) => {
    const { tab } = parseOrThrow(traderListQuerySchema, request.query);
    return listTraders(deps, requireAuth(request).userId, tab);
  });

  app.get("/api/v1/traders/:address", async (request) => {
    const { address } = parseOrThrow(addressParams, request.params);
    return traderProfile(deps, requireAuth(request).userId, address);
  });

  app.post("/api/v1/traders/:address/follow", async (request, reply) => {
    const auth = requireAuth(request);
    const { address } = parseOrThrow(addressParams, request.params);
    return idempotent(deps.bots.db, request, reply, auth.userId, deps.bots.now(), async () => ({
      status: 200,
      body: await follow(deps, auth.userId, address),
    }));
  });

  app.delete("/api/v1/traders/:address/follow", async (request, reply) => {
    const auth = requireAuth(request);
    const { address } = parseOrThrow(addressParams, request.params);
    return idempotent(deps.bots.db, request, reply, auth.userId, deps.bots.now(), async () => ({
      status: 200,
      body: await unfollow(deps, auth.userId, address),
    }));
  });

  app.get("/api/v1/following", async (request) => following(deps, requireAuth(request).userId));

  // Chỉ tính, không ghi: không cần Idempotency-Key.
  app.post("/api/v1/copy/preview", async (request) => {
    const body = parseOrThrow(copyRequestSchema, request.body);
    return copyPreview(deps, requireAuth(request).userId, body);
  });

  app.post("/api/v1/copy", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(copyStartSchema, request.body);
    return idempotent(
      deps.bots.db,
      request,
      reply,
      auth.userId,
      deps.bots.now(),
      async () => ({
        status: 201,
        body: await startCopy(deps, auth.userId, body, request.ip, auth.sessionId),
      }),
      { sensitive: true },
    );
  });
}
