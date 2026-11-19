import type { Db } from "@drift/db";
import { idempotencyKeys } from "@drift/db";
import { AppError, ErrorCode, IDEMPOTENCY_KEY_HEADER, idempotencyKeySchema } from "@drift/shared";
import { and, eq, lte } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";

import { sha256 } from "./crypto";

// `Idempotency-Key` bắt buộc cho mọi POST/PATCH/DELETE đổi trạng thái của người dùng đã đăng nhập
// (CODING_STANDARDS C7). Kết quả giữ 24 h; cùng key khác request (method, tài nguyên hoặc body) → 409.

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Tiền tố của fingerprint v2 (#314). Dòng cũ không có tiền tố này chỉ băm route pattern. */
export const IDEMPOTENCY_FINGERPRINT_PREFIX = "v2:";

/**
 * Fingerprint của một request: method + route pattern + path params đã resolve (sắp theo tên)
 * + user + body. Trước #314 chỉ băm route pattern, nên cùng key + cùng body trên một id khác
 * (vd `/bots/A/actions/start` rồi `/bots/B/actions/start`) phát lại response của bot A.
 * Dùng params thay cho URL thô để `%41` và `A` không thành hai request khác nhau; query không
 * tính vì không route ghi nào đọc query.
 */
export function idempotencyFingerprint(request: FastifyRequest, userId: string): string {
  const raw = (request.params ?? {}) as Record<string, unknown>;
  const params = Object.keys(raw)
    .sort()
    .map((name) => [name, raw[name]]);
  const route = request.routeOptions.url ?? request.url.split("?")[0];
  return (
    IDEMPOTENCY_FINGERPRINT_PREFIX +
    sha256(JSON.stringify([request.method, route, params, userId, request.body ?? null]))
  );
}

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
  const requestHash = idempotencyFingerprint(request, userId);
  const where = and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key));

  // Hết 24 h thì key được giải phóng (C7). Trước đây `expires_at` không được dùng tới, nên một
  // dòng cũ giữ key mãi mãi; giờ dòng quá hạn của đúng key này bị xoá trước khi ghi dòng mới.
  await db.delete(idempotencyKeys).where(and(where, lte(idempotencyKeys.expiresAt, now)));

  const inserted = await db
    .insert(idempotencyKeys)
    .values({ key, userId, requestHash, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) })
    .onConflictDoNothing()
    .returning({ id: idempotencyKeys.id });

  if (inserted.length === 0) {
    const [existing] = await db.select().from(idempotencyKeys).where(where).limit(1);
    if (existing === undefined) {
      throw new AppError(ErrorCode.idempotencyKeyConflict, "Idempotency-Key is in use.");
    }
    if (!existing.requestHash.startsWith(IDEMPOTENCY_FINGERPRINT_PREFIX)) {
      // Dòng ghi trước #314 chỉ băm route pattern: không biết nó thuộc id nào, nên không phát lại
      // (có thể là bot khác) và cũng không chạy lại (có thể là chính request này, rule 1.7).
      // Dòng loại này hết hạn sau 24 h (xoá ở trên); client dùng key mới là được.
      throw new AppError(
        ErrorCode.idempotencyKeyConflict,
        "Idempotency-Key was used for a different request.",
        { reason: "fingerprint_outdated" },
      );
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
