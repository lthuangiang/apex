import { AppError, ErrorCode, rewardsWatchEnableBodySchema } from "@drift/shared";
import type { FastifyInstance } from "fastify";

import { parseOrThrow } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { requireAuth } from "../../plugins/session";

import { rewardsTokenFingerprint } from "./claims";
import {
  enableRewardsWatch,
  getRewardsWatchState,
  removeRewardsWatch,
  type RewardsWatchDeps,
} from "./service";

// Routes báo box mới SoDEX rewards (#558, DEC-398). Cờ `REWARDS_WATCH_ENABLED` tắt (mặc định) thì mọi route trả 404
// như chưa tồn tại (cùng lệ với `/api/v1/telegram/*`). Không bao giờ trả token.

export interface RewardsWatchRouteOptions {
  enabled: () => boolean;
  deps: RewardsWatchDeps;
}

export function registerRewardsWatchRoutes(
  app: FastifyInstance,
  options: RewardsWatchRouteOptions,
): void {
  const { deps } = options;
  const ensureEnabled = () => {
    if (!options.enabled()) throw new AppError(ErrorCode.notFound, "Not found.");
  };

  app.post("/api/v1/rewards/watch", async (request, reply) => {
    ensureEnabled();
    const auth = requireAuth(request);
    const body = parseOrThrow(rewardsWatchEnableBodySchema, request.body);
    // Fingerprint không băm token (DB thường không giữ dẫn xuất nào của token, kế hoạch #558 mục 1.2).
    return idempotent(
      deps.db,
      request,
      reply,
      auth.userId,
      deps.now(),
      async () => {
        try {
          return {
            status: 200,
            body: await enableRewardsWatch(deps, auth.userId, body, request.ip),
          };
        } catch (error) {
          // #582: mọi lần bật hỏng đều có một dòng log (kể cả 4xx, error handler chỉ log 5xx). `details` không chứa
          // token hay địa chỉ ví; `reqId` của dòng log = `traceId` trả cho web.
          if (error instanceof AppError)
            request.log.warn(
              { code: error.code, details: error.details },
              "rewards watch: enable failed",
            );
          throw error;
        }
      },
      { fingerprintBody: rewardsTokenFingerprint(body.token, body.address) },
    );
  });

  app.get("/api/v1/rewards/watch", async (request) => {
    ensureEnabled();
    return getRewardsWatchState(deps, requireAuth(request).userId);
  });

  // Tắt chỉ giảm quyền: không hỏi 2FA.
  app.delete("/api/v1/rewards/watch", async (request, reply) => {
    ensureEnabled();
    const auth = requireAuth(request);
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => {
      await removeRewardsWatch(deps.db, auth.userId, "user", request.ip);
      return { status: 204, body: null };
    });
  });
}
