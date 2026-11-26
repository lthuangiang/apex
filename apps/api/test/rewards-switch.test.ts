import { users } from "@drift/db";
import { featuresSchema } from "@drift/shared";
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
});
