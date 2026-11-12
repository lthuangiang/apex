import {
  botActionBodySchema,
  createBotBodySchema,
  dryRunChecksBodySchema,
  newVersionBodySchema,
  VOLUME_PERIODS,
  ANALYTICS_PERIODS,
} from "@drift/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { parseOrThrow } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { requireAuth } from "../../plugins/session";

import { botAnalytics, tradeDetail } from "./analytics";
import { exportBot } from "./export";
import { fundingStats } from "./funding";
import { applyReview, latestReview, startReview } from "./review";
import {
  botDetail,
  createBot,
  archiveBot,
  unarchiveBot,
  listBots,
  listBotFills,
  orderCounts,
  listOrders,
  newVersion,
  pauseBot,
  resumeBot,
  startBot,
  dryRunChecks,
  startChecks,
  stopBot,
  type BotDeps,
} from "./service";
import { volumeAnalytics } from "./volume-analytics";

const idParams = z.object({ id: z.uuid() });

// REST bot (CODING_STANDARDS C7): hành động trạng thái là POST /bots/:id/actions/<action>, trả 202 kèm
// trạng thái chuyển tiếp; mọi request ghi bắt buộc Idempotency-Key.
export function registerBotRoutes(app: FastifyInstance, deps: BotDeps): void {
  const { db } = deps;
  const run = (status: number, work: () => Promise<unknown>) => async () => ({
    status,
    body: await work(),
  });

  // `?archived=true`: gồm cả bot đã archive (bộ lọc Archived ở Strategy Lab).
  app.get("/api/v1/bots", async (request) => {
    const q = parseOrThrow(z.object({ archived: z.enum(["true"]).optional() }), request.query);
    return {
      items: await listBots(deps, requireAuth(request).userId, q.archived === "true"),
    };
  });

  app.post("/api/v1/bots", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(createBotBodySchema, request.body);
    return idempotent(
      db,
      request,
      reply,
      auth.userId,
      deps.now(),
      run(201, () => createBot(deps, auth.userId, body, request.ip)),
    );
  });

  app.get("/api/v1/bots/:id", async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    return botDetail(deps, requireAuth(request).userId, id);
  });

  // Dry run cho form chưa lưu (UI_REVIEW H2). POST vì gửi config; không đổi trạng thái nên không cần Idempotency-Key.
  app.post("/api/v1/bots/checks", async (request) => {
    const body = parseOrThrow(dryRunChecksBodySchema, request.body);
    return dryRunChecks(deps, requireAuth(request).userId, body);
  });

  app.get("/api/v1/bots/:id/checks", async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    return startChecks(deps, requireAuth(request).userId, id);
  });

  app.post("/api/v1/bots/:id/versions", async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parseOrThrow(idParams, request.params);
    const body = parseOrThrow(newVersionBodySchema, request.body);
    return idempotent(
      db,
      request,
      reply,
      auth.userId,
      deps.now(),
      run(202, () => newVersion(deps, auth.userId, id, body)),
    );
  });

  app.post("/api/v1/bots/:id/actions/:action", async (request, reply) => {
    const auth = requireAuth(request);
    const { id, action } = parseOrThrow(
      z.object({
        id: z.uuid(),
        action: z.enum(["start", "pause", "resume", "stop", "archive", "unarchive"]),
      }),
      request.params,
    );
    const body = parseOrThrow(botActionBodySchema, request.body ?? {});
    const work = () => {
      switch (action) {
        case "start":
          return startBot(deps, auth.userId, id, body, request.ip, auth.sessionId);
        case "pause":
          return pauseBot(deps, auth.userId, id);
        case "archive":
          return archiveBot(deps, auth.userId, id);
        case "unarchive":
          return unarchiveBot(deps, auth.userId, id);
        case "resume":
          return resumeBot(deps, auth.userId, id);
        case "stop":
          return stopBot(deps, auth.userId, id, request.ip, body.closePosition === true);
      }
    };
    return idempotent(db, request, reply, auth.userId, deps.now(), run(202, work));
  });

  // Funding đã trả + volume Spot 24 giờ cho ô chọn tài sản Funding Arb (DEC-160).
  app.get("/api/v1/markets/funding", async (request) => {
    requireAuth(request);
    return fundingStats(deps, deps.now().getTime());
  });

  app.get("/api/v1/markets", async (request) => {
    requireAuth(request);
    const [spot, perps] = await Promise.all([
      deps.rest.getSpotSymbols(),
      deps.rest.getPerpsSymbols(),
    ]);
    // Một lần MGET cho cả danh sách (ô chọn market hiện giá gần nhất, UI_REVIEW G6).
    const last = await deps.prices([...spot, ...perps].map((m) => m.name));
    return {
      items: [
        ...spot.map((m) => ({
          name: m.name,
          engine: "spot" as const,
          displayName: m.displayName ?? m.name,
          base: m.baseCoin,
          quote: m.quoteCoin,
          tickSize: m.tickSize,
          stepSize: m.stepSize,
          trading: m.status === "TRADING",
          minNotional: m.minNotional,
          maxLeverage: null,
          last: last[m.name] ?? null,
        })),
        ...perps.map((m) => ({
          name: m.name,
          engine: "perps" as const,
          displayName: m.displayName ?? m.name,
          base: m.baseCoin ?? null,
          quote: m.quoteCoin ?? null,
          tickSize: m.tickSize,
          stepSize: m.stepSize,
          trading: m.status === "TRADING",
          minNotional: m.minNotional,
          maxLeverage: m.maxLeverage,
          last: last[m.name] ?? null,
        })),
      ],
    };
  });

  // Giá gần nhất cho Preview của màn Create (đường "Last" và các ô chỉ số tính theo giá).
  app.get("/api/v1/markets/:market/last", async (request) => {
    requireAuth(request);
    const { market } = parseOrThrow(
      z.object({ market: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }),
      request.params,
    );
    const last = await deps.lastPrice(market);
    return { market, price: last?.price ?? null, at: last?.at ?? null };
  });

  app.get("/api/v1/bots/:id/fills", async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    const { page } = parseOrThrow(
      z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1) }),
      request.query,
    );
    return listBotFills(deps, requireAuth(request).userId, id, page);
  });

  // Bảng Volume của bot khối lượng theo kỳ (DEC-128).
  app.get("/api/v1/bots/:id/volume-analytics", async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    const { period } = parseOrThrow(
      z.object({ period: z.enum(VOLUME_PERIODS).default("session") }),
      request.query,
    );
    return volumeAnalytics(deps, requireAuth(request).userId, id, period);
  });

  // Strategy Analytics (DEC-141): tổng hợp theo kỳ và chi tiết một lượt.
  app.get("/api/v1/bots/:id/analytics", async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    const { period } = parseOrThrow(
      z.object({ period: z.enum(ANALYTICS_PERIODS).default("d7") }),
      request.query,
    );
    return botAnalytics(deps, requireAuth(request).userId, id, period);
  });
  app.get("/api/v1/bots/:id/analytics/trades/:key", async (request) => {
    const { id, key } = parseOrThrow(
      z.object({ id: z.uuid(), key: z.string().regex(/^[0-9]{10,16}$/) }),
      request.params,
    );
    return tradeDetail(deps, requireAuth(request).userId, id, key);
  });

  // Export dữ liệu của bot để phân tích (DEC-138): ZIP gồm configs, events, orders, fills, nến 1 phút.
  app.get("/api/v1/bots/:id/export", async (request, reply) => {
    const { id } = parseOrThrow(idParams, request.params);
    const file = await exportBot(deps, requireAuth(request).userId, id);
    return reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${file.fileName}"`)
      .header("Cache-Control", "no-store")
      .send(file.data);
  });

  // Review sau khi chạy của Volume Builder (DEC-131): đọc kết quả gần nhất, chạy mới, áp dụng đề xuất.
  app.get("/api/v1/bots/:id/review", async (request) => {
    const { id } = parseOrThrow(idParams, request.params);
    return { review: await latestReview(deps, requireAuth(request).userId, id) };
  });
  app.post("/api/v1/bots/:id/review", async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parseOrThrow(idParams, request.params);
    return idempotent(
      db,
      request,
      reply,
      auth.userId,
      deps.now(),
      run(202, () => startReview(deps, auth.userId, id)),
    );
  });
  app.post("/api/v1/bots/:id/review/:reviewId/apply", async (request, reply) => {
    const auth = requireAuth(request);
    const { id, reviewId } = parseOrThrow(
      z.object({ id: z.uuid(), reviewId: z.uuid() }),
      request.params,
    );
    return idempotent(
      db,
      request,
      reply,
      auth.userId,
      deps.now(),
      run(202, () => applyReview(deps, auth.userId, id, reviewId)),
    );
  });

  app.get("/api/v1/orders", async (request) => {
    const { botId } = parseOrThrow(z.object({ botId: z.uuid().optional() }), request.query);
    const userId = requireAuth(request).userId;
    const [items, counts] = await Promise.all([
      listOrders(deps, userId, botId),
      orderCounts(deps, userId, botId),
    ]);
    return { items, counts };
  });
}
