import {
  AppError,
  deskAiAskBodySchema,
  ErrorCode,
  startPaperBodySchema,
  whatIfApplyBodySchema,
} from "@drift/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { parseOrThrow } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { requireAuth } from "../../plugins/session";

import { askDeskAi, deleteDeskAiHistory, deskAiBrief, deskAiHistory } from "./ai";
import { needsYou, snoozeItem } from "./needs-you";
import { recordView, switchBack } from "./record";
import { deskBots, goLive, paperView, requireDesk, startPaper, type DeskDeps } from "./service";
import { applyWhatif, deskHome, startWhatif, whatifView } from "./whatif";

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

  // AI Desk B+ M1 (DEC-164, DEC-166): việc "Needs you" (tối đa 3) + sức khoẻ bot. Tính lại mỗi lần đọc.
  app.get("/api/v1/desk/needs-you", async (request) => {
    const userId = requireAuth(request).userId;
    await requireDesk(deps, userId);
    return needsYou({ db: deps.bots.db, rest: deps.bots.rest, now: deps.bots.now }, userId);
  });

  // AI Desk B+ M3: trang chủ = việc "Needs you" kèm so sánh mới nhất + sức khoẻ bot.
  app.get("/api/v1/desk/home", async (request) => {
    const userId = requireAuth(request).userId;
    await requireDesk(deps, userId);
    return deskHome(deps.bots, userId);
  });

  // "Later" / "Not now": ẩn 7 ngày trừ khi dữ liệu xấu đi.
  app.post("/api/v1/desk/needs-you/:id/later", async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parseOrThrow(idParams, request.params);
    await requireDesk(deps, auth.userId);
    return idempotent(deps.bots.db, request, reply, auth.userId, deps.bots.now(), async () => {
      const r = await snoozeItem(
        { db: deps.bots.db, rest: deps.bots.rest, now: deps.bots.now },
        auth.userId,
        id,
      );
      if (r === null) throw new AppError(ErrorCode.notFound, "Item not found.");
      return { status: 200, body: r };
    });
  });

  // AI Desk B+ M2 (DEC-166): so sánh phương án của một việc (job ở worker `backtest`), xem kết quả, Apply.
  app.post("/api/v1/desk/needs-you/:id/whatif", async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parseOrThrow(idParams, request.params);
    await requireDesk(deps, auth.userId);
    return idempotent(deps.bots.db, request, reply, auth.userId, deps.bots.now(), async () => ({
      status: 200,
      body: await startWhatif(deps.bots, auth.userId, id),
    }));
  });

  app.get("/api/v1/desk/whatifs/:id", async (request) => {
    const auth = requireAuth(request);
    const { id } = parseOrThrow(idParams, request.params);
    await requireDesk(deps, auth.userId);
    return whatifView(deps.bots, auth.userId, id);
  });

  // Apply tạo version mới "AI suggested" qua luồng sửa bot hiện có; user bấm, AI không tự áp.
  app.post("/api/v1/desk/whatifs/:id/apply", async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parseOrThrow(idParams, request.params);
    const { option } = parseOrThrow(whatIfApplyBodySchema, request.body);
    await requireDesk(deps, auth.userId);
    return idempotent(deps.bots.db, request, reply, auth.userId, deps.bots.now(), async () => ({
      status: 201,
      body: await applyWhatif(deps.bots, auth.userId, id, option),
    }));
  });

  // AI Desk B+ M4: thành tích (đo 7 ngày sau mỗi Apply) và Switch back về cấu hình cũ.
  app.get("/api/v1/desk/record", async (request) => {
    const userId = requireAuth(request).userId;
    await requireDesk(deps, userId);
    return recordView(deps.bots, userId);
  });

  app.post("/api/v1/desk/applies/:id/switch-back", async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parseOrThrow(idParams, request.params);
    await requireDesk(deps, auth.userId);
    return idempotent(deps.bots.db, request, reply, auth.userId, deps.bots.now(), async () => ({
      status: 201,
      body: await switchBack(deps.bots, auth.userId, id),
    }));
  });

  // AI Desk B+ M5 (DEC-164, DEC-165): Desk AI. Chỉ đọc và viết lời quanh fact; không đổi bot, không gửi lệnh.
  const ai = (traceId: string) => ({ ...deps.bots, llm: deps.llm, traceId });
  app.get("/api/v1/desk/ai/brief", async (request) => {
    const userId = requireAuth(request).userId;
    await requireDesk(deps, userId);
    return deskAiBrief(ai(request.id), userId);
  });

  app.post("/api/v1/desk/ai/ask", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(deskAiAskBodySchema, request.body);
    await requireDesk(deps, auth.userId);
    return idempotent(deps.bots.db, request, reply, auth.userId, deps.bots.now(), async () => ({
      status: 200,
      body: await askDeskAi(
        ai(request.id),
        auth.userId,
        body.question,
        body.conversationId,
        body.context,
      ),
    }));
  });

  app.get("/api/v1/desk/ai/history", async (request) => {
    const userId = requireAuth(request).userId;
    await requireDesk(deps, userId);
    return deskAiHistory(deps.bots, userId);
  });

  app.delete("/api/v1/desk/ai/history", async (request, reply) => {
    const auth = requireAuth(request);
    await requireDesk(deps, auth.userId);
    return idempotent(deps.bots.db, request, reply, auth.userId, deps.bots.now(), async () => ({
      status: 200,
      body: await deleteDeskAiHistory(deps.bots, auth.userId),
    }));
  });
}
