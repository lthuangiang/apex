import { randomUUID } from "node:crypto";

import {
  errorResponseSchema,
  meSchema,
  mmFillDetailSchema,
  signalAllViewSchema,
  signalMmFillsPageSchema,
  signalMmQuantilesSchema,
  signalMmViewSchema,
  signalVbEntriesPageSchema,
  signalVbViewSchema,
  vbEntryDetailSchema,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { QUERY_TIMEOUT } from "../src/modules/signal-analysis/common";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Signal Analysis (team, #233): chỉ role team; chỉ bot Market Making + Volume Builder tiền thật (paper và chiến lược khác
// bị loại); công thức trên dữ liệu seed (markout từ nến 1 phút / mid theo giây, chia phí / markout / tồn kho, what-if
// phía ngược lại, mẫu ít); thiếu giá → null, không bao giờ 0.

let env: TestEnv;
const T = new Date("2026-11-18T12:00:00Z");
const MM = `SM${randomUUID().slice(0, 6).toUpperCase()}-USD`;
const VB = `SV${randomUUID().slice(0, 6).toUpperCase()}-USD`;
/** Kịch bản 7 ngày: bot có vị thế mang sang và kỳ trước (MB), bot thiếu giá 1 phút và builder fee (MC). */
const MB = `SB${randomUUID().slice(0, 6).toUpperCase()}-USD`;
const MC = `SC${randomUUID().slice(0, 6).toUpperCase()}-USD`;
/** Bot mở, đóng một phần, mua thêm rồi bị cắt trong kỳ (ME). */
const ME = `SE${randomUUID().slice(0, 6).toUpperCase()}-USD`;
/** Bot vào kỳ với vị thế mang sang rồi bị cắt trong kỳ (MD). */
const MD = `SD${randomUUID().slice(0, 6).toUpperCase()}-USD`;
const DAY = 86_400_000;
const errorOf = (body: string) => errorResponseSchema.parse(JSON.parse(body)).error;
const at = (ms: number) => new Date(T.getTime() + ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;

let team: TestClient;
let user: TestClient;
let mmFillId = "";
let vbEntryId = "";
let bot: (strategy: string, market: string, mode: string, name: string) => Promise<string>;

const signal = {
  v: 1,
  direction: "long",
  side: "long",
  score: 0.7,
  confidence: 0.6,
  regime: "TREND_UP",
  components: {
    candleMomentum: 0.9,
    wickRejection: 0.5,
    volumeAcceleration: 0.55,
    tradePressure: 0.5,
    orderbookImbalance: 0.5,
  },
  spreadBps: 1,
  reason: "LONG: score 0.700, regime TREND_UP",
  reversed: false,
  balanced: false,
  price: {
    bid: "99.995",
    ask: "100.005",
    mid: "100",
    last: "100",
    mark: null,
    bookAgeMs: 200,
    chg1mBps: 2,
    chg3mBps: 5,
    chg5mBps: 6,
  },
  order: {
    clOrdID: "",
    price: "100",
    size: "1",
    usd: "100",
    holdSecs: 60,
    entryTry: 0,
    taker: false,
  },
};

const ctx = (level: number, smart: boolean, fairBp: number | null) => ({
  v: 1,
  reason: "refresh",
  mid: "100",
  bid: "99.99",
  ask: "100.01",
  fair: smart ? "100" : null,
  fairAgeMs: smart ? 100 : null,
  level,
  bp: -1,
  fairBp,
  pos: "0",
  smart,
  sig: null,
  fastPause: false,
});

beforeAll(async () => {
  env = await startTestEnv();
  env.clock.now = T;
  team = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, team, `sa-${randomUUID()}@drift.test`)).json());
  await env.pool.query("update users set role = 'team' where id = $1", [me.id]);
  user = new TestClient(env.app);
  await signIn(env, user, `sa-user-${randomUUID()}@drift.test`);

  const { rows: acc } = await env.pool.query<{ id: string }>(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
    [me.id, "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db", Math.floor(Math.random() * 1e9)],
  );
  const account = acc[0]?.id ?? "";
  bot = async (strategy: string, market: string, mode: string, name: string) => {
    const { rows } = await env.pool.query<{ id: string }>(
      "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode) values (gen_random_uuid(), $1, $2, $3, $4, 'perps', $5, 'running', $6) returning id",
      [me.id, account, strategy, market, name, mode],
    );
    return rows[0]?.id ?? "";
  };
  const mmLive = await bot("volume_maker", MM, "live", "MM live");
  const mmPaper = await bot("volume_maker", MM, "paper", "MM paper");
  const vbLive = await bot("volume_farm", VB, "live", "VB live");
  const grid = await bot("futures_grid", MM, "live", "Grid live");

  // Nến 1 phút phẳng 100 cho cả hai market trong 26 giờ trước T.
  for (const m of [MM, VB]) {
    await env.pool.query(
      `insert into candles_1m (market, ts, open, high, low, close, volume)
       select $1, ts, 100, 100.01, 99.99, 100, 1
         from generate_series($2::timestamptz, $3::timestamptz, interval '1 minute') ts
       on conflict do nothing`,
      [m, at(-26 * HOUR), at(-MIN)],
    );
  }
  // Lượt VB thứ hai (không có snapshot) vào short lúc T − 4h: 4 phút trước nến cơ sở giá 100.1 → giá đã giảm ≈ 10 bp.
  await env.pool.query("update candles_1m set close = 100.1 where market = $1 and ts = $2", [
    VB,
    at(-4 * HOUR - 5 * MIN),
  ]);

  let n = 0;
  const order = async (
    botId: string,
    market: string,
    side: string,
    tag: string,
    createdAt: string,
    context: unknown = null,
    clOrdId?: string,
  ) => {
    n += 1;
    const { rows } = await env.pool.query<{ id: string }>(
      "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, filled_size, status, tag, epoch, created_at, context) values (gen_random_uuid(), $1, $2, $3, $4, 'perps', $5, 'limit', 'GTX', 1, 1, 'filled', $6, 1, $7, $8) returning id",
      [
        botId,
        account,
        clOrdId ?? `sa-${String(n)}-${randomUUID().slice(0, 8)}`,
        market,
        side,
        tag,
        createdAt,
        context === null ? null : JSON.stringify(context),
      ],
    );
    return rows[0]?.id ?? "";
  };
  const fill = async (
    orderId: string,
    price: string,
    fee: string,
    builder: string | null,
    filledAt: string,
  ) => {
    const { rows } = await env.pool.query<{ id: string }>(
      "insert into fills (id, order_id, sodex_trade_id, price, size, fee, builder_fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, $3, 1, $4, $5, true, $6) returning id",
      [orderId, Math.floor(Math.random() * 1e12), price, fee, builder, filledAt],
    );
    return rows[0]?.id ?? "";
  };

  // Market Making: mua 1 @ 99.99 (level 0, Smart quoting bật, nằm đúng giới hạn Binance −0.5 bp → clamp hit) rồi bán
  // 1 @ 100.01 (level 1, tắt Smart quoting). Phí 0.005 mỗi fill (builder 0.001).
  const t1 = -2 * HOUR;
  const o1 = await order(mmLive, MM, "buy", "vm:1:open", at(t1 - 5_000), ctx(0, true, -0.5));
  mmFillId = await fill(o1, "99.99", "0.005", "0.001", at(t1));
  const o2 = await order(mmLive, MM, "sell", "vm:1:open", at(t1 + 20_000), ctx(1, false, null));
  await fill(o2, "100.01", "0.005", "0.001", at(t1 + 30_000));
  // Mid theo giây quanh fill đầu: lúc fill 100, sau 10 s 99.98.
  await env.pool.query(
    "insert into mid_1s (market, ts, mid) values ($1, $2, 100), ($1, $3, 99.98) on conflict do nothing",
    [MM, at(t1), at(t1 + 10_000)],
  );
  // Bot paper và Futures Grid cùng market: không bao giờ được tính.
  await fill(await order(mmPaper, MM, "buy", "vm:1:open", at(t1)), "50", "1", "0", at(t1 + 1_000));
  await fill(await order(grid, MM, "buy", "fg:1", at(t1)), "50", "1", "0", at(t1 + 2_000));

  // Volume Builder lượt 1 (có snapshot): long 1 @ 100 → bán 1 @ 100.02; phí 0.02 mỗi fill (builder 0.005).
  const e1 = -3 * HOUR;
  const cl = `vf-e1-${randomUUID().slice(0, 8)}`;
  const oe = await order(vbLive, VB, "buy", "vf:1:in:0", at(e1 - 5_000), null, cl);
  vbEntryId = oe;
  await fill(oe, "100", "0.02", "0.005", at(e1));
  const ox = await order(vbLive, VB, "sell", "vf:1:out:0", at(e1 + 55_000));
  await fill(ox, "100.02", "0.02", "0.005", at(e1 + 60_000));
  await env.pool.query(
    "insert into bot_events (id, bot_id, type, decision, why, payload, occurred_at) values (gen_random_uuid(), $1, 'decision', 'Enter long', 'score 0.70', $2, $3), (gen_random_uuid(), $1, 'decision', 'Closed long', 'Take profit: 0.02 ≥ 0.01; entry 100 → exit 100.02', '{}', $4)",
    [
      vbLive,
      JSON.stringify({ signal: { ...signal, order: { ...signal.order, clOrdID: cl } } }),
      at(e1 - 5_000),
      at(e1 + 61_000),
    ],
  );
  // Lượt 2 (trước v2.11.0, không snapshot): short 1 @ 100 → mua lại 1 @ 100.01.
  const e2 = -4 * HOUR;
  await fill(
    await order(vbLive, VB, "sell", "vf:2:in:0", at(e2 - 5_000)),
    "100",
    "0.02",
    "0.005",
    at(e2),
  );
  await fill(
    await order(vbLive, VB, "buy", "vf:2:out:0", at(e2 + 55_000)),
    "100.01",
    "0.02",
    "0.005",
    at(e2 + 60_000),
  );

  // ── Kịch bản 7 ngày (ngoài cửa sổ 24 giờ của các test trên) ───────────────────────────────────────────────────
  const mmB = await bot("volume_maker", MB, "live", "MM carried");
  const mmC = await bot("volume_maker", MC, "live", "MM unpriced");
  await env.pool.query(
    `insert into candles_1m (market, ts, open, high, low, close, volume)
     select $1, ts, 100, 100.01, 99.99, case when ts > $3::timestamptz - interval '1 hour' then 101 else 100 end, 1
       from generate_series($2::timestamptz, $3::timestamptz, interval '1 minute') ts
     on conflict do nothing`,
    [MB, at(-15 * DAY), at(-MIN)],
  );
  // MC: chỉ có nến trong giờ cuối (giá cuối kỳ), không có giá 1 phút sau các fill.
  await env.pool.query(
    `insert into candles_1m (market, ts, open, high, low, close, volume)
     select $1, ts, 100, 100, 100, 100, 1
       from generate_series($2::timestamptz, $3::timestamptz, interval '1 minute') ts
     on conflict do nothing`,
    [MC, at(-HOUR), at(-MIN)],
  );
  // Kỳ trước (T − 14d … T − 7d): mua 1 @ 99 lúc T − 8d → bot mang vị thế +1 vào kỳ 7 ngày.
  await fill(
    await order(mmB, MB, "buy", "vm:1:open", at(-8 * DAY - 5_000), ctx(0, true, -2)),
    "99",
    "0.01",
    "0.002",
    at(-8 * DAY),
  );
  // Trong kỳ: 80 fill xen kẽ bán / mua (vị thế vẫn +1). 40 fill đầu bật Smart quoting (lệch 2 bp), 40 fill sau tắt (0.5
  // bp). 40 fill đầu ở level 1, 40 fill sau ở level 0.
  for (let i = 0; i < 80; i++) {
    const sell = i % 2 === 0;
    const smart = i < 40;
    const off = smart ? 0.02 : 0.005;
    const price = (sell ? 100 + off : 100 - off).toFixed(3);
    const t = -3 * DAY + i * MIN;
    await fill(
      await order(
        mmB,
        MB,
        sell ? "sell" : "buy",
        "vm:1:open",
        at(t - 3_000),
        ctx(smart ? 1 : 0, smart, -2),
      ),
      price,
      "0.001",
      "0.0002",
      at(t),
    );
  }
  // MD: mua 1 @ 99 lúc T − 8d (trước kỳ), bị cắt bằng bán 1 @ 98 lúc T − 2d: giá vào lấy từ lịch sử trước kỳ.
  const mmD = await bot("volume_maker", MD, "live", "MM cut");
  await env.pool.query(
    `insert into candles_1m (market, ts, open, high, low, close, volume)
     select $1, ts, 100, 100, 100, 100, 1
       from generate_series($2::timestamptz, $3::timestamptz, interval '1 minute') ts
     on conflict do nothing`,
    [MD, at(-9 * DAY), at(-MIN)],
  );
  await fill(
    await order(mmD, MD, "buy", "vm:1:open", at(-8 * DAY - 3_000), ctx(0, true, -2)),
    "99",
    "0.01",
    "0.002",
    at(-8 * DAY),
  );
  await fill(
    await order(mmD, MD, "sell", "vm:2:cut:close", at(-2.5 * DAY - 1_000), ctx(0, true, null)),
    "98",
    "0.001",
    "0.0002",
    at(-2.5 * DAY),
  );
  // ME: buy 1 @ 100 → sell 0.5 @ 105 → buy 1 @ 110 → cắt 1.5 @ 104 (giá vào bình quân 106.67).
  const mmE = await bot("volume_maker", ME, "live", "MM partial");
  await env.pool.query(
    `insert into candles_1m (market, ts, open, high, low, close, volume)
     select $1, ts, 100, 100, 100, 100, 1
       from generate_series($2::timestamptz, $3::timestamptz, interval '1 minute') ts
     on conflict do nothing`,
    [ME, at(-3 * DAY), at(-MIN)],
  );
  const eSteps: [string, string, string, string][] = [
    ["buy", "1", "100", "vm:1:open"],
    ["sell", "0.5", "105", "vm:1:open"],
    ["buy", "1", "110", "vm:1:open"],
    ["sell", "1.5", "104", "vm:1:cut:close"],
  ];
  for (const [i, [side, size, price, tag]] of eSteps.entries()) {
    const t = -2.5 * DAY + i * MIN;
    const { rows } = await env.pool.query<{ id: string }>(
      "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, filled_size, status, tag, epoch, created_at, context) values (gen_random_uuid(), $1, $2, $3, $4, 'perps', $5, 'limit', 'GTX', $6, $6, 'filled', $7, 1, $8, null) returning id",
      [
        mmE,
        account,
        `sa-e-${String(i)}-${randomUUID().slice(0, 8)}`,
        ME,
        side,
        size,
        tag,
        at(t - 1_000),
      ],
    );
    await env.pool.query(
      "insert into fills (id, order_id, sodex_trade_id, price, size, fee, builder_fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, $3, $4, 0.01, 0.002, true, $5)",
      [rows[0]?.id, Math.floor(Math.random() * 1e12), price, size, at(t)],
    );
  }
  // MC: 40 fill phí cao (1 USDC trên 100), builder fee chưa ghi.
  for (let i = 0; i < 40; i++) {
    const t = -5 * DAY + i * MIN;
    await fill(
      await order(
        mmC,
        MC,
        i % 2 === 0 ? "buy" : "sell",
        "vm:1:open",
        at(t - 3_000),
        ctx(0, false, null),
      ),
      "100",
      "1",
      null,
      at(t),
    );
  }
});
afterAll(async () => {
  await env.close();
});

const ROUTES = [
  "/api/v1/admin/signal-analysis/all",
  "/api/v1/admin/signal-analysis/vb",
  "/api/v1/admin/signal-analysis/vb/entries",
  `/api/v1/admin/signal-analysis/vb/entries/${randomUUID()}`,
  "/api/v1/admin/signal-analysis/mm",
  "/api/v1/admin/signal-analysis/mm/fills",
  `/api/v1/admin/signal-analysis/mm/fills/${randomUUID()}`,
  "/api/v1/admin/signal-analysis/mm/quantiles",
];

describe("Signal Analysis API", () => {
  it("is for the team only: 401 signed out, 403 for others (before validating the query)", async () => {
    const anon = new TestClient(env.app);
    for (const r of ROUTES) {
      expect((await anon.request("GET", r)).statusCode).toBe(401);
      const denied = await user.request("GET", `${r}?range=99d`);
      expect(denied.statusCode).toBe(403);
      expect(errorOf(denied.body).code).toBe("FORBIDDEN");
      expect(denied.body).not.toContain("MM live");
    }
    const bad = await team.request("GET", "/api/v1/admin/signal-analysis/all?range=90d");
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad.body).code).toBe("VALIDATION_FAILED");
  });

  it("All: Market Making + Volume Builder live fills only, split into fees / markout / inventory", async () => {
    const r = await team.request("GET", "/api/v1/admin/signal-analysis/all?range=24h&tz=UTC");
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const v = signalAllViewSchema.parse(r.json());
    // Không có bot paper, không có Futures Grid; không lộ email.
    expect(v.byStrategy.map((s) => s.key).sort()).toEqual(["volume_farm", "volume_maker"]);
    expect(v.botList.map((b) => b.name).sort()).toEqual(["MM live", "VB live"]);
    expect(r.body).not.toContain("@drift.test");
    const mm = v.byStrategy.find((s) => s.key === "volume_maker");
    expect(mm?.fills).toBe(2);
    expect(mm?.volume).toBe("200");
    // Phí 0.01 / 200 × 1e6 = 50; markout −(0.01 + 0.01) / 200 × 1e6 = −100 (có lời); kết quả giá đến cuối kỳ = +0.02,
    // net = 0.01 − 0.02 = −0.01 → −50 / 1M; tồn kho = −50 − 50 + 100 = 0.
    expect(mm?.fees).toBe("50");
    expect(mm?.sodexFees).toBe("40");
    expect(mm?.builderFees).toBe("10");
    expect(mm?.markout).toBe("-100");
    expect(mm?.net).toBe("-50");
    expect(mm?.inventory).toBe("0");
    expect(mm?.netUsd).toBe("-0.01");
    expect(mm?.thin).toBe(true);
    // Không có fill kỳ trước → "Not available", không phải 0.
    expect(mm?.prevNet).toBeNull();
    expect(v.total.fills).toBe(6);
    expect(v.byHour).toHaveLength(24);
    expect(v.byHour[10]?.fills).toBe(2);
    expect(v.byHour[3]?.fills).toBe(0);
    expect(v.byHour[3]?.net).toBeNull();
    // Mẫu dưới 30 → không có cost driver nào.
    expect(v.drivers).toEqual([]);
    expect(v.byAccount[0]?.label).toMatch(/^[0-9a-f]{8}$/);
  });

  it("All: groups by the viewer's local hour", async () => {
    const r = await team.request(
      "GET",
      "/api/v1/admin/signal-analysis/all?range=24h&tz=Asia%2FKolkata",
    );
    const v = signalAllViewSchema.parse(r.json());
    // 10:00 UTC = 15:30 Kolkata.
    expect(v.byHour[15]?.fills).toBe(2);
  });

  it("MM: spread, markouts from per-second mids and candles, quote level, clamp and the waterfall", async () => {
    const r = await team.request("GET", "/api/v1/admin/signal-analysis/mm?range=24h&tz=UTC");
    expect(r.statusCode).toBe(200);
    const v = signalMmViewSchema.parse(r.json());
    expect(v.summary.fills).toBe(2);
    expect(v.summary.withContext).toBe(2);
    expect(v.bots).toBe(1);
    // At fill: mua 99.99 với mid 100 (mid_1s) và bán 100.01 với mid lúc đặt 100 → ≈ +1 bp mỗi fill.
    expect(v.curve.all[0]?.mean).toBe(1);
    // 10 s: chỉ fill đầu có mid_1s (99.98) → −1 bp; fill sau không có → bỏ qua, không tính là 0.
    expect(v.curve.all[1]).toMatchObject({ n: 1, mean: -1 });
    // 30 s: không có mid theo giây → Not available.
    expect(v.curve.all[2]).toMatchObject({ n: 0, mean: null });
    expect(v.curve.all[3]?.mean).toBe(1);
    expect(v.waterfall).toMatchObject({
      spread: "-100",
      priceAgainst: "0",
      fees: "50",
      inventory: "0",
      net: "-50",
    });
    expect(v.breakdown.level.rows.map((x) => x.key)).toEqual(["0", "1"]);
    expect(v.breakdown.clamp.rows.map((x) => [x.key, x.n])).toEqual([
      ["hit", 1],
      ["off", 1],
    ]);
    expect(v.levels[0]).toMatchObject({ level: 0, n: 1, fillRatePct: 100, thin: true });
    expect(v.suggestions).toEqual([]);
    // Lọc theo phía.
    const bid = signalMmViewSchema.parse(
      (await team.request("GET", "/api/v1/admin/signal-analysis/mm?range=24h&side=buy")).json(),
    );
    expect(bid.summary.fills).toBe(1);
    expect(bid.summary.prevNetPerM).toBeNull();
  });

  it("MM: fills list and fill detail", async () => {
    const page = signalMmFillsPageSchema.parse(
      (await team.request("GET", "/api/v1/admin/signal-analysis/mm/fills?range=24h")).json(),
    );
    expect(page.total).toBe(2);
    expect(page.items[0]?.side).toBe("sell");
    const d = await team.request(
      "GET",
      `/api/v1/admin/signal-analysis/mm/fills/${mmFillId}?range=24h`,
    );
    expect(d.statusCode).toBe(200);
    const detail = mmFillDetailSchema.parse(d.json());
    expect(detail.fill.clamp).toBe("hit");
    expect(detail.quote).toMatchObject({ level: 0, smart: true, insideLimitBp: 0, bookSecs: 5 });
    expect(detail.priceSource).toBe("mid");
    expect(detail.split).toMatchObject({
      spread: "0.01",
      priceAgainst: "0",
      sodexFee: "-0.004",
      builderFee: "-0.001",
      net: "0.005",
    });
    expect(d.body).not.toContain("fairBp");
    const missing = await team.request(
      "GET",
      `/api/v1/admin/signal-analysis/mm/fills/${randomUUID()}?range=24h`,
    );
    expect(missing.statusCode).toBe(404);
  });

  it("VB: round trips with the signal snapshot, the opposite side what-if, and Not available without a snapshot", async () => {
    const r = await team.request("GET", "/api/v1/admin/signal-analysis/vb?range=24h&tz=UTC");
    expect(r.statusCode).toBe(200);
    const v = signalVbViewSchema.parse(r.json());
    expect(v.summary).toMatchObject({ entries: 2, signal: 1, balance: 0, noSnapshot: 1 });
    // Lượt 1: +2 bp trước phí, −4 bp phí; lượt 2: −1 bp trước phí, −4 bp phí.
    expect(v.summary.beforeFees).toBe(0.5);
    expect(v.summary.fees).toBe(-4);
    // Phía ngược lại chỉ cho lượt có spread: −2 + 2 × 1 = 0 trước phí, −4 sau phí.
    expect(v.summary).toMatchObject({ opposite: 0, oppositeNet: -4, oppositeN: 1 });
    const regime = v.breakdown.regime.rows.map((x) => [x.key, x.n]);
    expect(regime).toEqual([
      ["up", 1],
      ["unknown", 1],
    ]);
    expect(v.breakdown.part.rows[0]).toMatchObject({ key: "momentum", n: 1, thin: true });
    expect(v.breakdown.exit.rows.map((x) => x.key)).toEqual(["takeProfit", "unknown"]);
    // Move before 3 phút: từ snapshot (+5) và từ nến cho lượt cũ (short sau khi giá giảm ≈ 9.99 bp).
    expect(v.moveBefore.m3.find((b) => b.key === "4-6")?.n).toBe(1);
    expect(v.moveBefore.m3.find((b) => b.key === "6+")?.n).toBe(1);
    // 10 s / 30 s: market không có mid theo giây → Not available.
    expect(v.markout.actual[0]).toMatchObject({ n: 0, mean: null });
    expect(v.suggestions).toEqual([]);
    expect(r.body).not.toMatch(/candleMomentum|wickRejection|volumeAcceleration/);
    const sig = signalVbViewSchema.parse(
      (
        await team.request("GET", "/api/v1/admin/signal-analysis/vb?range=24h&entryType=signal")
      ).json(),
    );
    expect(sig.summary.entries).toBe(1);
  });

  it("VB: entries list and entry detail", async () => {
    const page = signalVbEntriesPageSchema.parse(
      (
        await team.request("GET", "/api/v1/admin/signal-analysis/vb/entries?range=24h&sort=worst")
      ).json(),
    );
    expect(page.items.map((e) => e.net)).toEqual([-5, -2]);
    const d = await team.request(
      "GET",
      `/api/v1/admin/signal-analysis/vb/entries/${vbEntryId}?range=24h`,
    );
    expect(d.statusCode).toBe(200);
    const detail = vbEntryDetailSchema.parse(d.json());
    expect(detail.entry).toMatchObject({
      side: "long",
      entryType: "signal",
      score: 70,
      exit: "takeProfit",
    });
    expect(detail.signal).toMatchObject({
      regime: "up",
      lead: "momentum",
      parts: { momentum: 90 },
    });
    expect(detail.opposite).toMatchObject({ side: "short", netBp: -4 });
    expect(detail.netPnl).toBe("-0.02");
    expect(detail.timeline.some((x) => x.kind === "decision" && x.decision === "Enter long")).toBe(
      true,
    );
    expect(d.body).not.toMatch(/candleMomentum|"payload"/);
  });

  it("7d: carried-in position, the previous period and n ≥ 30 suggestions (MM)", async () => {
    const v = signalMmViewSchema.parse(
      (
        await team.request("GET", `/api/v1/admin/signal-analysis/mm?range=7d&tz=UTC&market=${MB}`)
      ).json(),
    );
    expect(v.summary.fills).toBe(80);
    // Phí 0.08 − kết quả giá 1.0 − vị thế mang sang 1 × (101 − 100) = −1.92 USDC trên 8 000 → −240 / 1M (có lời).
    expect(v.summary.netPerM).toBe("-240");
    expect(v.waterfall).toMatchObject({ fees: "10", inventory: "-125", net: "-240" });
    // Kỳ trước: mua 1 @ 99, giá cuối kỳ trước 100 → −0.99 trên 99 → −10 000 / 1M; hiệu do API tính.
    expect(v.summary.prevNetPerM).toBe("-10000");
    expect(v.summary.vsPrev).toBe("9760");
    const keys = v.suggestions.map((x) => x.key);
    expect(keys).toContain("smart");
    expect(keys).toContain("level");
    expect(v.levels[0]).toMatchObject({ n: 40, fillRatePct: 100, thin: false });
    // Lọc theo Smart quoting: không cộng vị thế mang sang, không so kỳ trước.
    const on = signalMmViewSchema.parse(
      (
        await team.request("GET", `/api/v1/admin/signal-analysis/mm?range=7d&market=${MB}&smart=on`)
      ).json(),
    );
    expect(on.summary).toMatchObject({ fills: 40, prevNetPerM: null, vsPrev: null });
  });

  it("7d: more than 20% of volume without a 1-min price → markout / inventory Not available; no builder fee → no split", async () => {
    const v = signalMmViewSchema.parse(
      (await team.request("GET", `/api/v1/admin/signal-analysis/mm?range=7d&market=${MC}`)).json(),
    );
    expect(v.summary.fills).toBe(40);
    expect(v.waterfall).toMatchObject({
      fees: "10000",
      sodexFees: null,
      builderFees: null,
      priceAgainst: null,
      inventory: null,
      net: "10000",
    });
    const all = signalAllViewSchema.parse(
      (await team.request("GET", `/api/v1/admin/signal-analysis/all?range=7d&market=${MC}`)).json(),
    );
    expect(all.total).toMatchObject({
      markout: null,
      inventory: null,
      priced: false,
      net: "10000",
    });
  });

  it("7d All: carried position and previous period per group, and a cost driver at n ≥ 30", async () => {
    const mb = signalAllViewSchema.parse(
      (
        await team.request("GET", `/api/v1/admin/signal-analysis/all?range=7d&tz=UTC&market=${MB}`)
      ).json(),
    );
    expect(mb.total).toMatchObject({ net: "-240", prevNet: "-10000", vsPrev: "9760" });
    const all = signalAllViewSchema.parse(
      (await team.request("GET", "/api/v1/admin/signal-analysis/all?range=7d&tz=UTC")).json(),
    );
    const d = all.drivers.find((x) => x.kind === "bot" && x.group.market === MC);
    expect(d).toMatchObject({ part: "fees", group: { net: "10000", thin: false } });
  });

  it("7d: a position cut on a position carried in from before the period uses its real cost basis", async () => {
    const v = signalMmViewSchema.parse(
      (
        await team.request("GET", `/api/v1/admin/signal-analysis/mm?range=7d&tz=UTC&market=${MD}`)
      ).json(),
    );
    expect(v.inventory.cuts).toBe(1);
    expect(v.inventory.latestCuts[0]).toMatchObject({
      position: "long",
      entry: "99",
      heldSecs: 5.5 * 86_400,
      resultUsd: "-1.001",
    });
    expect(v.inventory.cutsUsd).toBe("-1.001");
  });

  it("one average-cost ledger: a partial close then an add gives the right entry for the cut", async () => {
    const v = signalMmViewSchema.parse(
      (
        await team.request("GET", `/api/v1/admin/signal-analysis/mm?range=7d&tz=UTC&market=${ME}`)
      ).json(),
    );
    expect(v.inventory.latestCuts[0]).toMatchObject({ entry: "106.66666667", heldSecs: 180 });
    // (104 − 106.666…) × 1.5 − 0.01 = −4.01
    expect(v.inventory.cutsUsd).toBe("-4.01");
  });

  it("p25 / p75 come from their own endpoint, for the filters asked", async () => {
    const r = await team.request(
      "GET",
      `/api/v1/admin/signal-analysis/mm/quantiles?range=7d&market=${MB}`,
    );
    expect(r.statusCode).toBe(200);
    const qv = signalMmQuantilesSchema.parse(r.json());
    expect(qv.p25).toHaveLength(6);
    expect(qv.p25[3]).not.toBeNull();
  });

  it("a filter change reuses the cached aggregate for the range (no new heavy query)", async () => {
    const before = signalMmViewSchema.parse(
      (
        await team.request(
          "GET",
          `/api/v1/admin/signal-analysis/mm?range=7d&market=${MB}&smart=off`,
        )
      ).json(),
    );
    // Một fill mới trong kỳ: lần đọc sau cùng (kỳ, múi giờ) vẫn dùng tổng đã cache trong 60 s.
    const { rows } = await env.pool.query<{ id: string; account: string }>(
      "select o.bot_id as id, o.sodex_account_id as account from orders o where o.market = $1 limit 1",
      [MB],
    );
    const o = await env.pool.query<{ id: string }>(
      "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, filled_size, status, tag, epoch, created_at, context) values (gen_random_uuid(), $1, $2, $3, $4, 'perps', 'buy', 'limit', 'GTX', 1, 1, 'filled', 'vm:1:open', 1, $5, $6) returning id",
      [
        rows[0]?.id,
        rows[0]?.account,
        `sa-cache-${randomUUID()}`,
        MB,
        at(-HOUR - 1_000),
        JSON.stringify(ctx(0, false, null)),
      ],
    );
    await env.pool.query(
      "insert into fills (id, order_id, sodex_trade_id, price, size, fee, builder_fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, 100, 1, 0.001, 0.0002, true, $3)",
      [o.rows[0]?.id, Math.floor(Math.random() * 1e12), at(-HOUR)],
    );
    const after = signalMmViewSchema.parse(
      (
        await team.request(
          "GET",
          `/api/v1/admin/signal-analysis/mm?range=7d&market=${MB}&smart=off&side=buy`,
        )
      ).json(),
    );
    expect(before.summary.fills).toBe(40);
    expect(after.summary.fills).toBe(20);
  });

  it("a statement timeout returns ANALYSIS_TIMEOUT (503, standard error format)", async () => {
    QUERY_TIMEOUT.ms = 1;
    try {
      const r = await team.request("GET", "/api/v1/admin/signal-analysis/mm?range=14d&tz=UTC");
      expect(r.statusCode).toBe(503);
      expect(errorOf(r.body).code).toBe("ANALYSIS_TIMEOUT");
    } finally {
      QUERY_TIMEOUT.ms = 10_000;
    }
  });
});
