import { Decimal } from "@drift/shared";

import { defaultRules, evaluate, momentumRule, toMarkdown, type ReplayEntry } from "./vb-replay";

// Báo cáo mẫu từ dữ liệu TỰ DỰNG (không phải dữ liệu thật) để xem định dạng báo cáo replay VB (#235):
//   pnpm --filter @drift/backtest replay:vb:sample > sample.md
// Dữ liệu xác định (seed cố định): tới 800 lượt BTC / ETH trong 7 ngày (chỉ giữ lượt mà luật (c) với k = 1 ra keep); lượt vào sau khi giá đã chạy theo hướng tín hiệu lỗ
// hơn trước phí, để thấy luật nào cải thiện Δ (mẫu này không cố tạo luật PASS; số liệu không có ý nghĩa thật).

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleEntries(n = 800, seed = 235): ReplayEntry[] {
  const r = rng(seed);
  const start = Date.parse("2026-11-11T00:00:00Z");
  const span = 7 * 86_400_000;
  const k1 = momentumRule(1);
  return Array.from({ length: n }, (_, i) => {
    const at = start + Math.floor((i / n) * span);
    const btc = r() < 0.5;
    const price = btc ? 90_000 : 3_000;
    const side = r() < 0.5 ? "long" : "short";
    const s = side === "long" ? 1 : -1;
    const regime = r() < 0.55 ? "SIDEWAY" : r() < 0.5 ? "TREND_UP" : "TREND_DOWN";
    const m3 = (r() * 12 - 3) * s; // phần lớn đã chạy theo hướng tín hiệu
    const chased = m3 * s >= 5;
    // bp trước phí: đuổi giá −2.5 bp, còn lại −0.5 bp, nhiễu ±3 bp; có xu hướng thêm −1 bp.
    const bp = (chased ? -2.5 : -0.5) + (regime === "SIDEWAY" ? 0 : -1) + (r() * 6 - 3);
    const entry = new Decimal(price);
    const exit = entry.mul(1 + (s * bp) / 10_000);
    const qty = new Decimal(150).div(entry);
    const volume = entry.mul(qty).add(exit.mul(qty));
    const tick = new Decimal(btc ? "0.1" : "0.01");
    const wiggle = entry.mul((r() * 2.5) / 10_000);
    return {
      botId: btc ? "sample-btc" : "sample-eth",
      market: btc ? "BTC-USD" : "ETH-USD",
      at,
      direction: side,
      side,
      reversed: false,
      balanced: r() < 0.1,
      regime,
      components: {
        candleMomentum: side === "long" ? 0.55 + r() * 0.4 : 0.05 + r() * 0.4,
        wickRejection: 0.3 + r() * 0.4,
        volumeAcceleration: 0.3 + r() * 0.4,
        tradePressure: 0.5,
        orderbookImbalance: 0.3 + r() * 0.4,
      },
      chgBps: { m1: m3 / 2, m3, m5: m3 * 1.3 },
      entryPrice: entry,
      exitPrice: exit,
      qty,
      fees: volume.mul(0.00011),
      volume,
      t0: at + 2_000,
      t1: at + 120_000,
      tick,
      reach: {
        low: entry.sub(wiggle),
        high: entry.add(wiggle),
        source: r() < 0.3 ? "mid_1s" : "candle",
      },
    } satisfies ReplayEntry;
  }).filter((e) => k1.apply(e).kind === "keep"); // chỉ lượt mà điểm dựng lại khớp hướng đã vào, như dữ liệu thật
}

if (process.argv[1]?.endsWith("sample.ts") === true) {
  const report = evaluate(sampleEntries(), defaultRules());
  process.stdout.write(
    toMarkdown(report, {
      source: "SYNTHETIC sample data (not real trades)",
      generatedAt: Date.parse("2026-11-18T00:00:00Z"),
    }),
  );
}
