import { randomUUID } from "node:crypto";

import {
  dec,
  Decimal,
  fillCostPerMillion,
  marketHoursViewSchema,
  meSchema,
  modelCostPerMillion,
  modelPnlBps,
  quantile,
  swingBps,
  type MarketHoursView,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// "Est. CPM · calibrated" (DEC-293): R = vị thế lớn nhất ÷ order size, số fill một bot-hour
// theo đơn vị order size, C = trung vị (CPM thật ÷ "incl. shock days") trên 14 ngày; nguồn market → mọi market → mặc
// định. Môi trường riêng: các phép gộp "mọi market" không được lẫn bot của file test khác.

let env: TestEnv;
const tag = () => randomUUID().slice(0, 6).toUpperCase();
const A = `CA${tag()}-USD`;
const B = `CB${tag()}-USD`;
const NONE = `CN${tag()}-USD`;
const THIN = `CT${tag()}-USD`;
const HOURS = [5, 6, 7] as const;
// Mọi giờ cùng một dãy close: xen kẽ 100.1 / 100 (biến động 15 phút 10 bp < 15: không có ngày sốc, nên "incl. shock
// days" = chi phí mô hình của ngày đó, không có phần cắt). Close của nến hh:01 = 100 = giá tham chiếu của fill hh:00.
const closes = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? "100.1" : "100"));

beforeAll(async () => {
  env = await startTestEnv();
  for (const m of [A, B, NONE, THIN]) env.sodex.addPerpSymbol(m, { maxLeverage: 10 });
  env.clock.now = new Date("2026-11-02T23:00:00Z");
  const values = [A, B, NONE, THIN].flatMap((m) =>
    HOURS.flatMap((h) =>
      closes.map(
        (c, i) =>
          `('${m}', '2026-11-02T${String(h).padStart(2, "0")}:${String(i).padStart(2, "0")}:00Z', ${c}, 100.1, 100, ${c}, 1)`,
      ),
    ),
  );
  await env.pool.query(
    `insert into candles_1m (market, ts, open, high, low, close, volume) values ${values.join(",")}`,
  );
  await env.pool.query(
    "insert into mm_model_coefs (a, k, points, day) values (0.2, 0.1, 5, '2026-11-01')",
  );
});
afterAll(async () => {
  await env.close();
});

async function teamUser() {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, `mhc-${randomUUID()}@drift.test`)).json());
  await env.pool.query("update users set role = 'team' where id = $1", [me.id]);
  return { client, userId: me.id };
}

const get = async (client: TestClient, market: string): Promise<MarketHoursView> => {
  const r = await client.request(
    "GET",
    `/api/v1/admin/market-hours?market=${market}&days=7&tz=UTC`,
  );
  expect(r.statusCode).toBe(200);
  return marketHoursViewSchema.parse(r.json());
};

interface Fill {
  hour: number;
  second: number;
  side: "buy" | "sell";
  price: string;
  size: string;
}

/** Một bot Market Making thật với order size và các fill (lệnh tạo cùng lúc với fill) ngày `day`. */
async function seedBot(
  userId: string,
  market: string,
  orderSize: string,
  fills: readonly Fill[],
  day = "2026-11-02",
) {
  const { rows: acc } = await env.pool.query<{ id: string }>(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
    [userId, "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db", Math.floor(Math.random() * 1e9)],
  );
  const { rows: bot } = await env.pool.query<{ id: string }>(
    "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode) values (gen_random_uuid(), $1, $2, 'volume_maker', $3, 'perps', 'MHC', 'running', 'live') returning id",
    [userId, acc[0]?.id, market],
  );
  const botId = bot[0]?.id ?? "";
  const { rows: ver } = await env.pool.query<{ id: string }>(
    "insert into bot_versions (id, bot_id, version, config, param_source, status) values (gen_random_uuid(), $1, 1, $2, 'manual', 'active') returning id",
    [botId, JSON.stringify({ market, orderSize, maxOrders: 1, distanceBp: "1" })],
  );
  await env.pool.query("update bots set active_version_id = $1 where id = $2", [ver[0]?.id, botId]);
  for (const [i, f] of fills.entries()) {
    const at = `${day}T${String(f.hour).padStart(2, "0")}:00:${String(f.second).padStart(2, "0")}Z`;
    const { rows } = await env.pool.query<{ id: string }>(
      "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, price, size, status, tag, epoch, created_at) values (gen_random_uuid(), $1, $2, $3, $4, 'perps', $5, 'limit', 'GTX', $6, $7, 'filled', $8, 1, $9) returning id",
      [
        botId,
        acc[0]?.id,
        `mhc-${String(i)}-${randomUUID().slice(0, 8)}`,
        market,
        f.side,
        f.price,
        f.size,
        `vm:${String(i)}:${f.side === "buy" ? "bid" : "ask"}`,
        at,
      ],
    );
    await env.pool.query(
      "insert into fills (id, order_id, sodex_trade_id, price, size, fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, $3, $4, 0, true, $5)",
      [rows[0]?.id, Math.floor(Math.random() * 1e12), f.price, f.size, at],
    );
  }
}

/**
 * Dãy fill của một bot: giờ 05 mua `first` rồi bán `step`, giờ 06 / 07 bán `step` rồi mua `step`. Vị thế lớn nhất = `first`
 * (lúc mua đầu tiên), mọi giá mua = `buy`, giá bán = 100 (= giá tham chiếu).
 */
const pattern = (first: string, step: string, buy: string): Fill[] => [
  { hour: 5, second: 10, side: "buy", price: buy, size: first },
  { hour: 5, second: 40, side: "sell", price: "100", size: step },
  { hour: 6, second: 10, side: "sell", price: "100", size: step },
  { hour: 6, second: 40, side: "buy", price: buy, size: step },
  { hour: 7, second: 10, side: "sell", price: "100", size: step },
  { hour: 7, second: 40, side: "buy", price: buy, size: step },
];
// A: order size $20, vị thế lớn nhất 0.4 × 100.01 = $40.004 → R = 2.0002. B: order size $10, 0.3 × 100.02 → R = 3.0006.
const fillsA = pattern("0.4", "0.2", "100.01");
const fillsB = pattern("0.3", "0.1", "100.02");

/** "incl. shock days" của mọi giờ ở đây (một ngày, không sốc): (1.5 + max(0, −(0.2 × 1 − 0.1 × dao động))) × 100. */
const est = (() => {
  const s = swingBps(closes);
  if (s === null) throw new Error("no swing");
  return modelCostPerMillion(new Decimal("1.5"), modelPnlBps(new Decimal(1), s, "0.2", "0.1"));
})();

/** CPM thật của giờ h với 3 bot cùng dãy fill (fee 0, giá tham chiếu 100). */
const realOf = (fills: readonly Fill[], h: number): Decimal => {
  const fs = fills
    .filter((f) => f.hour === h)
    .map((f) => ({ side: f.side, price: f.price, size: f.size, fee: "0", ref: "100" }));
  const c = fillCostPerMillion([...fs, ...fs, ...fs]).costPerMillion;
  if (c === null) throw new Error("no cost");
  return c;
};
const ratiosOf = (fills: readonly Fill[]) => HOURS.map((h) => realOf(fills, h).div(est));
/** Σ (volume ÷ order size) ÷ Σ bot-hour, 3 bot × 3 bot-hour. */
const fillsPerBotHour = (fills: readonly Fill[], orderSize: string) =>
  fills
    .reduce((s, f) => s.add(dec(f.price).mul(f.size)), new Decimal(0))
    .div(orderSize)
    .div(3);
const s2 = (d: Decimal | null) => d?.toDecimalPlaces(2).toString() ?? null;

describe("Est. CPM · calibrated", () => {
  it("uses the stored defaults when there is no bot data yet, and never shows 0", async () => {
    const { client } = await teamUser();
    const v = await get(client, NONE);
    expect(v.estimate).toMatchObject({
      positionRatio: "2",
      positionRatioSource: "default",
      // F = 80 mặc định: phần cắt vẫn có khi chưa có bot nào = 2 ÷ 80.
      fillsPerBotHour: "80",
      cutShare: "0.025",
      cutScope: { source: "default", botHours: 0, marketBotHours: 0, markets: [] },
      calibration: "1",
      calibrationScope: { source: "default", botHours: 0, marketBotHours: 0, markets: [] },
      calibrationHours: 0,
    });
    const h5 = v.hours[5]?.volatility;
    expect(h5?.estShockCostPerMillion).toBe(s2(est));
    // C = 1.0: "calibrated" = "incl. shock days".
    expect(h5?.estCalibratedCostPerMillion).toBe(h5?.estShockCostPerMillion);
    // Giờ không có nến: n/a (null), không bao giờ 0.
    expect(v.hours[8]?.volatility.estCalibratedCostPerMillion).toBeNull();
  });

  it("calibrates on this market's bots over 14 days: R, the cut share and C", async () => {
    const { userId, client } = await teamUser();
    for (let i = 0; i < 3; i++) await seedBot(userId, A, "20", fillsA);
    for (let i = 0; i < 3; i++) await seedBot(userId, B, "10", fillsB);
    // Ngoài cửa sổ 14 ngày (now − 14 ngày = 2026-10-19 23:00): vị thế rất lớn nhưng không được tính.
    await seedBot(userId, A, "20", pattern("50", "1", "100.01"), "2026-10-10");

    const a = await get(client, A);
    const fA = fillsPerBotHour(fillsA, "20");
    const rA = dec("40.004").div(20);
    expect(a.estimate).toMatchObject({
      positionRatio: s2(rA),
      positionRatioSource: "market",
      fillsPerBotHour: s2(fA),
      cutShare: rA.div(fA).toDecimalPlaces(4).toString(),
      cutScope: { source: "market", botHours: 9, marketBotHours: 9, markets: [] },
      calibrationScope: { source: "market", botHours: 9, marketBotHours: 9, markets: [] },
      calibrationHours: 3,
    });
    const cA = quantile(ratiosOf(fillsA), 0.5);
    expect(a.estimate.calibration).toBe(s2(cA));
    expect(Number(a.estimate.calibration)).toBeGreaterThan(0);
    const h6 = a.hours[6]?.volatility;
    // Không có ngày sốc: "incl. shock days" = chi phí mô hình; "calibrated" = nó × C (C đã làm tròn 2 số khi trả về
    // nhưng tính bằng số đầy đủ).
    expect(h6?.estShockCostPerMillion).toBe(s2(est));
    expect(h6?.estCalibratedCostPerMillion).toBe(s2(cA === null ? null : est.mul(cA)));
  });

  it("pools every market when this market has no bots", async () => {
    const { client } = await teamUser();
    const v = await get(client, NONE);
    // R = trung vị qua 6 bot (3 × 2.0002, 3 × 3.0006); số fill một bot-hour = Σ (volume ÷ order size) ÷ 18 bot-hour.
    const r = quantile([dec("40.004").div(20), dec("30.006").div(10)], 0.5);
    const f = fillsPerBotHour(fillsA, "20").add(fillsPerBotHour(fillsB, "10")).div(2);
    expect(v.estimate).toMatchObject({
      positionRatio: s2(r),
      positionRatioSource: "pooled",
      fillsPerBotHour: s2(f),
      // NONE không có bot nào: "No bots on this market" (marketBotHours = 0).
      cutScope: { source: "pooled", botHours: 18, marketBotHours: 0, markets: [A, B].sort() },
      calibrationScope: {
        source: "pooled",
        botHours: 18,
        marketBotHours: 0,
        markets: [A, B].sort(),
      },
      calibrationHours: 6,
    });
    expect(v.estimate.cutShare).toBe(r?.div(f).toDecimalPlaces(4).toString());
    // C = trung vị qua 6 ô (giờ × market) của cả A và B.
    const c = quantile([...ratiosOf(fillsA), ...ratiosOf(fillsB)], 0.5);
    expect(v.estimate.calibration).toBe(s2(c));
    expect(v.hours[5]?.volatility.estCalibratedCostPerMillion).toBe(
      s2(c === null ? null : est.mul(c)),
    );
  });

  it("pools C when this market has bots but too few qualifying hours, and says it had bots", async () => {
    const { userId, client } = await teamUser();
    // Một bot trên THIN, chỉ giờ 05: 1 bot-hour → không có ô ≥ 3 bot-hour; R và F vẫn lấy từ chính bot này.
    await seedBot(userId, THIN, "20", fillsA.slice(0, 2));
    const v = await get(client, THIN);
    expect(v.estimate).toMatchObject({
      positionRatioSource: "market",
      cutScope: { source: "market", botHours: 1, marketBotHours: 1, markets: [] },
      // Ô chỉ có ở A và B; THIN có 1 bot-hour → "Not enough bot data on this market".
      calibrationScope: {
        source: "pooled",
        botHours: 18,
        marketBotHours: 1,
        markets: [A, B].sort(),
      },
      calibrationHours: 6,
    });
    const c = quantile([...ratiosOf(fillsA), ...ratiosOf(fillsB)], 0.5);
    expect(v.estimate.calibration).toBe(s2(c));
  });
});
