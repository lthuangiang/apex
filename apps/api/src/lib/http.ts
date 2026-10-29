import { AppError, ErrorCode, toErrorResponse } from "@drift/shared";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

// Format lỗi chung (CODING_STANDARDS C6). Không trả message thô của lỗi nội bộ cho client.

export function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "_";
      (fieldErrors[key] ??= []).push(issue.code);
    }
    throw new AppError(ErrorCode.validationFailed, "Invalid input.", { fieldErrors });
  }
  return parsed.data;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: FastifyError | AppError, request: FastifyRequest, reply: FastifyReply) => {
      const traceId = request.id;
      if (error instanceof AppError) {
        if (error.httpStatus >= 500)
          request.log.error({ err: error, code: error.code }, "request failed");
        return reply.status(error.httpStatus).send(toErrorResponse(error, traceId));
      }
      // Lỗi parse body / content-type của Fastify: coi là input sai.
      if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
        const appError = new AppError(ErrorCode.validationFailed, "Invalid request.", {});
        return reply.status(400).send(toErrorResponse(appError, traceId));
      }
      request.log.error({ err: error }, "unhandled error");
      const internal = new AppError(ErrorCode.internal, "Internal error.", {});
      return reply.status(500).send(toErrorResponse(internal, traceId));
    },
  );

  app.setNotFoundHandler((request, reply) => {
    const notFound = new AppError(ErrorCode.notFound, "Not found.", {});
    return reply.status(404).send(toErrorResponse(notFound, request.id));
  });
}
