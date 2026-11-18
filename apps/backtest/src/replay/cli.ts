import { createDb } from "@drift/db";
import { dec, type Decimal } from "@drift/shared";
import { loadSodexConfig, RedisRateLimitStore, SodexRestClient } from "@drift/sodex";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { z } from "zod";

import { loadEntries } from "./load";
import { DEFAULT_GRIDS, defaultRules, evaluate, toMarkdown } from "./vb-replay";

// CLI replay VB (#235). Chỉ đọc: một transaction READ ONLY, statement timeout mỗi câu; tick size đọc từ REST công khai
// của SoDEX (chỉ đọc, có cache). Báo cáo markdown ra stdout, log ra stderr. Chạy trên prod (image backtest):
//   docker compose run --rm -T backtest apps/backtest/node_modules/.bin/tsx apps/backtest/src/replay/cli.ts \
//     --from 2026-11-11 --to 2026-11-18 > report.md
// Tuỳ chọn: --chase 2,3,5,8,12  --pullback 1,2,3  --momentum 0.5,0.25,0  (lưới của từng luật).

const QUERY_TIMEOUT_MS = 30_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const list = (v: string | undefined, fallback: number[]) =>
  v === undefined ? fallback : v.split(",").map((x) => z.coerce.number().parse(x.trim()));
const date = (v: string | undefined, name: string) => {
  if (v === undefined) throw new Error(`--${name} is required (YYYY-MM-DD or ISO time, UTC)`);
  const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(t)) throw new Error(`--${name}: not a date: ${v}`);
  return new Date(t);
};

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    SODEX_EGRESS_KEY: z.string().default("default"),
  })
  .parse(process.env);

const from = date(arg("from"), "from");
const to = date(arg("to"), "to");
if (to <= from) throw new Error("--to must be after --from");
const grids = {
  ...DEFAULT_GRIDS,
  chaseBps: list(arg("chase"), DEFAULT_GRIDS.chaseBps),
  pullbackTicks: list(arg("pullback"), DEFAULT_GRIDS.pullbackTicks),
  momentumScale: list(arg("momentum"), DEFAULT_GRIDS.momentumScale),
};

const { db, pool } = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
try {
  const ticks = new Map<string, Decimal>();
  try {
    const rest = new SodexRestClient({
      config: loadSodexConfig(process.env),
      rateLimit: new RedisRateLimitStore(redis),
      egressKey: env.SODEX_EGRESS_KEY,
      priority: "background",
    });
    for (const s of await rest.getPerpsSymbols()) ticks.set(s.name, dec(s.tickSize));
  } catch (error) {
    // Không đọc được tick: luật pullback bỏ mọi lượt (báo cáo ghi rõ), các luật khác vẫn chạy.
    process.stderr.write(`replay: tick sizes unavailable (${String(error)})\n`);
  }
  const loaded = await db.transaction(async (q) => {
    await q.execute(sql`SET TRANSACTION READ ONLY`);
    await q.execute(sql.raw(`SET LOCAL statement_timeout = ${String(QUERY_TIMEOUT_MS)}`));
    return loadEntries(q, { from, to, ticks });
  });
  const report = evaluate(loaded.entries, defaultRules(grids));
  const md = toMarkdown(report, { source: "production data (read-only)", generatedAt: Date.now() });
  process.stdout.write(md);
  process.stdout.write(
    [
      "",
      "**Loader:**",
      `- Entry snapshots in range: ${String(loaded.snapshots)} (invalid, skipped: ${String(loaded.invalid)}).`,
      `- Not matched to a closed trade (entry cancelled after 10 s, or still open): ${String(loaded.unmatched)}.`,
      `- 10 s price source: mid_1s ${String(loaded.reach.mid1s)}, 1-minute candle ${String(loaded.reach.candle)}, none ${String(loaded.reach.none)}.`,
      `- Tick sizes read for ${String(ticks.size)} markets.`,
      "",
    ].join("\n"),
  );
} finally {
  await pool.end();
  redis.disconnect();
}
