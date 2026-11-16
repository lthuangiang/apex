import { randomBytes } from "node:crypto";

import {
  botDetailSchema,
  botListSchema,
  botSummarySchema,
  BotState,
  meSchema,
  ReasonCode,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { stopDetailsOf, summary } from "../src/modules/bots/service";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Market Making dừng với MAX_CYCLES: API cho biết là đủ volume target hay hết giờ (DEC-262), đọc từ
// nhật ký "Volume Maker stopped" lúc dừng, không từ config hiện tại (sửa bot đã dừng kích hoạt version mới ngay).

let env: TestEnv;
beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => {
  await env.close();
});

const vmConfig = (over: Record<string, unknown> = {}) => ({
  market: "BTC-USD",
  orderSize: "20",
  leverage: 5,
  costBudget: "10",
  maxOrders: 1,
  quoteLevel: 0,
  refreshSeconds: 3,
  runUntil: "target_or_budget",
  onStop: "close_inventory",
  ...over,
});

async function user(email: string) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  const acc = (
    await env.pool.query<{ id: string }>(
      "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'disconnected') returning id",
      [me.id, `0x${randomBytes(20).toString("hex")}`, Math.floor(Math.random() * 1e9)],
    )
  ).rows[0]?.id;
  return { client, userId: me.id, acc: acc ?? "" };
}

/** Bot Market Making đã dừng; `events` theo thứ tự thời gian; `versions` = config từng version, version cuối active. */
async function seedBot(
  u: { userId: string; acc: string },
  o: {
    name: string;
    strategy?: string;
    reason?: string | null;
    events: { type: string; decision: string; why: string }[];
    versions: Record<string, unknown>[];
  },
) {
  const strategy = o.strategy ?? "volume_maker";
  const bot =
    (
      await env.pool.query<{ id: string }>(
        "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, reason_code) values (gen_random_uuid(), $1, $2, $3, 'BTC-USD', 'perps', $4, 'stopped', $5) returning id",
        [
          u.userId,
          u.acc,
          strategy,
          o.name,
          o.reason === undefined ? ReasonCode.maxCycles : o.reason,
        ],
      )
    ).rows[0]?.id ?? "";
  let active = "";
  for (const [i, config] of o.versions.entries()) {
    const last = i === o.versions.length - 1;
    active =
      (
        await env.pool.query<{ id: string }>(
          "insert into bot_versions (id, bot_id, version, config, param_source, status, applied_at) values (gen_random_uuid(), $1, $2, $3, 'manual', $4, now()) returning id",
          [bot, i + 1, JSON.stringify(config), last ? "active" : "superseded"],
        )
      ).rows[0]?.id ?? "";
  }
  await env.pool.query("update bots set active_version_id = $2 where id = $1", [bot, active]);
  const t0 = env.clock.now.getTime() - 3_600_000;
  for (const [i, e] of o.events.entries())
    await env.pool.query(
      "insert into bot_events (id, bot_id, type, decision, why, occurred_at) values (gen_random_uuid(), $1, $2, $3, $4, $5)",
      [bot, e.type, e.decision, e.why, new Date(t0 + i * 60_000)],
    );
  return bot;
}

const running = { type: "state", decision: "Running", why: "SoDEX acknowledged the first orders." };
const stopped = (why: string) => ({ type: "decision", decision: "Volume Maker stopped", why });

describe("stopDetail on the bot list", () => {
  it("uses the stop log, even after the bot was edited (both directions)", async () => {
    const u = await user("stop-detail-1@example.test");
    // Dừng ở 100k / 100k, rồi nâng target lên 200k: vẫn là volume target (state runtime không cần).
    const raised = await seedBot(u, {
      name: "raised",
      events: [running, stopped("Volume target 100000 reached.")],
      versions: [vmConfig({ volumeTarget: "100000" }), vmConfig({ volumeTarget: "200000" })],
    });
    // Hết giờ ở 5k, rồi hạ target xuống 1k (dưới khối lượng đã giao dịch): vẫn là end time.
    const lowered = await seedBot(u, {
      name: "lowered",
      events: [running, stopped("Run time ended.")],
      versions: [
        vmConfig({ volumeTarget: "100000", runUntil: "date", untilAt: 1 }),
        vmConfig({ volumeTarget: "1000" }),
      ],
    });
    // Không có nhật ký dừng: null (UI hiện nhãn chung).
    const noLog = await seedBot(u, {
      name: "no-log",
      events: [running],
      versions: [vmConfig({ runUntil: "season_end", untilAt: 1 })],
    });
    // Nhật ký dừng cũ, đã chạy lại sau đó: không dùng.
    const restarted = await seedBot(u, {
      name: "restarted",
      events: [running, stopped("Run time ended."), running],
      versions: [vmConfig()],
    });
    // Dừng vì chi phí: không phải MAX_CYCLES.
    const budget = await seedBot(u, {
      name: "budget",
      reason: ReasonCode.budgetDone,
      events: [running, stopped("Cost 10 reached the budget of 10.")],
      versions: [vmConfig()],
    });

    const list = botListSchema.parse((await u.client.request("GET", "/api/v1/bots")).json());
    const detail = (id: string) => list.items.find((b) => b.id === id)?.stopDetail;
    expect(detail(raised)).toBe("volume_target");
    expect(detail(lowered)).toBe("end_time");
    expect(detail(noLog)).toBeNull();
    expect(detail(restarted)).toBeNull();
    expect(detail(budget)).toBeNull();

    // Trang bot dùng cùng nguồn.
    const res = await u.client.request("GET", `/api/v1/bots/${raised}`);
    expect(res.statusCode).toBe(200);
    expect(botDetailSchema.parse(res.json()).bot.stopDetail).toBe("volume_target");
  });

  it("loads the stop logs of the whole list in one query", async () => {
    const u = await user("stop-detail-2@example.test");
    const ids = [];
    for (const i of [1, 2, 3, 4])
      ids.push(
        await seedBot(u, {
          name: `vm-${String(i)}`,
          events: [running, stopped(i % 2 === 0 ? "Run time ended." : "Volume target 50 reached.")],
          versions: [vmConfig()],
        }),
      );
    const rows = (
      await env.pool.query<{
        id: string;
        strategy: string;
        reason_code: string | null;
      }>("select id, strategy, reason_code from bots where id = any($1)", [ids])
    ).rows.map((r) => ({ id: r.id, strategy: r.strategy, reasonCode: r.reason_code }));

    let calls = 0;
    const counting = new Proxy(env.db, {
      get(target, prop, receiver) {
        const v: unknown = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (prop === "select" || prop === "selectDistinctOn" || prop === "execute") calls += 1;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const map = await stopDetailsOf(counting, rows);
    expect(calls).toBe(1);
    expect(ids.map((id) => map.get(id))).toEqual([
      "volume_target",
      "end_time",
      "volume_target",
      "end_time",
    ]);

    // Không có bot Market Making dừng với MAX_CYCLES: không query.
    calls = 0;
    await stopDetailsOf(counting, [
      { id: ids[0] ?? "", strategy: "spot_grid", reasonCode: "MAX_CYCLES" },
    ]);
    expect(calls).toBe(0);
  });
});

describe("bot summary", () => {
  it("carries stopDetail and parses with the shared schema", () => {
    const row = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "BTC Market Making",
      strategy: "volume_maker",
      market: "BTC-USD",
      engine: "perps",
      state: BotState.stopped,
      reasonCode: ReasonCode.maxCycles,
      needsAttention: false,
      mode: "live",
      createdAt: new Date("2026-11-16T00:00:00Z"),
      updatedAt: new Date("2026-11-16T01:00:00Z"),
    } as unknown as Parameters<typeof summary>[0];
    const s = summary(row, 1, null, vmConfig(), 0, {}, "end_time");
    expect(botSummarySchema.parse(s).stopDetail).toBe("end_time");
    expect(summary(row, 1, null, vmConfig()).stopDetail).toBeNull();
  });
});
