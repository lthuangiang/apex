import { startPaperBodySchema } from "@drift/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { parseOrThrow } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { requireAuth } from "../../plugins/session";

import { deskBots, goLive, paperView, startPaper, type DeskDeps } from "./service";

const idParams = z.object({ id: z.uuid() });

// AI Desk (DEC-105). Mọi route cần AI Desk được team bật cho tài khoản; ghi qua Idempotency-Key.
export function registerDeskRoutes(app: FastifyInstance, deps: DeskDeps): void {
  app.get("/api/v1/desk/bots", async (request) => deskBots(deps, requireAuth(request).userId));

  app.post("/api/v1/desk/paper", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(
      startPaperBodySchema.extend({ name: z.string().min(1).max(80) }),
      request.body,
    );
    return idempotent(deps.bots.db, request, reply, auth.userId, deps.bots.now(), async () => ({
      status: 201,
      body: await startPaper(deps, auth.userId, body, request.ip),
    }));
  });

  app.get("/api/v1/desk/paper/:id", async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    return paperView(deps, requireAuth(request).userId, id);
  });

  // Tính lại cấu hình (lưu một đề xuất mới) nên là thao tác ghi.
  app.post("/api/v1/desk/paper/:id/go-live", async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parseOrThrow(idParams, request.params);
    return idempotent(deps.bots.db, request, reply, auth.userId, deps.bots.now(), async () => ({
      status: 200,
      body: await goLive(deps, auth.userId, id),
    }));
  });
}
