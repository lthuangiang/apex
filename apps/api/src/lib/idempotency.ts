import type { Db } from "@drift/db";
import { idempotencyKeys } from "@drift/db";
import { AppError, ErrorCode, IDEMPOTENCY_KEY_HEADER, idempotencyKeySchema } from "@drift/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";

import { sha256 } from "./crypto";

// `Idempotency-Key` bắt buộc cho mọi POST/PATCH/DELETE đổi trạng thái của người dùng đã đăng nhập
// (CODING_STANDARDS C7). Kết quả giữ 24 h; cùng key khác payload → 409.

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotentResult {
  status: number;
  body: unknown;
}

export async function idempotent(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  now: Date,
  handler: () => Promise<IdempotentResult>,
  options: { sensitive?: boolean } = {},
): Promise<FastifyReply> {
  const raw = request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(ErrorCode.validationFailed, "Idempotency-Key header is required.", {
      fieldErrors: { [IDEMPOTENCY_KEY_HEADER]: ["invalid"] },
    });
  }
  const key = parsed.data;
  const requestHash = sha256(
    `${request.method} ${request.routeOptions.url ?? request.url} ${JSON.stringify(request.body ?? null)}`,
  );

  const inserted = await db
    .insert(idempotencyKeys)
    .values({ key, userId, requestHash, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) })
    .onConflictDoNothing()
    .returning({ id: idempotencyKeys.id });

  const where = and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key));
  if (inserted.length === 0) {
    const [existing] = await db.select().from(idempotencyKeys).where(where).limit(1);
    if (existing === undefined) {
      throw new AppError(ErrorCode.idempotencyKeyConflict, "Idempotency-Key is in use.");
    }
    if (existing.requestHash !== requestHash || existing.statusCode === null) {
      throw new AppError(
        ErrorCode.idempotencyKeyConflict,
        "Idempotency-Key was used for a different request.",
      );
    }
    if (options.sensitive === true) {
      // Response chứa secret không được lưu, nên không phát lại được.
      throw new AppError(ErrorCode.idempotencyKeyConflict, "Request was already processed.", {
        reason: "response_not_stored",
      });
    }
    return reply
      .status(existing.statusCode)
      .header("Idempotent-Replayed", "true")
      .send(existing.response);
  }

  let result: IdempotentResult;
  try {
    result = await handler();
  } catch (error) {
    // Lỗi xác định trước khi có tác dụng phụ: giải phóng key để client thử lại.
    await db.delete(idempotencyKeys).where(where);
    throw error;
  }
  await db
    .update(idempotencyKeys)
    .set({
      statusCode: result.status,
      response: options.sensitive === true ? null : (result.body ?? null),
    })
    .where(where);
  return reply.status(result.status).send(result.body);
}
