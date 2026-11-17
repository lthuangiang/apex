import type { FastifyInstance } from "fastify";

import { requireAuth } from "../../plugins/session";

import {
  listSodexCalls,
  sodexCallDetail,
  sodexCallFacets,
  sodexCallSummary,
  type SodexDebuggerDeps,
} from "./service";

// SoDEX Debugger (team): chỉ role team (403 cho người khác, 401 khi chưa đăng nhập). no-store: request / response của
// SoDEX không được nằm trong cache dùng chung (DEC-309).
export function registerSodexDebuggerRoutes(app: FastifyInstance, deps: SodexDebuggerDeps): void {
  app.get("/api/v1/admin/sodex-calls", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return listSodexCalls(deps, requireAuth(request).userId, request.query);
  });
  app.get("/api/v1/admin/sodex-calls/summary", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return sodexCallSummary(deps, requireAuth(request).userId);
  });
  app.get("/api/v1/admin/sodex-calls/facets", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return sodexCallFacets(deps, requireAuth(request).userId, request.query);
  });
  app.get<{ Params: { id: string } }>("/api/v1/admin/sodex-calls/:id", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return sodexCallDetail(deps, requireAuth(request).userId, request.params.id);
  });
}
