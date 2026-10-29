import { errorResponseSchema, meSchema, twoFactorSetupSchema } from "@drift/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../src/lib/password";
import { generateTotp } from "../src/lib/totp";
import { LOGIN_LOCK_MS, LOGIN_MAX_FAILURES, setPassword } from "../src/modules/auth/service";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Đăng ký / đăng nhập bằng email + mật khẩu (DEC-76).

let env: TestEnv;
let n = 0;
const nextEmail = () => `pw${String((n += 1))}@example.com`;
const PASSWORD = "correct horse battery";
const errorCode = (body: string) => errorResponseSchema.parse(JSON.parse(body)).error.code;

beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => {
  env.clock.now = new Date(env.clock.now.getTime() + 2 * 60 * 60 * 1000);
});

const register = (client: TestClient, email: string, password = PASSWORD) =>
  client.request("POST", "/api/v1/auth/register", { body: { email, password } });
const login = (client: TestClient, email: string, password = PASSWORD, twoFactorCode?: string) =>
  client.request("POST", "/api/v1/auth/login", {
    body: { email, password, ...(twoFactorCode === undefined ? {} : { twoFactorCode }) },
  });

describe("password hashing", () => {
  it("verifies the right password only and never stores it in clear", async () => {
    const stored = await hashPassword(PASSWORD);
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(stored).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword("wrong password!!", stored)).toBe(false);
    expect(await verifyPassword(PASSWORD, "not-a-hash")).toBe(false);
  });
});

describe("email + password sign-up and sign-in", () => {
  it("registers, signs in at once, and sends no email", async () => {
    const client = new TestClient(env.app);
    const email = nextEmail();
    const mails = env.mails.length;
    const res = await register(client, email.toUpperCase());
    expect(res.statusCode).toBe(201);
    expect(meSchema.parse(res.json()).email).toBe(email);
    expect(client.session).toBeDefined();
    expect(env.mails.length).toBe(mails);
    expect((await client.request("GET", "/api/v1/me")).statusCode).toBe(200);
  });

  it("rejects short passwords, passwords with the email name, and taken emails", async () => {
    const client = new TestClient(env.app);
    const email = nextEmail();
    expect(errorCode((await register(client, email, "short")).body)).toBe("VALIDATION_FAILED");
    expect(
      errorCode((await register(client, email, `${email.split("@")[0] ?? ""}-1234567890`)).body),
    ).toBe("VALIDATION_FAILED");
    expect((await register(client, email)).statusCode).toBe(201);
    const again = await register(new TestClient(env.app), email);
    expect(again.statusCode).toBe(409);
    expect(errorCode(again.body)).toBe("EMAIL_TAKEN");
  });

  it("signs in with the right password and gives one error for wrong email or password", async () => {
    const email = nextEmail();
    await register(new TestClient(env.app), email);
    const client = new TestClient(env.app);
    expect((await login(client, email)).statusCode).toBe(201);
    expect(client.session).toBeDefined();

    const wrongPassword = await login(new TestClient(env.app), email, "wrong password!!");
    const unknownEmail = await login(new TestClient(env.app), nextEmail());
    expect(wrongPassword.statusCode).toBe(401);
    expect(errorCode(wrongPassword.body)).toBe("INVALID_CREDENTIALS");
    expect(errorCode(unknownEmail.body)).toBe("INVALID_CREDENTIALS");
  });

  it("locks the account after repeated failures, then unlocks", async () => {
    const email = nextEmail();
    await register(new TestClient(env.app), email);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      await login(new TestClient(env.app), email, "wrong password!!");
    }
    const locked = await login(new TestClient(env.app), email);
    expect(errorCode(locked.body)).toBe("RATE_LIMITED");
    env.clock.now = new Date(env.clock.now.getTime() + LOGIN_LOCK_MS + 1000);
    expect((await login(new TestClient(env.app), email)).statusCode).toBe(201);
  });

  it("asks for the 2FA code after the right password", async () => {
    const email = nextEmail();
    const client = new TestClient(env.app);
    await register(client, email);
    const setup = twoFactorSetupSchema.parse(
      (await client.request("POST", "/api/v1/security/2fa/setup")).json(),
    );
    await client.request("POST", "/api/v1/security/2fa/enable", {
      body: { code: generateTotp(setup.secret, env.clock.now) },
    });

    const noCode = await login(new TestClient(env.app), email);
    expect(errorCode(noCode.body)).toBe("TWO_FACTOR_REQUIRED");
    env.clock.now = new Date(env.clock.now.getTime() + 60_000);
    const withCode = await login(
      new TestClient(env.app),
      email,
      PASSWORD,
      generateTotp(setup.secret, env.clock.now),
    );
    expect(withCode.statusCode).toBe(201);
  });

  it("lets an operator set a password for an OTP-only account", async () => {
    const email = nextEmail();
    await signIn(env, new TestClient(env.app), email);
    expect(errorCode((await login(new TestClient(env.app), email)).body)).toBe(
      "INVALID_CREDENTIALS",
    );
    expect(await setPassword(env.db, email, PASSWORD)).toBe(true);
    expect((await login(new TestClient(env.app), email)).statusCode).toBe(201);
    expect(await setPassword(env.db, nextEmail(), PASSWORD)).toBe(false);
  });
});
