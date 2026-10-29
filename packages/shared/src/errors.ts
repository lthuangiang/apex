import { z } from "zod";

// Mã lỗi API (CODING_STANDARDS C6). Mã nghiệp vụ lấy từ tài liệu; mã chung theo DEC-20.
export const ErrorCode = {
  validationFailed: "VALIDATION_FAILED",
  unauthenticated: "UNAUTHENTICATED",
  forbidden: "FORBIDDEN",
  twoFactorRequired: "TWO_FACTOR_REQUIRED",
  twoFactorInvalid: "TWO_FACTOR_INVALID",
  otpInvalid: "OTP_INVALID",
  invalidCredentials: "INVALID_CREDENTIALS",
  emailTaken: "EMAIL_TAKEN",
  notFound: "NOT_FOUND",
  botNotFound: "BOT_NOT_FOUND",
  botStateConflict: "BOT_STATE_CONFLICT",
  stateConflict: "STATE_CONFLICT",
  idempotencyKeyConflict: "IDEMPOTENCY_KEY_CONFLICT",
  orderBelowMinSize: "ORDER_BELOW_MIN_SIZE",
  builderFeeNotApproved: "BUILDER_FEE_NOT_APPROVED",
  rateLimited: "RATE_LIMITED",
  internal: "INTERNAL_ERROR",
  sodexUnavailable: "SODEX_UNAVAILABLE",
  sodexTimeout: "SODEX_TIMEOUT",
  sodexRejected: "SODEX_REJECTED",
  sodexAccountNotFound: "SODEX_ACCOUNT_NOT_FOUND",
  sodexAccountInUse: "SODEX_ACCOUNT_IN_USE",
  signatureInvalid: "SIGNATURE_INVALID",
  recoUnavailable: "RECO_UNAVAILABLE",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  TWO_FACTOR_REQUIRED: 403,
  TWO_FACTOR_INVALID: 403,
  OTP_INVALID: 400,
  INVALID_CREDENTIALS: 401,
  EMAIL_TAKEN: 409,
  NOT_FOUND: 404,
  BOT_NOT_FOUND: 404,
  BOT_STATE_CONFLICT: 409,
  STATE_CONFLICT: 409,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  ORDER_BELOW_MIN_SIZE: 422,
  BUILDER_FEE_NOT_APPROVED: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SODEX_UNAVAILABLE: 502,
  SODEX_TIMEOUT: 504,
  SODEX_REJECTED: 422,
  SODEX_ACCOUNT_NOT_FOUND: 422,
  SODEX_ACCOUNT_IN_USE: 409,
  SIGNATURE_INVALID: 422,
  RECO_UNAVAILABLE: 503,
};

export type ErrorDetails = Record<string, unknown>;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}

export const errorCodeSchema = z.enum(ErrorCode);

/** `{ error: { code, message, details, traceId } }` (CODING_STANDARDS C6). */
export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()),
    traceId: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export function toErrorResponse(error: AppError, traceId: string): ErrorResponse {
  return {
    error: { code: error.code, message: error.message, details: error.details, traceId },
  };
}
