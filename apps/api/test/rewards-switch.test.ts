import { featuresSchema } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// #547 / DEC-397: GET /api/v1/features trả `sodexRewards` theo công tắc toàn hệ thống `REWARDS_ENABLED`, giống nhau
// cho mọi user (không phải cờ theo tài khoản). Mặc định tắt.

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
});
