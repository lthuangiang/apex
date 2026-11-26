import { users } from "@drift/db";
import { errorResponseSchema, featuresSchema, notificationSettingsSchema } from "@drift/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// #547 / DEC-397: GET /api/v1/features trả `sodexRewards` theo công tắc toàn hệ thống `REWARDS_ENABLED` (không phải cờ
// theo tài khoản). Mặc định tắt. Bổ sung #551: khi tắt, role team vẫn thấy để thử trên prod.

let env: TestEnv;
const rewards = { enabled: false };

beforeAll(async () => {
  env = await startTestEnv({ rewards });
});
afterAll(async () => {
  await env.close();
});

async function features(client: TestClient) {
  const r = await client.request("GET", "/api/v1/features");
  expect(r.statusCode).toBe(200);
  return featuresSchema.parse(r.json());
}

describe("GET /api/v1/features sodexRewards", () => {
  it("follows REWARDS_ENABLED for every user, signed in or not", async () => {
    const user = new TestClient(env.app);
    await signIn(env, user, "rewards-user@example.com");
    const anon = new TestClient(env.app);

    rewards.enabled = false;
    expect((await features(user)).sodexRewards).toBe(false);
    expect((await features(anon)).sodexRewards).toBe(false);

    rewards.enabled = true;
    expect((await features(user)).sodexRewards).toBe(true);
    expect((await features(anon)).sodexRewards).toBe(true);
    // Công tắc chung, không bật / tắt cờ khác theo tài khoản.
    expect((await features(user)).signalResearch).toBe(false);
    rewards.enabled = false;
  });

  it("switch off: team still sees rewards, other users don't; switch on: everyone (#551)", async () => {
    const user = new TestClient(env.app);
    await signIn(env, user, "rewards-plain@example.com");
    const team = new TestClient(env.app);
    await signIn(env, team, "rewards-team@example.com");
    await env.db
      .update(users)
      .set({ role: "team" })
      .where(eq(users.email, "rewards-team@example.com"));
    const anon = new TestClient(env.app);

    rewards.enabled = false;
    expect((await features(user)).sodexRewards).toBe(false);
    expect((await features(anon)).sodexRewards).toBe(false);
    expect((await features(team)).sodexRewards).toBe(true);

    rewards.enabled = true;
    expect((await features(user)).sodexRewards).toBe(true);
    expect((await features(team)).sodexRewards).toBe(true);
    expect((await features(anon)).sodexRewards).toBe(true);
    rewards.enabled = false;
  });

  it("the SoDEX rewards notification group follows the same rule (#558)", async () => {
    const user = new TestClient(env.app);
    await signIn(env, user, "rewards-notif-user@example.com");
    const team = new TestClient(env.app);
    await signIn(env, team, "rewards-notif-team@example.com");
    await env.db
      .update(users)
      .set({ role: "team" })
      .where(eq(users.email, "rewards-notif-team@example.com"));
    const groups = async (c: TestClient) =>
      notificationSettingsSchema.parse(
        (await c.request("GET", "/api/v1/notifications/settings")).json(),
      ).groups;
    const rewardsRow = async (c: TestClient) =>
      (await groups(c)).find((g) => g.group === "rewards");

    // Tắt: user thường không có nhóm, không đổi được; team có.
    rewards.enabled = false;
    expect(await rewardsRow(user)).toBeUndefined();
    const denied = await user.request("PUT", "/api/v1/notifications/settings", {
      body: { group: "rewards", channel: "email", enabled: true },
    });
    expect(errorResponseSchema.parse(denied.json()).error.code).toBe("FORBIDDEN");
    expect(await rewardsRow(team)).toEqual({
      group: "rewards",
      alwaysOn: false,
      in_app: true,
      email: false,
      telegram: true,
    });

    // Bật: mọi user có nhóm, mặc định in-app bật / Telegram bật khi đã kết nối / email tắt; đổi được.
    rewards.enabled = true;
    expect(await rewardsRow(user)).toEqual({
      group: "rewards",
      alwaysOn: false,
      in_app: true,
      email: false,
      telegram: true,
    });
    const email = await user.request("PUT", "/api/v1/notifications/settings", {
      body: { group: "rewards", channel: "email", enabled: true },
    });
    expect(
      notificationSettingsSchema.parse(email.json()).groups.find((g) => g.group === "rewards"),
    ).toMatchObject({ in_app: true, email: true, telegram: true });
    rewards.enabled = false;
  });
});
