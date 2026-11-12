import { meSchema, notificationSettingsSchema, errorResponseSchema } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Báo team qua Telegram (DEC-184): sự kiện đăng ký ghi vào outbox `jobs.team_ops`; nhóm `teamOps` trong Settings chỉ
// có với role team và chỉ kênh Telegram.

let env: TestEnv;
beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => {
  await env.close();
});

const teamOpsFor = async (userId: string) =>
  (
    await env.pool.query<{ payload: { type: string; userId: string } }>(
      "select payload from outbox where topic = 'jobs.team_ops' and payload->>'userId' = $1",
      [userId],
    )
  ).rows.map((r) => r.payload.type);

describe("team ops events", () => {
  it("records a signup once, by email code and by password, but not on a later sign-in", async () => {
    const otp = new TestClient(env.app);
    const me = meSchema.parse((await signIn(env, otp, "team-ops-otp@example.com")).json());
    expect(await teamOpsFor(me.id)).toEqual(["team_signup"]);
    await signIn(env, new TestClient(env.app), "team-ops-otp@example.com");
    expect(await teamOpsFor(me.id)).toEqual(["team_signup"]);

    const pw = new TestClient(env.app);
    const reg = await pw.request("POST", "/api/v1/auth/register", {
      body: { email: "team-ops-pw@example.com", password: "a-long-enough-password-1" },
    });
    expect(reg.statusCode).toBeLessThan(300);
    const { rows } = await env.pool.query<{ id: string }>(
      "select id from users where email = 'team-ops-pw@example.com'",
    );
    expect(await teamOpsFor(rows[0]?.id ?? "")).toEqual(["team_signup"]);
  });
});

describe("teamOps setting", () => {
  it("shows Team updates only to the team, Telegram only", async () => {
    const customer = new TestClient(env.app);
    await signIn(env, customer, "team-ops-customer@example.com");
    const groups = async (c: TestClient) =>
      notificationSettingsSchema.parse(
        (await c.request("GET", "/api/v1/notifications/settings")).json(),
      ).groups;
    expect((await groups(customer)).map((g) => g.group)).not.toContain("teamOps");
    const denied = await customer.request("PUT", "/api/v1/notifications/settings", {
      body: { group: "teamOps", channel: "telegram", enabled: false },
    });
    expect(errorResponseSchema.parse(denied.json()).error.code).toBe("FORBIDDEN");

    const team = new TestClient(env.app);
    const me = meSchema.parse((await signIn(env, team, "team-ops-member@example.com")).json());
    await env.pool.query("update users set role = 'team' where id = $1", [me.id]);
    const row = (await groups(team)).find((g) => g.group === "teamOps");
    expect(row).toMatchObject({ in_app: false, email: false, telegram: true, alwaysOn: false });
    const email = await team.request("PUT", "/api/v1/notifications/settings", {
      body: { group: "teamOps", channel: "email", enabled: true },
    });
    expect(errorResponseSchema.parse(email.json()).error.code).toBe("VALIDATION_FAILED");
    const off = await team.request("PUT", "/api/v1/notifications/settings", {
      body: { group: "teamOps", channel: "telegram", enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect((await groups(team)).find((g) => g.group === "teamOps")?.telegram).toBe(false);
  });
});
