import { randomUUID } from "node:crypto";

import { createDb, runMigrations, type Db } from "@drift/db";
import { AppError, ErrorCode, IDEMPOTENCY_KEY_HEADER } from "@drift/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { registerErrorHandler } from "../src/lib/http";
import { idempotent, markSideEffect, releasesKey } from "../src/lib/idempotency";

import { POSTGRES_IMAGE } from "./helpers";

// #316: helper `idempotent()` chỉ giải phóng key khi lỗi chắc chắn xảy ra trước tác dụng phụ. Handler ở đây là
// test double: `markSideEffect()` đánh dấu phần không đảo ngược (gửi engine / signer / SoDEX), rồi ném lỗi
// như khi timeout.

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: pg.Pool;
let app: FastifyInstance;
let userId: string;
const now = new Date("2026-11-19T08:00:00Z");

type Step = () => Promise<unknown>;
let calls = 0;
let step: Step = () => Promise.resolve({ ok: true });

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  await runMigrations(url);
  ({ db, pool } = createDb(url));
  userId = randomUUID();
  await pool.query("insert into users (id, email) values ($1, $2)", [
    userId,
    `idem-${userId}@drift.test`,
  ]);
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.post("/t/:id", async (request, reply) =>
    idempotent(db, request, reply, userId, now, async () => {
      calls += 1;
      return { status: 202, body: await step() };
    }),
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
});

beforeEach(() => {
  calls = 0;
  step = () => Promise.resolve({ ok: true });
});

const send = (key: string, id = "a", body: unknown = { x: 1 }) =>
  app.inject({
    method: "POST",
    url: `/t/${id}`,
    headers: { [IDEMPOTENCY_KEY_HEADER]: key, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });

const errorOf = (body: string) =>
  (JSON.parse(body) as { error: { code: string; details: Record<string, unknown> } }).error;

const rowOf = async (key: string) =>
  (
    await pool.query<{
      status_code: number | null;
      outcome: string | null;
      error_code: string | null;
    }>("select status_code, outcome, error_code from idempotency_keys where key = $1", [key])
  ).rows[0];

describe("idempotent() releases the key only before a side effect (#316)", () => {
  it("releases the key on a validation error, so a retry with the same key runs", async () => {
    const key = randomUUID();
    step = () =>
      Promise.reject(new AppError(ErrorCode.validationFailed, "Start checks failed.", {}));
    const first = await send(key);
    expect(first.statusCode).toBe(400);
    expect(await rowOf(key)).toBeUndefined();

    step = () => Promise.resolve({ ok: true });
    const retry = await send(key);
    expect(retry.statusCode).toBe(202);
    expect(retry.headers["idempotent-replayed"]).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("keeps the key after the side-effect marker: a retry gets 409 unknown and never runs again", async () => {
    const key = randomUUID();
    step = () => {
      markSideEffect();
      // Signer / engine timeout sau khi đã gửi.
      return Promise.reject(new AppError(ErrorCode.sodexTimeout, "SoDEX timed out.", {}));
    };
    const first = await send(key);
    expect(first.statusCode).toBe(504);
    expect(await rowOf(key)).toEqual({
      status_code: null,
      outcome: "failed_unknown",
      error_code: "SODEX_TIMEOUT",
    });

    step = () => Promise.resolve({ ok: true });
    const retry = await send(key);
    expect(retry.statusCode).toBe(409);
    const err = errorOf(retry.body);
    expect(err.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(err.details).toEqual({ reason: "unknown", errorCode: "SODEX_TIMEOUT" });
    expect(calls).toBe(1);
  });

  it("keeps the key for a pre-side-effect code thrown after the marker", async () => {
    const key = randomUUID();
    step = () => {
      markSideEffect();
      return Promise.reject(new AppError(ErrorCode.botStateConflict, "Conflict.", {}));
    };
    expect((await send(key)).statusCode).toBe(409);
    const retry = await send(key);
    expect(errorOf(retry.body).details).toMatchObject({ reason: "unknown" });
    expect(calls).toBe(1);
  });

  it("keeps the key for an error that is not a known pre-side-effect code, even without the marker", async () => {
    const key = randomUUID();
    step = () => Promise.reject(new Error("connection reset"));
    expect((await send(key)).statusCode).toBe(500);
    const retry = await send(key);
    expect(errorOf(retry.body).details).toEqual({ reason: "unknown", errorCode: "INTERNAL_ERROR" });
    expect(calls).toBe(1);
  });

  it("answers in_progress to the same request while the first one still runs", async () => {
    const key = randomUUID();
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    step = async () => {
      entered();
      await gate;
      return { ok: true };
    };
    const first = send(key);
    await inside;
    const second = await send(key);
    expect(second.statusCode).toBe(409);
    expect(errorOf(second.body).details).toEqual({ reason: "in_progress" });
    finish();
    expect((await first).statusCode).toBe(202);
    expect(calls).toBe(1);

    // Xong rồi: cùng request thì phát lại đúng response.
    const replay = await send(key);
    expect(replay.statusCode).toBe(202);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json()).toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  it("still refuses a different request with the same key as a plain conflict", async () => {
    const key = randomUUID();
    expect((await send(key, "a")).statusCode).toBe(202);
    const other = await send(key, "b");
    expect(other.statusCode).toBe(409);
    expect(errorOf(other.body).details).toEqual({});
    const otherBody = await send(key, "a", { x: 2 });
    expect(errorOf(otherBody.body).code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(calls).toBe(1);

    // Khác request trên một key `failed_unknown`: vẫn là conflict thường, không lộ kết quả của request kia.
    const failed = randomUUID();
    step = () => {
      markSideEffect();
      return Promise.reject(new AppError(ErrorCode.sodexUnavailable, "Down.", {}));
    };
    await send(failed, "a");
    expect(errorOf((await send(failed, "b")).body).details).toEqual({});
  });

  it("frees a failed_unknown key after 24 h", async () => {
    const key = randomUUID();
    step = () => {
      markSideEffect();
      return Promise.reject(new AppError(ErrorCode.sodexTimeout, "Timeout.", {}));
    };
    await send(key);
    await pool.query("update idempotency_keys set expires_at = $2 where key = $1", [
      key,
      new Date(now.getTime() - 1),
    ]);
    step = () => Promise.resolve({ ok: true });
    expect((await send(key)).statusCode).toBe(202);
    expect(calls).toBe(2);
  });
});

describe("releasesKey", () => {
  it("releases only known pre-side-effect AppErrors before the marker", () => {
    const v = new AppError(ErrorCode.validationFailed, "x");
    expect(releasesKey(v, false)).toBe(true);
    expect(releasesKey(v, true)).toBe(false);
    expect(releasesKey(new AppError(ErrorCode.sodexTimeout, "x"), false)).toBe(false);
    expect(releasesKey(new AppError(ErrorCode.internal, "x"), false)).toBe(false);
    expect(releasesKey(new Error("x"), false)).toBe(false);
  });

  it("is a no-op outside idempotent()", () => {
    expect(() => {
      markSideEffect();
    }).not.toThrow();
  });
});
