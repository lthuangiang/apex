import { errorResponseSchema } from "@drift/shared";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerErrorHandler } from "../src/lib/http";
import { memoryRateLimiter, registerRateLimit } from "../src/plugins/rate-limit";

describe("API rate limit", () => {
  it("answers RATE_LIMITED with a retry time once an IP or a user goes over the limit", async () => {
    const app = Fastify();
    app.decorateRequest("auth", null);
    app.addHook("onRequest", (request, _reply, done) => {
      const user = request.headers["x-user"];
      request.auth =
        typeof user === "string" ? { userId: user, sessionId: "s", twoFactorEnabled: false } : null;
      done();
    });
    registerErrorHandler(app);
    registerRateLimit(app, memoryRateLimiter(), { perIp: 4, perUser: 2, windowMs: 60_000 });
    app.get("/x", () => ({ ok: true }));
    await app.ready();
    const call = (user?: string) =>
      app.inject({
        method: "GET",
        url: "/x",
        ...(user === undefined ? {} : { headers: { "x-user": user } }),
      });
    expect((await call("u1")).statusCode).toBe(200);
    expect((await call("u1")).statusCode).toBe(200);
    const limited = await call("u1");
    expect(limited.statusCode).toBe(429);
    const err = errorResponseSchema.parse(limited.json()).error;
    expect(err.code).toBe("RATE_LIMITED");
    expect(Number(err.details.retryAfterMs)).toBeGreaterThan(0);
    expect((await call("u2")).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(429);
    await app.close();
  });
});
