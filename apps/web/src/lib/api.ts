import {
  CSRF_COOKIE,
  CSRF_HEADER,
  errorResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  type ErrorCode,
} from "@drift/shared";
import type { z } from "zod";

// Client gọi api cùng origin. Request ghi luôn kèm CSRF header và Idempotency-Key (C7, C12).
// UI không hiển thị message thô của server; chỉ dùng `code` để chọn câu chữ (C6).

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | "NETWORK",
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "ApiError";
  }
}

function readCookie(name: string): string | undefined {
  return document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

async function ensureCsrf(): Promise<string> {
  const existing = readCookie(CSRF_COOKIE);
  if (existing !== undefined) return existing;
  await fetch("/api/v1/auth/csrf", { credentials: "same-origin" });
  return readCookie(CSRF_COOKIE) ?? "";
}

export interface RequestOptions {
  body?: unknown;
  /** Giữ nguyên một key cho cùng một thao tác người dùng (chống double submit). */
  idempotencyKey?: string;
}

export async function api<T extends z.ZodType>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  schema: T,
  options: RequestOptions = {},
): Promise<z.output<T>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") {
    headers[CSRF_HEADER] = await ensureCsrf();
    if (options.idempotencyKey !== undefined)
      headers[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey;
  }
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new ApiError("NETWORK", 0);
  }
  if (response.status === 204) return schema.parse(null);
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(json);
    if (parsed.success)
      throw new ApiError(parsed.data.error.code, response.status, parsed.data.error.details);
    throw new ApiError("INTERNAL_ERROR", response.status);
  }
  return schema.parse(json);
}
