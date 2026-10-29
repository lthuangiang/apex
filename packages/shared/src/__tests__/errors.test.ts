import { describe, expect, it } from "vitest";

import { AppError, ErrorCode, errorResponseSchema, toErrorResponse } from "../errors";

describe("errors", () => {
  it("maps business codes to the HTTP status in CODING_STANDARDS C6", () => {
    expect(new AppError(ErrorCode.botStateConflict, "Conflict").httpStatus).toBe(409);
    expect(new AppError(ErrorCode.builderFeeNotApproved, "No fee").httpStatus).toBe(422);
    expect(new AppError(ErrorCode.twoFactorRequired, "2FA").httpStatus).toBe(403);
    expect(new AppError(ErrorCode.sodexTimeout, "Timeout").httpStatus).toBe(504);
  });

  it("builds an error body that passes the shared schema", () => {
    const body = toErrorResponse(
      new AppError(ErrorCode.botNotFound, "Bot not found.", { botId: "b1" }),
      "trace-1",
    );
    expect(errorResponseSchema.parse(body)).toEqual({
      error: {
        code: "BOT_NOT_FOUND",
        message: "Bot not found.",
        details: { botId: "b1" },
        traceId: "trace-1",
      },
    });
  });

  it("rejects unknown error codes", () => {
    const result = errorResponseSchema.safeParse({
      error: { code: "SOMETHING_ELSE", message: "x", details: {}, traceId: "t" },
    });
    expect(result.success).toBe(false);
  });
});
