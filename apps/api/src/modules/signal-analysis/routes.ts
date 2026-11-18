import type { FastifyInstance } from "fastify";

import { requireAuth } from "../../plugins/session";

import { signalAll } from "./all";
import type { SignalDeps } from "./common";
import { signalMm, signalMmFill, signalMmFills, signalMmQuantiles } from "./mm";
import { signalVb, signalVbEntries, signalVbEntry } from "./vb";

// Signal Analysis (team, #233): chỉ role team (401 chưa đăng nhập, 403 người ngoài team, kiểm trước khi parse tham số).
// Chỉ đọc, không bao giờ đổi bot. no-store: số theo account không nằm trong cache dùng chung.
export function registerSignalAnalysisRoutes(app: FastifyInstance, deps: SignalDeps): void {
  const base = "/api/v1/admin/signal-analysis";
  app.get(`${base}/all`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalAll(deps, requireAuth(request).userId, request.query);
  });
  app.get(`${base}/vb`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalVb(deps, requireAuth(request).userId, request.query);
  });
  app.get(`${base}/vb/entries`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalVbEntries(deps, requireAuth(request).userId, request.query);
  });
  app.get<{ Params: { id: string } }>(`${base}/vb/entries/:id`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalVbEntry(deps, requireAuth(request).userId, request.params.id, request.query);
  });
  app.get(`${base}/mm`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalMm(deps, requireAuth(request).userId, request.query);
  });
  app.get(`${base}/mm/quantiles`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalMmQuantiles(deps, requireAuth(request).userId, request.query);
  });
  app.get(`${base}/mm/fills`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalMmFills(deps, requireAuth(request).userId, request.query);
  });
  app.get<{ Params: { id: string } }>(`${base}/mm/fills/:id`, async (request, reply) => {
    void reply.header("cache-control", "no-store");
    return signalMmFill(deps, requireAuth(request).userId, request.params.id, request.query);
  });
}
