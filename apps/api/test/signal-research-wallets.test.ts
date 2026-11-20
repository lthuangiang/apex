import { randomUUID } from "node:crypto";

import { meSchema, researchWalletsSchema } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Research wallets (#353) qua API: danh sách tập ví nghiên cứu mới nhất cho khu "Bots & labels". Chỉ đọc DB (tập ví do
// scheduler ghi, lần đọc được do marketdata ghi); ở đây chèn thẳng. Không có Hyperliquid.

let env: TestEnv;
let team: TestClient;
let user: TestClient;
const url = "/api/v1/admin/signal-research/research-wallets";
const MIN = 60_000;

const W1 = "0x1111111111111111111111111111111111111111";
const W2 = "0x2222222222222222222222222222222222222222";
const W3 = "0x3333333333333333333333333333333333333333";

const ago = (min: number) => new Date(env.clock.now.getTime() - min * MIN);

async function stats(address: string) {
  await env.pool.query(
    `insert into leader_stats_daily (source, address, date, stats, hidden, tabs, profit, computed_at)
     values ('hyperliquid', $1, '2026-11-16', '{}', '{}', '{top}', 1000, now())`,
    [address],
  );
}

async function polled(address: string, at: Date | null) {
  await env.pool.query(
    `insert into leader_wallets (source, address, last_polled_at) values ('hyperliquid', $1, $2)`,
    [address, at],
  );
}

beforeAll(async () => {
  env = await startTestEnv();
  team = new TestClient(env.app);
  const teamId = meSchema.parse(
    (await signIn(env, team, `rw-${randomUUID()}@drift.test`)).json(),
  ).id;
  await env.pool.query("update users set role = 'team' where id = $1", [teamId]);
  user = new TestClient(env.app);
  await signIn(env, user, `rw-user-${randomUUID()}@drift.test`);
});

afterAll(async () => {
  await env.close();
});

describe("GET research-wallets (#353)", () => {
  it("is team only", async () => {
    expect((await user.request("GET", url)).statusCode).toBe(403);
  });

  it("has no set before the leaderboard has run", async () => {
    const r = await team.request("GET", url);
    expect(r.statusCode).toBe(200);
    expect(researchWalletsSchema.parse(r.json())).toEqual({
      set: null,
      windowMinutes: 60,
      items: [],
    });
  });

  it("lists the latest set by rank with the last read time, read-recently flag and trader page availability", async () => {
    await env.pool.query(
      `insert into research_wallet_sets (version, run_date, k, size, created_at) values
         (1, '2026-11-15', 30, 1, '2026-11-15T02:00:00Z'),
         (2, '2026-11-16', 30, 3, '2026-11-16T02:00:00Z')`,
    );
    await env.pool.query(
      `insert into research_wallet_set_members (set_version, address, rank) values
         (1, $4, 1), (2, $1, 2), (2, $2, 1), (2, $3, 3)`,
      [W1, W2, W3, "0x9999999999999999999999999999999999999999"],
    );
    await stats(W1);
    await stats(W2);
    // W2 đọc được 3 phút trước; W1 lần cuối 90 phút trước; W3 chưa đọc được lần nào và không có trang trader.
    await polled(W2, ago(3));
    await polled(W1, ago(90));

    const r = await team.request("GET", url);
    expect(r.statusCode).toBe(200);
    const body = researchWalletsSchema.parse(r.json());
    expect(body.set).toEqual({
      version: 2,
      runDate: "2026-11-16",
      k: 30,
      size: 3,
      createdAt: "2026-11-16T02:00:00.000Z",
    });
    expect(body.items).toEqual([
      {
        address: W2,
        rank: 1,
        hasProfile: true,
        lastReadAt: ago(3).toISOString(),
        readRecently: true,
      },
      {
        address: W1,
        rank: 2,
        hasProfile: true,
        lastReadAt: ago(90).toISOString(),
        readRecently: false,
      },
      { address: W3, rank: 3, hasProfile: false, lastReadAt: null, readRecently: false },
    ]);
  });
});
