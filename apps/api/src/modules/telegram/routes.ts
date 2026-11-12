import { AppError, ErrorCode } from "@drift/shared";
import type { FastifyInstance } from "fastify";

import { safeEqual, sha256 } from "../../lib/crypto";
import { idempotent } from "../../lib/idempotency";
import { requireAuth } from "../../plugins/session";

import { createLink, handleUpdate, linkStatus, unlink, type TelegramDeps } from "./service";
import { telegramUpdateSchema } from "./update";

// Routes Telegram (docs/NOTIFICATIONS.md mục 9, DEC-170). Cờ `TELEGRAM_ENABLED` tắt (mặc định) thì mọi route
// trả 404 như chưa tồn tại.

export const TELEGRAM_WEBHOOK_PATH = "/api/v1/telegram/webhook";
export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

export interface TelegramRouteOptions {
  enabled: boolean;
  /** Bắt buộc khi `enabled` (config không cho khởi động nếu thiếu). */
  webhookSecret: string | null;
  deps: TelegramDeps;
}

export function registerTelegramRoutes(app: FastifyInstance, options: TelegramRouteOptions): void {
  const { deps } = options;
  const ensureEnabled = () => {
    if (!options.enabled) throw new AppError(ErrorCode.notFound, "Not found.");
  };

  app.post("/api/v1/telegram/link", async (request, reply) => {
    ensureEnabled();
    const auth = requireAuth(request);
    // Response chứa token gốc: không lưu vào bảng idempotency (chỉ lưu hash ở telegram_link_tokens).
    return idempotent(
      deps.db,
      request,
      reply,
      auth.userId,
      deps.now(),
      async () => ({ status: 201, body: await createLink(deps, auth.userId) }),
      { sensitive: true },
    );
  });

  app.get("/api/v1/telegram/link", async (request) => {
    ensureEnabled();
    return linkStatus(deps, requireAuth(request).userId);
  });

  // Ngắt kết nối chỉ giảm quyền nên không hỏi 2FA (mục 3).
  app.delete("/api/v1/telegram/link", async (request, reply) => {
    ensureEnabled();
    const auth = requireAuth(request);
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => {
      await unlink(deps, auth.userId, request.ip);
      return { status: 204, body: null };
    });
  });

  // Webhook công khai: chỉ nhận khi đúng secret header (so hash cùng độ dài, thời gian hằng). Không cookie nên
  // được miễn CSRF đúng path này (plugins/session.ts). Update hợp lệ luôn trả 200 nhanh; tin trả lời nằm ngay
  // trong body (Telegram gọi `sendMessage` từ đó), không gọi ra ngoài trong request.
  app.post(TELEGRAM_WEBHOOK_PATH, async (request, reply) => {
    ensureEnabled();
    const header = request.headers[TELEGRAM_SECRET_HEADER];
    const secret = options.webhookSecret;
    if (
      secret === null ||
      typeof header !== "string" ||
      !safeEqual(sha256(header), sha256(secret))
    ) {
      throw new AppError(ErrorCode.unauthenticated, "Sign in required.");
    }
    const parsed = telegramUpdateSchema.safeParse(request.body);
    // Loại update v1 không dùng (sửa tin, callback…): nhận rồi bỏ, để Telegram không gửi lại.
    if (!parsed.success) return reply.status(200).send({});
    const outcome = await handleUpdate(deps, parsed.data);
    return reply
      .status(200)
      .send(outcome.reply === null ? {} : { method: "sendMessage", ...outcome.reply });
  });
}
