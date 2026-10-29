import { randomUUID } from "node:crypto";

import {
  backupCodesSchema,
  errorResponseSchema,
  meSchema,
  sessionListSchema,
  twoFactorSetupSchema,
} from "@drift/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { generateTotp } from "../src/lib/totp";
import { OTP_RESEND_COOLDOWN_MS } from "../src/modules/auth/service";

import { lastCode, signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

let env: TestEnv;
let n = 0;
const nextEmail = () => `trader${String((n += 1))}@example.com`;
const errorCode = (body: string) => errorResponseSchema.parse(JSON.parse(body)).error.code;

beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => {
  // Mỗi test đi tới một thời điểm mới để cooldown OTP không ảnh hưởng nhau.
  env.clock.now = new Date(env.clock.now.getTime() + 2 * 60 * 60 * 1000);
});

const advance = (ms: number) => {
  env.clock.now = new Date(env.clock.now.getTime() + ms);
};

describe("email OTP sign-in", () => {
  it("creates the user on first sign-in and returns the session", async () => {
    const client = new TestClient(env.app);
    const email = nextEmail();
    const otp = await client.request("POST", "/api/v1/auth/otp", {
      body: { email: email.toUpperCase() },
    });
    expect(otp.statusCode).toBe(202);
    expect(env.mails.at(-1)?.to).toBe(email);

    const session = await client.request("POST", "/api/v1/auth/session", {
      body: { email, code: lastCode(env.mails) },
    });
    expect(session.statusCode).toBe(201);
    expect(meSchema.parse(session.json()).email).toBe(email);
    const cookie = session.cookies.find((c) => c.name === "drift_session");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });

    const me = await client.request("GET", "/api/v1/me");
    expect(me.statusCode).toBe(200);
  });

  it("rejects a wrong code and locks the code after 5 attempts", async () => {
    const client = new TestClient(env.app);
    const email = nextEmail();
    await client.request("POST", "/api/v1/auth/otp", { body: { email } });
    const code = lastCode(env.mails);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i += 1) {
      const res = await client.request("POST", "/api/v1/auth/session", {
        body: { email, code: wrong },
      });
      expect(errorCode(res.body)).toBe("OTP_INVALID");
    }
    const res = await client.request("POST", "/api/v1/auth/session", { body: { email, code } });
    expect(errorCode(res.body)).toBe("OTP_INVALID");
  });

  it("rejects an expired code and a reused code", async () => {
    const client = new TestClient(env.app);
    const email = nextEmail();
    await client.request("POST", "/api/v1/auth/otp", { body: { email } });
    advance(11 * 60 * 1000);
    let res = await client.request("POST", "/api/v1/auth/session", {
      body: { email, code: lastCode(env.mails) },
    });
    expect(errorCode(res.body)).toBe("OTP_INVALID");

    await client.request("POST", "/api/v1/auth/otp", { body: { email } });
    const code = lastCode(env.mails);
    expect(
      (await client.request("POST", "/api/v1/auth/session", { body: { email, code } })).statusCode,
    ).toBe(201);
    res = await new TestClient(env.app).request("POST", "/api/v1/auth/session", {
      body: { email, code },
    });
    expect(errorCode(res.body)).toBe("OTP_INVALID");
  });

  it("rate limits code requests", async () => {
    const client = new TestClient(env.app);
    const email = nextEmail();
    await client.request("POST", "/api/v1/auth/otp", { body: { email } });
    const res = await client.request("POST", "/api/v1/auth/otp", { body: { email } });
    expect(res.statusCode).toBe(429);
    advance(OTP_RESEND_COOLDOWN_MS);
    expect((await client.request("POST", "/api/v1/auth/otp", { body: { email } })).statusCode).toBe(
      202,
    );
  });

  it("requires the CSRF header on writes", async () => {
    const client = new TestClient(env.app);
    const res = await client.request("POST", "/api/v1/auth/otp", {
      body: { email: nextEmail() },
      csrf: false,
    });
    expect(res.statusCode).toBe(403);
    expect(errorCode(res.body)).toBe("FORBIDDEN");
  });

  it("returns 401 without a session", async () => {
    const res = await new TestClient(env.app).request("GET", "/api/v1/me");
    expect(res.statusCode).toBe(401);
    expect(errorCode(res.body)).toBe("UNAUTHENTICATED");
  });
});

describe("sessions", () => {
  it("slides the 7-day expiry with activity and caps at 30 days", async () => {
    const client = new TestClient(env.app);
    await signIn(env, client, nextEmail());
    for (let day = 0; day < 4; day += 1) {
      advance(6 * 24 * 60 * 60 * 1000);
      expect((await client.request("GET", "/api/v1/me")).statusCode).toBe(200);
    }
    advance(7 * 24 * 60 * 60 * 1000); // ngày 31: quá trần tuyệt đối
    expect((await client.request("GET", "/api/v1/me")).statusCode).toBe(401);
  });

  it("expires after 7 idle days", async () => {
    const client = new TestClient(env.app);
    await signIn(env, client, nextEmail());
    advance(7 * 24 * 60 * 60 * 1000 + 1000);
    expect((await client.request("GET", "/api/v1/me")).statusCode).toBe(401);
  });

  it("lists sessions and signs out another one", async () => {
    const email = nextEmail();
    const laptop = new TestClient(env.app);
    const phone = new TestClient(env.app);
    await signIn(env, laptop, email);
    advance(OTP_RESEND_COOLDOWN_MS);
    await signIn(env, phone, email);

    const list = sessionListSchema.parse(
      (await laptop.request("GET", "/api/v1/security/sessions")).json(),
    );
    expect(list.items).toHaveLength(2);
    const other = list.items.find((s) => !s.current);
    expect(other).toBeDefined();

    const res = await laptop.request("DELETE", `/api/v1/security/sessions/${other?.id ?? ""}`);
    expect(res.statusCode).toBe(204);
    expect((await phone.request("GET", "/api/v1/me")).statusCode).toBe(401);
    expect((await laptop.request("GET", "/api/v1/me")).statusCode).toBe(200);
  });

  it("signs out", async () => {
    const client = new TestClient(env.app);
    await signIn(env, client, nextEmail());
    expect((await client.request("DELETE", "/api/v1/auth/session")).statusCode).toBe(204);
    expect((await client.request("GET", "/api/v1/me")).statusCode).toBe(401);
  });
});

describe("two-factor authentication", () => {
  async function enable(client: TestClient) {
    const setup = twoFactorSetupSchema.parse(
      (await client.request("POST", "/api/v1/security/2fa/setup")).json(),
    );
    expect(setup.otpauthUri).toMatch(/^otpauth:\/\/totp\/DRIFT:/);
    const enabled = await client.request("POST", "/api/v1/security/2fa/enable", {
      body: { code: generateTotp(setup.secret, env.clock.now) },
    });
    expect(enabled.statusCode).toBe(200);
    return {
      secret: setup.secret,
      backupCodes: backupCodesSchema.parse(enabled.json()).backupCodes,
    };
  }

  it("enables 2FA and then requires it at sign-in", async () => {
    const email = nextEmail();
    const client = new TestClient(env.app);
    await signIn(env, client, email);
    const { secret, backupCodes } = await enable(client);
    expect(backupCodes).toHaveLength(10);
    expect(
      meSchema.parse((await client.request("GET", "/api/v1/me")).json()).twoFactorEnabled,
    ).toBe(true);

    advance(OTP_RESEND_COOLDOWN_MS + 60_000);
    const other = new TestClient(env.app);
    await other.request("POST", "/api/v1/auth/otp", { body: { email } });
    const code = lastCode(env.mails);
    let res = await other.request("POST", "/api/v1/auth/session", { body: { email, code } });
    expect(errorCode(res.body)).toBe("TWO_FACTOR_REQUIRED");

    // OTP vẫn dùng được sau khi bị đòi 2FA.
    const totp = generateTotp(secret, env.clock.now);
    res = await other.request("POST", "/api/v1/auth/session", {
      body: { email, code, twoFactorCode: totp },
    });
    expect(res.statusCode).toBe(201);

    // Cùng mã TOTP không dùng lại được.
    advance(OTP_RESEND_COOLDOWN_MS);
    const third = new TestClient(env.app);
    await third.request("POST", "/api/v1/auth/otp", { body: { email } });
    res = await third.request("POST", "/api/v1/auth/session", {
      body: { email, code: lastCode(env.mails), twoFactorCode: totp },
    });
    expect(errorCode(res.body)).toBe("TWO_FACTOR_INVALID");
  });

  it("accepts each backup code once", async () => {
    const email = nextEmail();
    const client = new TestClient(env.app);
    await signIn(env, client, email);
    const { backupCodes } = await enable(client);
    const backup = backupCodes[0] ?? "";

    advance(OTP_RESEND_COOLDOWN_MS);
    expect(
      (await signIn(env, new TestClient(env.app), email, backup.toLowerCase())).statusCode,
    ).toBe(201);
    advance(OTP_RESEND_COOLDOWN_MS);
    const res = await signIn(env, new TestClient(env.app), email, backup);
    expect(errorCode(res.body)).toBe("TWO_FACTOR_INVALID");
  });

  it("does not store or replay secrets through Idempotency-Key", async () => {
    const client = new TestClient(env.app);
    await signIn(env, client, nextEmail());
    const key = randomUUID();
    expect(
      (await client.request("POST", "/api/v1/security/2fa/setup", { idempotencyKey: key }))
        .statusCode,
    ).toBe(200);
    const replay = await client.request("POST", "/api/v1/security/2fa/setup", {
      idempotencyKey: key,
    });
    expect(replay.statusCode).toBe(409);
    const stored = await env.pool.query<{ response: unknown }>(
      "select response from idempotency_keys where key = $1",
      [key],
    );
    expect(stored.rows[0]?.response).toBeNull();
  });
});

describe("idempotency", () => {
  it("requires the header and rejects a reused key with a different request", async () => {
    const client = new TestClient(env.app);
    await signIn(env, client, nextEmail());
    const missing = await client.request("POST", "/api/v1/security/2fa/setup", {
      idempotencyKey: false,
    });
    expect(errorCode(missing.body)).toBe("VALIDATION_FAILED");

    const key = randomUUID();
    await client.request("POST", "/api/v1/security/2fa/setup", { idempotencyKey: key });
    const conflict = await client.request("POST", "/api/v1/security/2fa/enable", {
      idempotencyKey: key,
      body: { code: "123456" },
    });
    expect(errorCode(conflict.body)).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });
});

describe("logging", () => {
  it("never logs OTP codes, cookies or session tokens", async () => {
    const client = new TestClient(env.app);
    await signIn(env, client, nextEmail());
    await client.request("GET", "/api/v1/me");
    const all = env.logs.join("\n");
    expect(all).not.toContain(lastCode(env.mails));
    expect(all).not.toContain(client.session ?? "missing");
  });
});
