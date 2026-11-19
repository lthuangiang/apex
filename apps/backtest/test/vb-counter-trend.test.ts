import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { dec, Decimal } from "@drift/shared";
import type { Candle } from "@drift/strategies";
import { describe, expect, it } from "vitest";

import {
  checkRange,
  MAX_RANGE_DAYS,
  STUDY_DEFAULT_CONFIG,
  StudyLimitError,
  studyConfig,
} from "../src/vb-counter-trend/load";
import {
  bookTrade,
  diffByDay,
  gapsOf,
  groupStats,
  moveBucket,
  runStudy,
  simulate,
  simulateSeeds,
  toMarkdown,
  type StudyTrade,
} from "../src/vb-counter-trend/study";

// Nghiên cứu bộ chặn ngược xu hướng VB (#282): thống kê, ghép lượt, giới hạn chỉ đọc của CLI. Dữ liệu tự dựng.

const d = (v: number | string) => new Decimal(v);
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-10T00:00:00Z");

function trade(at: number, netBp: number, notional = 100): StudyTrade {
  const net = d(netBp).mul(notional).div(10_000);
  return {
    at,
    exitAt: at + 180_000,
    side: "long",
    regime: "SIDEWAY",
    move3m: null,
    balanced: false,
    doubleClosed: false,
    entryNotional: d(notional),
    volume: d(notional * 2),
    gross: net.add("0.03"),
    fees: d("0.03"),
    net,
    netBp: d(netBp),
    grossBp: d(netBp + 3),
  };
}

const fees = {
  spot: { maker: "0.00035", taker: "0.00065" },
  perps: { maker: "0.00012", taker: "0.0004" },
  builder: "0.00005",
};

/** Đường giá tất định: tăng, giảm, đi ngang, có sóng ngắn. */
function path(n: number, start: number): Candle[] {
  const ks: Candle[] = [];
  let p = 2_000;
  for (let i = 0; i < n; i += 1) {
    const drift = i < n / 3 ? 0.0002 : i < (2 * n) / 3 ? -0.0002 : 0;
    const o = p;
    const c = p * (1 + drift + Math.sin(i / 6) * 0.0007);
    ks.push({
      t: start + i * 60_000,
      o: o.toFixed(2),
      h: (Math.max(o, c) * 1.0004).toFixed(2),
      l: (Math.min(o, c) * 0.9996).toFixed(2),
      c: c.toFixed(2),
      v: String(3 + (i % 7)),
    });
    p = c;
  }
  return ks;
}

describe("buckets and gaps", () => {
  it("buckets the move in the trade's direction at the documented edges", () => {
    expect(moveBucket(null)).toBe("n/a");
    expect(moveBucket(-8)).toBe("≤ −8");
    expect(moveBucket(-7.9)).toBe("−8…−3");
    expect(moveBucket(-3)).toBe("−8…−3");
    expect(moveBucket(-1)).toBe("−3…−1");
    expect(moveBucket(0)).toBe("−1…1");
    expect(moveBucket(1)).toBe("1…3");
    expect(moveBucket(3)).toBe("3…8");
    expect(moveBucket(8)).toBe("≥ 8");
  });

  it("finds candle gaps longer than 2 minutes", () => {
    const ks = path(10, T0).filter((_, i) => i !== 3 && i !== 4);
    expect(gapsOf(ks)).toEqual([{ from: T0 + 2 * 60_000, to: T0 + 5 * 60_000 }]);
    expect(gapsOf(path(10, T0))).toEqual([]);
  });
});

describe("stats", () => {
  it("cost per $1M is −net ÷ both-leg volume, not clamped", () => {
    // 2 lượt −10 bp trên 100 USDC: net −0.2, volume 400 → 500 / 1M.
    expect(groupStats([trade(T0, -10), trade(T0 + 1, -10)]).costPerM?.toFixed(2)).toBe("500.00");
    // Lãi → âm.
    expect(groupStats([trade(T0, 10)]).costPerM?.toFixed(2)).toBe("-500.00");
    expect(groupStats([]).costPerM).toBeNull();
    expect(groupStats([]).net.mean).toBeNull();
  });

  it("day-paired difference vs random is the mean gap with a day bootstrap range", () => {
    const a = [0, 1, 2, 3].flatMap((k) => [trade(T0 + k * DAY, -2), trade(T0 + k * DAY + 1, -4)]);
    const b = [0, 1, 2, 3].map((k) => trade(T0 + k * DAY + 5, -8));
    const r = diffByDay(a, b);
    expect(r.diff?.toFixed(1)).toBe("5.0");
    expect(r.clusters).toBe(4);
    // Mỗi ngày đều chênh đúng 5 bp → khoảng suy biến tại 5.
    expect(r.ciLow?.toFixed(1)).toBe("5.0");
    expect(r.ciHigh?.toFixed(1)).toBe("5.0");
    expect(diffByDay(a.slice(0, 2), b.slice(0, 1)).ciLow).toBeNull();
    expect(diffByDay(a, []).diff).toBeNull();
  });
});

describe("simulate (real volumeFarm through the backtest engine)", () => {
  const start = T0;
  const candles = path(2_000, start);
  const config = studyConfig("ETH-USD", STUDY_DEFAULT_CONFIG);
  if (config === null) throw new Error("study default must parse");
  const base = {
    market: "ETH-USD",
    candles,
    rules: { tickSize: "0.01", stepSize: "0.00000001", minQuantity: "0", minNotional: "0" },
    config,
    fees,
    from: start + 180 * 60_000,
    to: start + 2_000 * 60_000,
  };

  it("groups fills into closed trades with Decimal accounting and entry snapshots", () => {
    const r = simulate({ ...base, research: { counterTrendMode: "off" } });
    expect(r.trades.length).toBeGreaterThan(20);
    for (const t of r.trades) {
      expect(t.net.toFixed()).toBe(t.gross.sub(t.fees).toFixed());
      expect(t.netBp.toFixed(6)).toBe(t.net.div(t.entryNotional).mul(10_000).toFixed(6));
      expect(t.at).toBeGreaterThanOrEqual(base.from);
      expect(t.regime).not.toBe("");
    }
    expect(r.trades.some((t) => t.move3m !== null)).toBe(true);
  });

  it("variants differ from each other and the study runs every variant both ways", () => {
    const rep = runStudy(
      { market: "ETH-USD", candles, rules: base.rules, config, configSource: "test", liveBots: 0 },
      fees,
      { from: base.from, to: base.to },
      2,
    );
    expect(rep.rows.map((x) => `${x.key}${x.reverse ? "+" : "-"}`)).toEqual([
      "A-",
      "B-",
      "B′-",
      "C-",
      "D-",
      "A+",
      "B+",
      "B′+",
      "C+",
      "D+",
    ]);
    const n = (k: string, rev: boolean) =>
      rep.rows.find((x) => x.key === k && x.reverse === rev)?.all.n ?? -1;
    // Không chặn thì không ít lượt hơn A trên cùng dữ liệu (cùng nhịp cooldown, chỉ thêm cơ hội).
    expect(n("C", false)).toBeGreaterThan(0);
    expect(n("D", false)).toBeGreaterThan(0);
    expect(rep.random.all.n).toBeGreaterThan(0);
    expect(rep.random.sim.runs).toBe(2);
    for (const x of rep.rows) {
      expect(x.vsR).not.toBeNull();
      expect(x.vsOwn).not.toBeNull();
      expect(x.own?.runs).toBe(2);
      // Lượt tín hiệu + lượt cân long / short = mọi lượt.
      expect(x.entryType.signal.s.n + x.entryType.balanced.s.n).toBe(x.all.n);
      expect(x.exclDouble.n).toBe(x.all.n - x.doubleClosed);
    }
    // Baseline riêng giữ thời điểm vào của biến thể: số lệnh vào mỗi seed gần bằng biến thể (đường giá khác sau mỗi lượt
    // nên không bằng hẳn).
    const a = rep.rows[0];
    if (a?.own == null) throw new Error("missing row");
    expect(a.own.entryOrders / a.own.runs).toBeGreaterThan(a.sim.entryOrders * 0.6);
    const md = toMarkdown([rep], {
      source: "test",
      generatedAt: T0,
      range: { from: base.from, to: base.to },
      notes: [],
    });
    expect(md).toContain("## ETH-USD");
    expect(md).toContain("| R random, no gates |");
    expect(md).toContain("Few clusters");
    expect(md).toContain("~4 min");
    expect(md).toContain("Signal entries vs DEC-80 balancing entries");
    expect(md).toContain("By regime at entry");
  });
});

describe("bookTrade (double close until #284)", () => {
  const f = (at: number, tag: string, side: "buy" | "sell", price: string, quantity: string) => ({
    at,
    tag,
    side,
    price,
    quantity,
    fee: dec(price).mul(quantity).mul("0.0002").toFixed(),
  });

  it("books a clean trade exactly", () => {
    const b = bookTrade([
      f(0, "vf:1:in:0", "buy", "100", "2"),
      f(60, "vf:1:out:0", "sell", "101", "2"),
    ]);
    expect(b?.gross.toFixed()).toBe("2");
    expect(b?.fees.toFixed()).toBe(d("0.04").add("0.0404").toFixed());
    expect(b?.doubleClosed).toBe(false);
  });

  it("books a double close at the first close, capped at the entry quantity", () => {
    // Stop khớp trước (99), lệnh thoát của bot khớp thêm (98) và đảo vị thế: chỉ tính lần đóng đầu, đủ 2.
    const b = bookTrade([
      f(0, "vf:2:in:0", "buy", "100", "2"),
      f(60, "vf:2:sl", "sell", "99", "2"),
      f(60, "vf:2:out:0", "sell", "98", "2"),
    ]);
    expect(b?.gross.toFixed()).toBe("-2");
    expect(b?.exitNotional.toFixed()).toBe("198");
    expect(b?.fees.toFixed()).toBe(d("0.04").add("0.0396").toFixed());
    expect(b?.doubleClosed).toBe(true);
  });

  it("drops a leftover from the previous cycle: the stop closing more than the entry is capped", () => {
    // Vị thế thừa 1 của lượt trước: stop đóng 3, chỉ tính 2 của lượt này; phí của lần đóng theo tỉ lệ 2/3.
    const b = bookTrade([
      f(0, "vf:3:in:0", "buy", "100", "2"),
      f(60, "vf:3:sl", "sell", "99", "3"),
    ]);
    expect(b?.gross.toFixed()).toBe("-2");
    expect(b?.fees.toFixed()).toBe(
      d("0.04").add(d("99").mul(3).mul("0.0002").mul(2).div(3)).toFixed(),
    );
    expect(b?.doubleClosed).toBe(true);
  });

  it("an entry without a close is still open", () => {
    expect(bookTrade([f(0, "vf:4:in:0", "buy", "100", "2")])).toBeNull();
  });
});

describe("random baselines", () => {
  it("pools several coin seeds", () => {
    const start = T0;
    const config = studyConfig("ETH-USD", STUDY_DEFAULT_CONFIG);
    if (config === null) throw new Error("study default must parse");
    const input = {
      market: "ETH-USD",
      candles: path(600, start),
      rules: { tickSize: "0.01", stepSize: "0.00000001", minQuantity: "0", minNotional: "0" },
      config,
      fees,
      research: { randomDirection: true },
      from: start + 180 * 60_000,
      to: start + 600 * 60_000,
    };
    const one = simulate({ ...input, research: { randomDirection: true, randomSalt: "0" } });
    const three = simulateSeeds(input, 3);
    expect(three.runs).toBe(3);
    expect(three.trades.length).toBeGreaterThan(one.trades.length);
    const sides = (xs: typeof one.trades) => xs.map((t) => t.side).join("");
    expect(sides(three.trades)).not.toBe(sides(one.trades));
  });
});

describe("loader guards", () => {
  it("study config keeps the bot's settings but never halts or filters by hour / regime", () => {
    const c = studyConfig("BTC-USD", {
      ...STUDY_DEFAULT_CONFIG,
      market: "ETH-USD",
      maxLoss: "5",
      volumeTarget: "1000",
      sidewaysOnly: true,
      blockedHoursUtc: [1, 2],
      minHoldSecs: 60,
      maxHoldSecs: 90,
    });
    expect(c).toMatchObject({
      market: "BTC-USD",
      maxLoss: "1000000000",
      sidewaysOnly: false,
      blockedHoursUtc: [],
      minHoldSecs: 60,
      maxHoldSecs: 90,
    });
    expect(c?.volumeTarget).toBeUndefined();
    expect(studyConfig("BTC-USD", { leverage: "x" })).toBeNull();
  });

  it(`refuses ranges over ${String(MAX_RANGE_DAYS)} days, reversed and future ranges`, () => {
    const now = T0 + 30 * DAY;
    expect(() => {
      checkRange(new Date(T0), new Date(T0 + 15 * DAY), now);
    }).toThrow(StudyLimitError);
    expect(() => {
      checkRange(new Date(T0 + DAY), new Date(T0), now);
    }).toThrow(StudyLimitError);
    expect(() => {
      checkRange(new Date(now), new Date(now + 2 * DAY), now);
    }).toThrow(/future/);
    expect(() => {
      checkRange(new Date(T0), new Date(T0 + 14 * DAY), now);
    }).not.toThrow();
  });

  it("the CLI exits with code 2 before touching the database on a bad range", () => {
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/vb-counter-trend/cli.ts",
        "--from",
        "2026-11-01",
        "--to",
        "2026-11-18",
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/longer than 14 days/);
    expect(run.stdout).toBe("");
  });
});
