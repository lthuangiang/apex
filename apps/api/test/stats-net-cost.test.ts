import { dec, Decimal, meSchema, platformStatsSchema } from "@drift/shared";
import { applyFill, emptyLedger, netPnl, type Ledger } from "@drift/strategies";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { builderFeeSourceOf, periodNetPnl } from "../src/modules/account/stats-overview";
import { botCostPerMillion, netCostPerMillion } from "../src/modules/bots/service";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Platform Stats › By strategy › Net cost / $1M và builder fee theo mức đã thu (DEC-296).

type Side = "buy" | "sell";
interface F {
  side: Side;
  price: string;
  size: string;
  fee: string;
}

const replay = (fs: readonly F[], from: Ledger = emptyLedger()) =>
  fs.reduce((l, f) => applyFill(l, f.side, f.price, f.size, f.fee), from);
const sumNotional = (fs: readonly F[]) =>
  fs.reduce((a, f) => a.add(dec(f.price).mul(f.size)), new Decimal(0));

describe("periodNetPnl", () => {
  it("equals the change of the bot ledger's netPnl over the period, without funding", () => {
    const before: F[] = [
      { side: "buy", price: "100", size: "1", fee: "0.01" },
      { side: "buy", price: "96", size: "0.5", fee: "0.01" },
    ];
    const during: F[] = [
      { side: "sell", price: "105", size: "2", fee: "0.02" },
      { side: "buy", price: "104", size: "3", fee: "0.03" },
      { side: "sell", price: "103", size: "0.25", fee: "0.01" },
    ];
    const l0 = replay(before);
    const l1 = replay(during, l0);
    const expected = netPnl(l1, "101").sub(netPnl(l0, "110"));
    const qty = (fs: F[]) =>
      fs.reduce((a, f) => a.add(f.side === "buy" ? dec(f.size) : dec(f.size).neg()), dec("0"));
    const got = periodNetPnl({
      posBefore: qty(before),
      posIn: qty(during),
      cashIn: during.reduce(
        (a, f) =>
          a.add(
            dec(f.price)
              .mul(f.size)
              .mul(f.side === "sell" ? 1 : -1),
          ),
        dec("0"),
      ),
      feesIn: during.reduce((a, f) => a.add(f.fee), dec("0")),
      markStart: dec("110"),
      markEnd: dec("101"),
    });
    // Sổ cái chia giá vốn bình quân (98.666…), nên so tới 10 chữ số.
    expect(got?.toString()).toBe("-14.06");
    expect(expected.toDecimalPlaces(10).toString()).toBe("-14.06");
  });

  it("needs a start price only with a position before the period, an end price only with one after", () => {
    const base = { cashIn: dec("5"), feesIn: dec("1"), markStart: null, markEnd: null };
    expect(periodNetPnl({ ...base, posBefore: dec("0"), posIn: dec("0") })?.toString()).toBe("4");
    expect(periodNetPnl({ ...base, posBefore: dec("1"), posIn: dec("-1") })).toBeNull();
    expect(periodNetPnl({ ...base, posBefore: dec("0"), posIn: dec("1") })).toBeNull();
  });

  it("labels a charged rate default, tier or custom", () => {
    expect(builderFeeSourceOf("volume_maker", 3)).toBe("default");
    expect(builderFeeSourceOf("volume_maker", 2)).toBe("tier");
    expect(builderFeeSourceOf("volume_maker", 10)).toBe("custom");
    expect(builderFeeSourceOf("volume_farm", 5)).toBe("default");
    expect(builderFeeSourceOf("spot_grid", 10)).toBe("default");
    expect(builderFeeSourceOf("spot_grid", 4)).toBe("custom");
  });
});

let env: TestEnv;
const ADDRESS = "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db";
const DAY = 86_400_000;

beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => {
  await env.close();
});

describe("GET /api/v1/admin/stats · Net cost / $1M", () => {
  it("matches the bot-page helper per strategy, live bots and the selected period only", async () => {
    const client = new TestClient(env.app);
    const me = meSchema.parse((await signIn(env, client, "stats-cost@example.com")).json());
    await env.pool.query("update users set role = 'team' where id = $1", [me.id]);
    const { rows: acct } = await env.pool.query<{ id: string }>(
      "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
      [me.id, ADDRESS, Math.floor(Math.random() * 1e9)],
    );
    const accountId = acct[0]?.id ?? "";
    const bot = async (strategy: string, market: string, mode: "live" | "paper" = "live") => {
      const { rows } = await env.pool.query<{ id: string }>(
        "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode) values (gen_random_uuid(), $1, $2, $3, $4, 'perps', 'B', 'running', $5) returning id",
        [me.id, accountId, strategy, market, mode],
      );
      return rows[0]?.id ?? "";
    };
    const now = env.clock.now.getTime();
    const from = now - 7 * DAY;
    const fill = async (
      botId: string,
      market: string,
      f: F & { builderFee: string | null; at: number },
    ) => {
      const { rows } = await env.pool.query<{ id: string }>(
        "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, filled_size, status, tag, epoch) select gen_random_uuid(), $1, sodex_account_id, $2, $3, 'perps', $4, 'limit', 'GTX', $5, $5, 'filled', 'x', 1 from bots where id = $1 returning id",
        [botId, `c-${String(Math.random())}`, market, f.side, f.size],
      );
      await env.pool.query(
        "insert into fills (id, order_id, sodex_trade_id, price, size, fee, builder_fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, true, $7)",
        [
          rows[0]?.id ?? "",
          Math.floor(Math.random() * 1e12),
          f.price,
          f.size,
          f.fee,
          f.builderFee,
          new Date(f.at),
        ],
      );
    };

    // Market Making: vị thế 1 BTC mở trước kỳ (định giá đầu kỳ bằng nến 1 phút), còn 1 BTC cuối kỳ (giá live).
    const mm = await bot("volume_maker", "BTC-USD");
    const opened: F = { side: "buy", price: "100", size: "1", fee: "0.01" };
    const mmBefore: F[] = [opened];
    const mmDuring: (F & { builderFee: string })[] = [
      { side: "sell", price: "105", size: "1", fee: "0.02", builderFee: "0.00315" }, // 0.3 bp: default
      { side: "buy", price: "104", size: "2", fee: "0.03", builderFee: "0.0208" }, // 1 bp: custom
      { side: "sell", price: "103", size: "1", fee: "0.01", builderFee: "0.00206" }, // 0.2 bp: tier
    ];
    await fill(mm, "BTC-USD", { ...opened, builderFee: null, at: from - 2 * DAY });
    for (const [i, f] of mmDuring.entries())
      await fill(mm, "BTC-USD", { ...f, at: from + (i + 1) * DAY });
    await env.pool.query(
      "insert into candles_1m (market, ts, open, high, low, close, volume) values ('BTC-USD', $1, 110, 110, 110, 110, 1)",
      [new Date(Math.floor(from / 60_000) * 60_000 - 60_000)],
    );
    env.prices.set("BTC-USD", { price: "101", at: now });
    const mm0 = replay(mmBefore);
    const mmNet = netPnl(replay(mmDuring, mm0), "101").sub(netPnl(mm0, "110"));

    // Volume Builder: phẳng cuối kỳ, so trực tiếp với helper của trang bot (`botCostPerMillion`).
    const vb = await bot("volume_farm", "ETH-USD");
    const vbFills: (F & { builderFee: string })[] = [
      { side: "buy", price: "2000", size: "1", fee: "0.5", builderFee: "0.1" },
      { side: "sell", price: "1990", size: "1", fee: "0.5", builderFee: "0.0995" },
    ];
    for (const f of vbFills) await fill(vb, "ETH-USD", { ...f, at: now - DAY });
    // Fill cũ hơn kỳ đã đóng hẳn: không tính vào kỳ.
    await fill(vb, "ETH-USD", {
      side: "buy",
      price: "1000",
      size: "1",
      fee: "9",
      builderFee: null,
      at: from - DAY,
    });
    await fill(vb, "ETH-USD", {
      side: "sell",
      price: "900",
      size: "1",
      fee: "9",
      builderFee: null,
      at: from - DAY,
    });
    // Bot paper: không bao giờ tính.
    const paper = await bot("volume_farm", "ETH-USD", "paper");
    await fill(paper, "ETH-USD", {
      side: "buy",
      price: "2000",
      size: "5",
      fee: "50",
      builderFee: null,
      at: now - DAY,
    });
    await fill(paper, "ETH-USD", {
      side: "sell",
      price: "1000",
      size: "5",
      fee: "50",
      builderFee: null,
      at: now - DAY,
    });

    // Spot Grid có lãi → "0" (như trang bot).
    const grid = await bot("spot_grid", "SOL-USD");
    await fill(grid, "SOL-USD", {
      side: "buy",
      price: "50",
      size: "1",
      fee: "0",
      builderFee: null,
      at: now - DAY,
    });
    await fill(grid, "SOL-USD", {
      side: "sell",
      price: "60",
      size: "1",
      fee: "0",
      builderFee: null,
      at: now - DAY,
    });

    // Futures Grid còn vị thế trên market không có giá → Not available (null), không bao giờ 0.
    const fg = await bot("futures_grid", "NOPRICE-USD");
    await fill(fg, "NOPRICE-USD", {
      side: "buy",
      price: "10",
      size: "1",
      fee: "0",
      builderFee: null,
      at: now - DAY,
    });

    const stats = platformStatsSchema.parse(
      (await client.request("GET", "/api/v1/admin/stats?period=7")).json(),
    );
    const row = (s: string) => stats.overview.strategies.find((x) => x.strategy === s);

    expect(row("volume_maker")?.netCostPerMillion).toBe(
      netCostPerMillion(mmNet, sumNotional(mmDuring)),
    );
    expect(row("volume_maker")?.netCostPerMillion).toBe("21778.85");

    const vbLedger = replay(vbFills);
    const vbPage = botCostPerMillion("volume_farm", {
      volume: sumNotional(vbFills).toString(),
      ledger: vbLedger,
    });
    expect(vbPage).toBe("2756.89");
    expect(row("volume_farm")?.netCostPerMillion).toBe(vbPage);

    expect(row("spot_grid")?.netCostPerMillion).toBe("0");
    expect(row("futures_grid")?.netCostPerMillion).toBeNull();

    // Builder fee theo mức đã thu.
    const src = stats.overview.builderFeeSources;
    const pick = (strategy: string, source: string) =>
      src.filter((x) => x.strategy === strategy && x.source === source);
    expect(pick("volume_maker", "default")).toEqual([
      {
        strategy: "volume_maker",
        source: "default",
        rate: 3,
        volume: "105",
        builderFees: "0.0032",
      },
    ]);
    expect(pick("volume_maker", "custom")).toEqual([
      {
        strategy: "volume_maker",
        source: "custom",
        rate: 10,
        volume: "208",
        builderFees: "0.0208",
      },
    ]);
    expect(pick("volume_maker", "tier")).toEqual([
      { strategy: "volume_maker", source: "tier", rate: 2, volume: "103", builderFees: "0.0021" },
    ]);
    expect(pick("volume_farm", "default")).toEqual([
      {
        strategy: "volume_farm",
        source: "default",
        rate: 5,
        volume: "3990",
        builderFees: "0.1995",
      },
    ]);
    expect(pick("spot_grid", "none")).toEqual([
      { strategy: "spot_grid", source: "none", rate: null, volume: "110", builderFees: "0" },
    ]);
    // Tổng của bảng = KPI builder fee của kỳ (cùng nguồn fills.builder_fee).
    const total = src.reduce((a, x) => a.add(x.builderFees), dec("0"));
    expect(total.toDecimalPlaces(2).toString()).toBe(
      dec(stats.overview.kpis.revenue.cur).toDecimalPlaces(2).toString(),
    );
  });
});
