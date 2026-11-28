import { AppError, ErrorCode, wealthMeQuerySchema } from "@drift/shared";
import type { FastifyInstance } from "fastify";

import { parseOrThrow } from "../../lib/http";
import { requireAuth } from "../../plugins/session";

import type { UsMarketService } from "./service";

// US Market + SoDEX Wealth (#589, DEC-402 mục 9). Công tắc `US_MARKET_ENABLED` tắt thì mọi route trả 404 như chưa tồn
// tại (cùng lệ với `/api/v1/rewards/watch`). Cả hai route chỉ đọc, cần đăng nhập.

export interface UsMarketRouteOptions {
  enabled: () => boolean;
  service: UsMarketService;
}

export function registerUsMarketRoutes(app: FastifyInstance, options: UsMarketRouteOptions): void {
  const ensureEnabled = () => {
    if (!options.enabled()) throw new AppError(ErrorCode.notFound, "Not found.");
  };

  app.get("/api/v1/markets/us", async (request) => {
    ensureEnabled();
    requireAuth(request);
    return options.service.markets();
  });

  // Theo master wallet của tài khoản đang đăng nhập (sodex_accounts connected); không nhận địa chỉ từ ngoài.
  // `?include=recurringBuys,pnlHistory` mới đọc hai phần đó (#592). Hết ngân sách weight → 429 kèm `retryAfterMs`.
  app.get("/api/v1/wealth/me", async (request) => {
    ensureEnabled();
    const auth = requireAuth(request);
    const q = parseOrThrow(wealthMeQuerySchema, request.query);
    return options.service.wealthMe(auth.userId, q.include);
  });
}
