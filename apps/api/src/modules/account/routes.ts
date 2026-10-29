import {
  adminUsersQuerySchema,
  notificationSettingsBodySchema,
  riskLimitsBodySchema,
  watchlistBodySchema,
} from "@drift/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { parseOrThrow } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { requireAuth } from "../../plugins/session";

import {
  ackAlert,
  adminUsers,
  analyst,
  builderRevenue,
  halt,
  listNotifications,
  markRead,
  notificationSettingsOf,
  overview,
  portfolio,
  risk,
  setLimit,
  setNotification,
  type AccountDeps,
} from "./service";
import { getWatchlist, setWatchlist } from "./watchlist";

export function registerAccountRoutes(app: FastifyInstance, deps: AccountDeps): void {
  const ok = (body: unknown) => () => Promise.resolve({ status: 200, body });
  app.get("/api/v1/portfolio", async (request) => ({
    portfolio: await portfolio(deps, requireAuth(request).userId),
  }));
  app.get("/api/v1/overview", async (request) => {
    const { period } = parseOrThrow(
      z.object({ period: z.enum(["1", "7", "30", "all"]).default("30") }),
      request.query,
    );
    return overview(deps, requireAuth(request).userId, period === "all" ? null : Number(period));
  });
  app.get("/api/v1/watchlist", async (request) => ({
    items: await getWatchlist(deps, requireAuth(request).userId),
  }));
  app.put("/api/v1/watchlist", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(watchlistBodySchema, request.body);
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () =>
      ok({ items: await setWatchlist(deps, auth.userId, body.items) })(),
    );
  });
  app.get("/api/v1/analyst", async (request) => analyst(deps, requireAuth(request).userId));

  app.get("/api/v1/risk", async (request) => ({
    risk: await risk(deps, requireAuth(request).userId),
  }));
  app.put("/api/v1/risk/limits", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(riskLimitsBodySchema, request.body);
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => {
      await setLimit(deps, auth.userId, body.key, body.value, request.ip);
      return ok({ risk: await risk(deps, auth.userId) })();
    });
  });
  app.post("/api/v1/risk/alerts/:id/ack", async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parseOrThrow(z.object({ id: z.uuid() }), request.params);
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => {
      await ackAlert(deps, auth.userId, id);
      return { status: 204, body: null };
    });
  });
  app.post("/api/v1/risk/halt", async (request, reply) => {
    const auth = requireAuth(request);
    const { twoFactorCode } = parseOrThrow(
      z.object({ twoFactorCode: z.string().min(6).max(11).optional() }),
      request.body ?? {},
    );
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => ({
      status: 202,
      body: await halt(deps, auth.userId, twoFactorCode, request.ip),
    }));
  });

  app.get("/api/v1/notifications", async (request) =>
    listNotifications(deps, requireAuth(request).userId),
  );
  app.post("/api/v1/notifications/:id/read", async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parseOrThrow(
      z.object({ id: z.union([z.uuid(), z.literal("all")]) }),
      request.params,
    );
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => {
      await markRead(deps, auth.userId, id);
      return { status: 204, body: null };
    });
  });
  app.get("/api/v1/notifications/settings", async (request) =>
    notificationSettingsOf(deps, requireAuth(request).userId),
  );
  app.put("/api/v1/notifications/settings", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(notificationSettingsBodySchema, request.body);
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => {
      await setNotification(deps, auth.userId, body.group, body.channel, body.enabled);
      return ok(await notificationSettingsOf(deps, auth.userId))();
    });
  });

  app.get("/api/v1/admin/builder-revenue", async (request) => {
    const { period } = parseOrThrow(
      z.object({
        period: z
          .union([z.string().regex(/^\d{4}-\d{2}$/), z.literal("all")])
          .default(new Date().toISOString().slice(0, 7)),
      }),
      request.query,
    );
    return builderRevenue(deps, requireAuth(request).userId, period);
  });

  app.get("/api/v1/admin/users", async (request) =>
    adminUsers(
      deps,
      requireAuth(request).userId,
      parseOrThrow(adminUsersQuerySchema, request.query),
    ),
  );
}
