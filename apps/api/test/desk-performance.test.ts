import { randomUUID } from "node:crypto";

import { deskPerformanceSchema, errorResponseSchema, meSchema } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// AI Desk "How your bots performed" (#234): chỉ bot tiền thật MM / VB của chính người gọi, chỉ số đã tổng hợp
// (không có snapshot tín hiệu), công thức kỳ của Platform Stats, gợi ý trong cài đặt có thật.

let env: TestEnv;
const NOW = new Date("2026-11-18T12:00:00Z");
const MIN = 60_000;
const errorOf = (body: unknown) => errorResponseSchema.parse(body).error;

beforeAll(async () => {
  env = await startTestEnv();
  env.clock.now = NOW;
});
afterAll(async () => {
  await env.close();
});

async function deskUser(desk = true) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, `perf-${randomUUID()}@drift.test`)).json());
  await env.pool.query("update users set ai_desk = $2 where id = $1", [me.id, desk]);
  const { rows } = await env.pool.query<{ id: string }>(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
    [
      me.id,
      `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`,
      Math.floor(Math.random() * 1e9),
    ],
  );
  return { client, userId: me.id, acc: rows[0]?.id ?? "" };
}

async function bot(
  u: { userId: string; acc: string },
  strategy: string,
  market: string,
  name: string,
  opts: { mode?: string; config?: Record<string, unknown> } = {},
) {
  const { rows } = await env.pool.query<{ id: string }>(
    `insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode)
     values (gen_random_uuid(), $1, $2, $3, $4, 'perps', $5, 'running', $6) returning id`,
    [u.userId, u.acc, strategy, market, name, opts.mode ?? "live"],
  );
  const id = rows[0]?.id ?? "";
  if (opts.config !== undefined) {
    const v = await env.pool.query<{ id: string }>(
      "insert into bot_versions (id, bot_id, version, config, param_source, status, applied_at) values (gen_random_uuid(), $1, 1, $2, 'manual', 'active', now()) returning id",
      [id, JSON.stringify(opts.config)],
    );
    await env.pool.query("update bots set active_version_id = $2 where id = $1", [
      id,
      v.rows[0]?.id,
    ]);
  }
  return id;
}

let seq = 0;
const TRADE_ID_BASE = Date.now() * 1000 + Math.floor(Math.random() * 1000);
/** Một lệnh + một fill. */
async function fill(
  botId: string,
  acc: string,
  market: string,
  side: "buy" | "sell",
  price: number,
  at: Date,
  opts: { fee?: number; builder?: number; tag?: string; clOrdId?: string } = {},
) {
  seq += 1;
  const clOrdId = opts.clOrdId ?? `perf-${String(seq)}-${randomUUID().slice(0, 8)}`;
  const o = await env.pool.query<{ id: string }>(
    `insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, filled_size, status, tag, epoch, created_at)
     values (gen_random_uuid(), $1, $2, $3, $4, 'perps', $5, 'limit', 'GTX', 1, 1, 'filled', $6, 1, $7) returning id`,
    [botId, acc, clOrdId, market, side, opts.tag ?? "vm", at],
  );
  await env.pool.query(
    "insert into fills (id, order_id, sodex_trade_id, price, size, fee, builder_fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, $3, 1, $4, $5, true, $6)",
    [
      o.rows[0]?.id,
      // sodex_trade_id là bigint: số duy nhất trong lần chạy test.
      String(TRADE_ID_BASE + seq),
      price,
      opts.fee ?? 0.05,
      opts.builder ?? 0.01,
      at,
    ],
  );
  return clOrdId;
}

const get = (c: TestClient, q = "") => c.request("GET", `/api/v1/desk/performance${q}`);

describe("How your bots performed", () => {
  it("needs a session and AI Desk", async () => {
    expect((await get(new TestClient(env.app))).statusCode).toBe(401);
    const off = await deskUser(false);
    const res = await get(off.client);
    expect(res.statusCode).toBe(403);
    expect(errorOf(res.json()).code).toBe("FORBIDDEN");
  });

  it("reports no bots, then not enough fills", async () => {
    const u = await deskUser();
    expect(deskPerformanceSchema.parse((await get(u.client)).json()).state).toBe("noBots");
    const market = `PN${randomUUID().slice(0, 5).toUpperCase()}-USD`;
    const id = await bot(u, "volume_maker", market, "Few");
    for (let i = 0; i < 5; i++) {
      await fill(id, u.acc, market, "buy", 100, new Date(NOW.getTime() - (10 + i) * MIN));
      await fill(id, u.acc, market, "sell", 100, new Date(NOW.getTime() - (9 + i) * MIN));
    }
    const v = deskPerformanceSchema.parse((await get(u.client)).json());
    expect(v.state).toBe("notEnough");
    expect(v.current.fills).toBe(10);
  });

  it("counts only the caller's live Market Making and Volume Builder bots, with fees split and price on the rest", async () => {
    const a = await deskUser();
    const b = await deskUser();
    const market = `PF${randomUUID().slice(0, 5).toUpperCase()}-USD`;
    const mm = await bot(a, "volume_maker", market, "A Market Making");
    const paper = await bot(a, "volume_maker", market, "A paper", { mode: "paper" });
    const grid = await bot(a, "futures_grid", market, "A Grid");
    const other = await bot(b, "volume_maker", market, "B Market Making");
    // 20 vòng mua 100 / bán 99.9, phí 0.05 (builder 0.01) mỗi fill: net = −2 − 2 = −4, volume 3998.
    for (let i = 0; i < 20; i++) {
      const t = NOW.getTime() - (200 - i * 5) * MIN;
      await fill(mm, a.acc, market, "buy", 100, new Date(t));
      await fill(mm, a.acc, market, "sell", 99.9, new Date(t + MIN));
      for (const x of [paper, grid]) {
        await fill(x, a.acc, market, "buy", 100, new Date(t));
        await fill(x, a.acc, market, "sell", 90, new Date(t + MIN));
      }
      await fill(other, b.acc, market, "buy", 100, new Date(t));
      await fill(other, b.acc, market, "sell", 50, new Date(t + MIN));
    }
    const res = await get(a.client, "?period=7d&tz=Asia%2FHo_Chi_Minh");
    expect(res.statusCode).toBe(200);
    const v = deskPerformanceSchema.parse(res.json());
    expect(v.state).toBe("ready");
    expect(v.bots.map((x) => x.name)).toEqual(["A Market Making"]);
    expect(v.current.fills).toBe(40);
    expect(v.current.volume).toBe("3998");
    expect(v.current.cost).toBe("4");
    expect(v.current.sodexFee).toBe("1.6");
    expect(v.current.builderFee).toBe("0.4");
    expect(v.current.priceMove).toBe("2");
    expect(v.current.perMillion.cost).toBe("1000.5");
    // Kỳ trước không giao dịch.
    expect(v.previous).toBeNull();
    expect(v.hours).toHaveLength(24);
    // Không trả snapshot hay dữ liệu người khác.
    expect(res.body).not.toMatch(/candleMomentum|regime|spreadBps|B Market Making|"signal"/);
  });

  it("shows Volume Builder exits and a sideways idea from the entry signal, without sending the signal", async () => {
    const u = await deskUser();
    const market = `PV${randomUUID().slice(0, 5).toUpperCase()}-USD`;
    const vb = await bot(u, "volume_farm", market, "My VB", {
      config: { market, sidewaysOnly: false, maxSpreadBps: "10" },
    });
    // 40 lượt vào khi đi ngang (lỗ ít) và 40 lượt vào khi có xu hướng (lỗ nhiều).
    for (let i = 0; i < 80; i++) {
      const trend = i % 2 === 0;
      const t0 = NOW.getTime() - (2000 - i * 20) * MIN;
      const clOrdId = await fill(vb, u.acc, market, "buy", 100, new Date(t0), {
        tag: `vf:${String(i + 1)}:in:0`,
      });
      await fill(vb, u.acc, market, "sell", trend ? 99.8 : 99.98, new Date(t0 + 2 * MIN), {
        tag: `vf:${String(i + 1)}:out:0`,
      });
      const signal = {
        v: 1,
        direction: "long",
        side: "long",
        score: 0.7,
        confidence: 0.6,
        regime: trend ? "TREND_UP" : "SIDEWAY",
        components: {
          candleMomentum: 0.7,
          wickRejection: 0.5,
          volumeAcceleration: 0.6,
          tradePressure: 0.5,
          orderbookImbalance: 0.5,
        },
        spreadBps: 1,
        reason: "test",
        reversed: false,
        balanced: false,
        price: {
          bid: "99.99",
          ask: "100.01",
          mid: "100",
          last: "100",
          mark: null,
          bookAgeMs: 100,
          chg1mBps: 1,
          chg3mBps: 2,
          chg5mBps: 3,
        },
        order: {
          clOrdID: clOrdId,
          price: "100",
          size: "1",
          usd: "100",
          holdSecs: 120,
          entryTry: 0,
          taker: false,
        },
      };
      await env.pool.query(
        "insert into bot_events (id, bot_id, type, decision, payload, occurred_at) values (gen_random_uuid(), $1, 'decision', 'Enter long', $2, $3)",
        [vb, JSON.stringify({ signal }), new Date(t0 - 1000)],
      );
      await env.pool.query(
        "insert into bot_events (id, bot_id, type, decision, why, occurred_at) values (gen_random_uuid(), $1, 'decision', 'Closed long', $2, $3)",
        [vb, trend ? "Stop loss hit" : "Hold time ended", new Date(t0 + 2 * MIN + 1000)],
      );
    }
    const res = await get(u.client, "?period=7d");
    const v = deskPerformanceSchema.parse(res.json());
    expect(v.exits?.trades).toBe(80);
    expect(v.exits?.items.map((x) => [x.reason, x.trades])).toEqual(
      expect.arrayContaining([
        ["stopLoss", 40],
        ["holdTime", 40],
      ]),
    );
    const idea = v.ideas.find((x) => x.kind === "sidewaysOnly");
    expect(idea?.botName).toBe("My VB");
    expect(Number(idea?.worseCostPerMillion)).toBeGreaterThan(Number(idea?.betterCostPerMillion));
    expect(idea?.worseShare).toBe(0.5);
    // Spread 1 bp ≤ mức đề xuất 8 bp: không có gợi ý Max spread.
    expect(v.ideas.some((x) => x.kind === "maxSpread")).toBe(false);
    expect(res.body).not.toMatch(/candleMomentum|TREND_UP|SIDEWAY|spreadBps|"signal"/);
    // Đã bật "Only trade sideways": không gợi ý nữa.
    await env.pool.query(
      "update bot_versions set config = jsonb_set(config, '{sidewaysOnly}', 'true') where bot_id = $1",
      [vb],
    );
    const again = deskPerformanceSchema.parse((await get(u.client)).json());
    expect(again.ideas.some((x) => x.kind === "sidewaysOnly")).toBe(false);
  });

  it("rejects an unknown period or time zone with the standard error", async () => {
    const u = await deskUser();
    const bad = await get(u.client, "?period=1y");
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad.json()).code).toBe("VALIDATION_FAILED");
    expect((await get(u.client, "?tz=Mars%2FBase")).statusCode).toBe(400);
  });
});
