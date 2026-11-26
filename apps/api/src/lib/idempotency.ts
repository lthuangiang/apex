import { AsyncLocalStorage } from "node:async_hooks";

import type { Db } from "@drift/db";
import { idempotencyKeys } from "@drift/db";
import {
  AppError,
  ErrorCode,
  IDEMPOTENCY_FAILED_UNKNOWN,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
} from "@drift/shared";
import { and, eq, lte } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";

import { sha256 } from "./crypto";

// `Idempotency-Key` bắt buộc cho mọi POST/PATCH/DELETE đổi trạng thái của người dùng đã đăng nhập
// (CODING_STANDARDS C7). Kết quả giữ 24 h; cùng key khác request (method, tài nguyên hoặc body) → 409.
//
// Handler lỗi (#316, DEC-334): key chỉ được giải phóng khi lỗi chắc chắn xảy ra
// trước mọi tác dụng phụ, tức là (a) handler chưa gọi `markSideEffect()` VÀ (b) lỗi là AppError có mã trong
// `PRE_SIDE_EFFECT_CODES`. Mọi lỗi khác giữ dòng ở `outcome = failed_unknown` (kèm mã lỗi): cùng key sau đó
// nhận 409 `reason: "unknown"` và không bao giờ chạy lại (rule 1.7). Dòng chưa có kết quả = đang chạy → 409
// `reason: "in_progress"`.

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Tiền tố của fingerprint v2 (#314). Dòng cũ không có tiền tố này chỉ băm route pattern. */
export const IDEMPOTENCY_FINGERPRINT_PREFIX = "v2:";

/**
 * Fingerprint của một request: method + route pattern + path params đã resolve (sắp theo tên)
 * + user + body. Trước #314 chỉ băm route pattern, nên cùng key + cùng body trên một id khác
 * (vd `/bots/A/actions/start` rồi `/bots/B/actions/start`) phát lại response của bot A.
 * Dùng params thay cho URL thô để `%41` và `A` không thành hai request khác nhau; query không
 * tính vì không route ghi nào đọc query.
 *
 * `body` (tuỳ chọn): thay body trong phần băm. Route mà body chứa secret (#558: JWT rewards) truyền một bản tóm tắt
 * không chứa secret, để `idempotency_keys` không giữ bất kỳ dẫn xuất nào của nó. Thiếu = body của request (như cũ).
 */
export function idempotencyFingerprint(
  request: FastifyRequest,
  userId: string,
  body: unknown = request.body,
): string {
  const raw = (request.params ?? {}) as Record<string, unknown>;
  const params = Object.keys(raw)
    .sort()
    .map((name) => [name, raw[name]]);
  const route = request.routeOptions.url ?? request.url.split("?")[0];
  return (
    IDEMPOTENCY_FINGERPRINT_PREFIX +
    sha256(JSON.stringify([request.method, route, params, userId, body ?? null]))
  );
}

/**
 * Giá trị `idempotency_keys.outcome` khi handler lỗi mà không chắc chưa có tác dụng phụ. Hằng nằm ở `@drift/shared` vì
 * jobs cũng ghi giá trị này cho dòng đang chạy bị bỏ dở (#319, `markAbandonedIdempotencyKeys`).
 */
export { IDEMPOTENCY_FAILED_UNKNOWN };

/**
 * Mã lỗi mà handler chỉ ném ra từ bước kiểm tra, trước khi ghi hay gọi ra ngoài: input sai, auth / 2FA,
 * không tìm thấy, xung đột trạng thái kiểm trước khi ghi, rate limit (bucket Redis của chính DeskLabs, chặn
 * trước khi gửi). Không có ở đây: INTERNAL_ERROR, SODEX_UNAVAILABLE / SODEX_TIMEOUT / SODEX_REJECTED,
 * RECO_UNAVAILABLE, ANALYSIS_TIMEOUT và mọi lỗi không phải AppError: kết quả có thể đã xảy ra một phần.
 * Một mã trong danh sách mà ném ra SAU `markSideEffect()` vẫn không giải phóng key.
 */
export const PRE_SIDE_EFFECT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCode.validationFailed,
  ErrorCode.unauthenticated,
  ErrorCode.forbidden,
  ErrorCode.twoFactorRequired,
  ErrorCode.twoFactorInvalid,
  ErrorCode.otpInvalid,
  ErrorCode.invalidCredentials,
  ErrorCode.emailTaken,
  ErrorCode.notFound,
  ErrorCode.botNotFound,
  ErrorCode.botStateConflict,
  ErrorCode.stateConflict,
  ErrorCode.orderBelowMinSize,
  ErrorCode.builderFeeNotApproved,
  ErrorCode.rateLimited,
  ErrorCode.sodexAccountNotFound,
  ErrorCode.sodexAccountInUse,
  ErrorCode.signatureInvalid,
  ErrorCode.telegramNotConnected,
  ErrorCode.telegramLinkExpired,
  // #305: danh sách market của Signal research (Redis `sr:markets`) chưa có; ném ra lúc kiểm tài sản, trước khi lưu.
  ErrorCode.marketListUnavailable,
  // #558: bật báo box mới bị từ chối hoặc chưa làm được trước khi ghi DB (kiểm ví, kiểm token, gateway / signer lỗi; mã
  // hoá ở signer không để lại gì). Dòng `rewards_watch` chỉ được ghi sau `markSideEffect()`.
  ErrorCode.rewardsWalletMismatch,
  ErrorCode.rewardsTokenInvalid,
  ErrorCode.rewardsWatchUnavailable,
  // #420: cờ `SIGNAL_NEWS_BOTS_ENABLED` tắt; kiểm trước mọi thao tác ghi.
  ErrorCode.featureNotReady,
]);

interface SideEffectScope {
  started: boolean;
}
const sideEffects = new AsyncLocalStorage<SideEffectScope>();

/**
 * Handler gọi ngay trước phần không đảo ngược được (commit đổi state bot, version áp lên bot đang chạy,
 * tạo key ở signer, ghi / gửi request ký cho SoDEX). Sau dấu này mọi lỗi, kể cả lỗi trong
 * `PRE_SIDE_EFFECT_CODES`, giữ key ở `failed_unknown`. Ngoài `idempotent()` thì không làm gì.
 */
export function markSideEffect(): void {
  const scope = sideEffects.getStore();
  if (scope !== undefined) scope.started = true;
}

/** Lỗi này có được giải phóng key không (chỉ khi chắc chắn chưa có tác dụng phụ). */
export function releasesKey(error: unknown, sideEffectStarted: boolean): boolean {
  return !sideEffectStarted && error instanceof AppError && PRE_SIDE_EFFECT_CODES.has(error.code);
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
  options: {
    sensitive?: boolean;
    /** Thay body khi băm fingerprint (body chứa secret, xem `idempotencyFingerprint`). */
    fingerprintBody?: unknown;
  } = {},
): Promise<FastifyReply> {
  const raw = request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(ErrorCode.validationFailed, "Idempotency-Key header is required.", {
      fieldErrors: { [IDEMPOTENCY_KEY_HEADER]: ["invalid"] },
    });
  }
  const key = parsed.data;
  const requestHash =
    options.fingerprintBody === undefined
      ? idempotencyFingerprint(request, userId)
      : idempotencyFingerprint(request, userId, options.fingerprintBody);
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
      // Dòng vừa bị giải phóng giữa insert và select (request trước lỗi ở bước kiểm tra).
      throw new AppError(ErrorCode.idempotencyKeyConflict, "Idempotency-Key is in use.", {
        reason: "in_progress",
      });
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
    if (existing.requestHash !== requestHash) {
      throw new AppError(
        ErrorCode.idempotencyKeyConflict,
        "Idempotency-Key was used for a different request.",
      );
    }
    if (existing.outcome === IDEMPOTENCY_FAILED_UNKNOWN) {
      // Lần trước lỗi khi có thể đã có tác dụng phụ: không chạy lại (rule 1.7). Client đọc lại trạng thái
      // (bot, signature request…) rồi mới làm tiếp với key mới.
      throw new AppError(
        ErrorCode.idempotencyKeyConflict,
        "Outcome of the earlier request with this Idempotency-Key is unknown. Check the current state before retrying with a new key.",
        { reason: "unknown", errorCode: existing.errorCode },
      );
    }
    if (existing.statusCode === null) {
      throw new AppError(
        ErrorCode.idempotencyKeyConflict,
        "A request with this Idempotency-Key is still in progress.",
        { reason: "in_progress" },
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

  const scope: SideEffectScope = { started: false };
  let result: IdempotentResult;
  try {
    result = await sideEffects.run(scope, handler);
  } catch (error) {
    // Ghi trạng thái key lỗi thì chỉ log: client vẫn nhận lỗi gốc. Nếu không ghi được `failed_unknown`, dòng
    // vẫn ở "đang chạy" (không bao giờ bị giải phóng nhầm) và hết hạn sau 24 h.
    const keep = (e: unknown) => {
      request.log.error({ err: e, traceId: request.id }, "idempotency key state not saved");
    };
    if (releasesKey(error, scope.started)) {
      // Lỗi ở bước kiểm tra, chưa có tác dụng phụ: giải phóng key để client sửa rồi thử lại.
      await db.delete(idempotencyKeys).where(where).catch(keep);
    } else {
      const errorCode = error instanceof AppError ? error.code : ErrorCode.internal;
      request.log.warn(
        { traceId: request.id, errorCode, sideEffectStarted: scope.started },
        "idempotent request failed with an unknown outcome; key kept",
      );
      await db
        .update(idempotencyKeys)
        .set({ outcome: IDEMPOTENCY_FAILED_UNKNOWN, errorCode })
        .where(where)
        .catch(keep);
    }
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
