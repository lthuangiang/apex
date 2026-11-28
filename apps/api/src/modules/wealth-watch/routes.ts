import type { Db } from "@drift/db";
import { AppError, ErrorCode } from "@drift/shared";
import type { FastifyInstance } from "fastify";

import { idempotent } from "../../lib/idempotency";
import { requireAuth } from "../../plugins/session";

import { enableWealthWatch, getWealthWatchState, removeWealthWatch } from "./service";
import { wealthAlertsVisibleTo, type WealthWatchSwitches } from "./visibility";

// Routes công tắc "Alerts" của SoDEX Wealth (#594, DEC-404 mục 7). Chỉ cho chính user đang đăng nhập (không có tham số
// user). Không dùng được (US Market tắt, hoặc `WEALTH_WATCH_ENABLED` tắt và không phải team) thì 404 như chưa tồn tại.

export interface WealthWatchRouteOptions {
  db: Db;
  now: () => Date;
  switches: WealthWatchSwitches | undefined;
}

export function registerWealthWatchRoutes(
  app: FastifyInstance,
  options: WealthWatchRouteOptions,
): void {
  const { db, now } = options;
  const ensureVisible = async (userId: string) => {
    if (!(await wealthAlertsVisibleTo(db, options.switches, userId)))
      throw new AppError(ErrorCode.notFound, "Not found.");
  };

  app.get("/api/v1/wealth/watch", async (request) => {
    const auth = requireAuth(request);
    await ensureVisible(auth.userId);
    return getWealthWatchState(db, auth.userId);
  });

  app.post("/api/v1/wealth/watch", async (request, reply) => {
    const auth = requireAuth(request);
    await ensureVisible(auth.userId);
    return idempotent(db, request, reply, auth.userId, now(), async () => ({
      status: 200,
      body: await enableWealthWatch(db, auth.userId, now(), request.ip),
    }));
  });

  // Tắt chỉ giảm việc DeskLabs làm: không hỏi 2FA. Xoá mọi mốc đã lưu.
  app.delete("/api/v1/wealth/watch", async (request, reply) => {
    const auth = requireAuth(request);
    await ensureVisible(auth.userId);
    return idempotent(db, request, reply, auth.userId, now(), async () => {
      await removeWealthWatch(db, auth.userId, "user", request.ip);
      return { status: 204, body: null };
    });
  });
}
