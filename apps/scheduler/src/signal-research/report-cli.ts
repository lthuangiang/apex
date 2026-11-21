import {
  createDb,
  loadSignalResearchDiagnostics,
  loadSignalResearchSummary,
  loadSignalResearchTrades,
  readOnlyTx,
} from "@drift/db";
import type { ResearchSummary, ResearchTrade } from "@drift/shared";
import { z } from "zod";

import { signalResearchEnvSchema } from "./index";

// `pnpm --filter @drift/scheduler signals:report [-- --json]`: báo cáo lane tin tức (#271), chỉ đọc (transaction READ
// ONLY). Cùng dữ liệu với `GET /api/v1/admin/signal-research/summary`, cộng lý do nội bộ và baseline chi tiết.

const { DATABASE_URL } = z.object({ DATABASE_URL: z.string().min(1) }).parse(process.env);
const env = signalResearchEnvSchema.parse(
  Object.fromEntries(Object.keys(signalResearchEnvSchema.shape).map((k) => [k, process.env[k]])),
);
const json = process.argv.includes("--json");

type Diagnostics = Awaited<ReturnType<typeof loadSignalResearchDiagnostics>>;
type Range = Diagnostics["baseline"]["newsResult"];

const pct = (n: number | null) => (n === null ? "n/a" : `${String(n)}%`);
const range = (x: Range) =>
  x === null
    ? "Not available"
    : `${pct(x.meanPct)} (n=${String(x.n)}, ${String(x.clusters)} days, likely ${pct(x.lowPct)}..${pct(x.highPct)})`;

function tradeLine(t: ResearchTrade): string {
  const res =
    t.result === null
      ? `skipped ${t.skipped?.reason ?? ""}`
      : t.result.outcome === "open"
        ? "open"
        : `${t.result.pnl ?? "?"} USDC ${t.result.outcome}`;
  const what =
    t.what.type === "news" ? `${t.what.newsType} ${t.what.levelAtEntry ?? ""}` : t.what.type;
  return `  ${t.seenAt.slice(0, 16)} ${t.asset.padEnd(12)} ${t.side.padEnd(5)} ${what.padEnd(24)} entry ${t.entry ?? "-"} TP ${t.tp ?? "-"} SL ${t.sl ?? "-"} moved ${pct(t.movedBeforePct)} → ${res}`;
}

function print(s: ResearchSummary, d: Diagnostics, trades: ResearchTrade[]): void {
  const out: string[] = [];
  out.push(
    `Signal research · News · rules v${String(s.newsRulesVersion ?? "-")} · ${s.computedAt}`,
  );
  out.push("Sources");
  for (const x of s.sources)
    out.push(`  ${x.key.padEnd(12)} ${x.status.padEnd(8)} last ${x.lastAt ?? "-"}`);
  out.push("Usage (UTC days)");
  for (const u of d.claudeDays)
    out.push(
      `  ${u.day}: SoSoValue ${String(u.sosoRequests)} req · Claude ${String(u.calls)} calls, in ${String(u.inputTokens)} + cache write ${String(u.cacheWriteTokens)} + cache read ${String(u.cacheReadTokens)}, out ${String(u.outputTokens)} ≈ $${u.costUsd}`,
    );
  const f = s.funnel;
  if (f !== null) {
    out.push(
      `SoSoValue this month: ${String(f.soso?.used ?? 0)}/${String(f.soso?.limit ?? 0)} · median delay ${f.delayMedianSecs === null ? "n/a" : `${String(f.delayMedianSecs)} s`} · Claude/day ${f.claudeCostPerDay === null ? "n/a" : `$${f.claudeCostPerDay}`}`,
    );
    out.push(
      `Funnel: read ${String(f.articlesRead ?? 0)} → collected ${String(f.collected)} → signals ${String(f.signals)} → stories ${String(f.stories)} (merged ${String(f.merged)}) → passed ${String(f.passed)} → long ${String(f.long)} / short ${String(f.short)}`,
    );
    out.push(
      `Outcomes: closed ${String(f.outcomes.closed)} (TP ${String(f.outcomes.tp)}, SL ${String(f.outcomes.sl)}, max hold ${String(f.outcomes.maxHold)}), open ${String(f.outcomes.open)}`,
    );
  }
  out.push(`Backlog (stored raw, not classified; not a drop): ${String(d.backlog)}`);
  out.push("Steps (internal reason codes)");
  for (const x of d.steps)
    out.push(
      `  ${x.stage.padEnd(11)} ${x.outcome.padEnd(6)} ${(x.reason ?? "-").padEnd(28)} ${String(x.n)}`,
    );
  out.push(
    "Claude catalysts: " +
      (d.catalysts.map((c) => `${c.catalyst}=${String(c.n)}`).join(", ") || "none yet"),
  );
  for (const r of s.rows)
    out.push(
      `${r.type} · ${r.label} · v${String(r.rulesVersion)}: closed ${String(r.closed)}, after fees ${pct(r.avgPct)}, random ${pct(r.randomPct)}, difference ${pct(r.diffPct)}, cost ${pct(s.costPct)}, ${r.status}, needs ${JSON.stringify(r.needs)}`,
    );
  for (const x of s.directions)
    out.push(
      `  ${x.side.padEnd(6)} closed ${String(x.closed)} (${String(x.clusters)} days), after fees ${pct(x.avgPct)}, random ${pct(x.randomPct)}, diff ${pct(x.diffPct)}`,
    );
  for (const l of s.levels)
    out.push(
      `  ${l.level.padEnd(6)} signals ${String(l.signals)}, trades ${String(l.trades)} (L ${String(l.long)} / S ${String(l.short)}), closed ${String(l.closed)}, after fees ${pct(l.avgPct)}, random ${pct(l.randomPct)}, diff ${pct(l.diffPct)}, ${l.status}`,
    );
  out.push(
    `Random-entry baseline (stored at close; ${String(d.baseline.n)} trades, ${String(d.baseline.pending)} pending, ${String(d.baseline.missingCandles)} without candles, latest long share ${String(d.baseline.latestLongShare ?? "n/a")})`,
  );
  out.push(`  news result  ${range(d.baseline.newsResult)}`);
  out.push(`  random entry ${range(d.baseline.randomEntry)}`);
  out.push(`  difference   ${range(d.baseline.difference)}`);
  out.push(`Trades and skipped signals (latest ${String(trades.length)})`);
  for (const t of trades) out.push(tradeLine(t));
  console.log(out.join("\n"));
}

const { db, pool } = createDb(DATABASE_URL);
try {
  const now = new Date();
  const [summary, diagnostics, page] = await readOnlyTx(
    db,
    { statementTimeoutMs: 30_000, deadlineMs: 120_000 },
    async (tx, check) =>
      [
        await loadSignalResearchSummary(
          tx,
          now,
          {
            sosoMonthlyLimit: env.SIGNAL_SOSO_MONTHLY_LIMIT,
            claudeDailyInputBudget: env.SIGNAL_CLAUDE_DAILY_INPUT_TOKENS,
            // CLI chạy trong container scheduler: cùng env với scheduler.
            cycleMinutes: env.SIGNAL_NEWS_CYCLE_MINUTES,
          },
          check,
        ),
        await loadSignalResearchDiagnostics(tx, now),
        await loadSignalResearchTrades(tx, { limit: 50, show: "all" }, now),
      ] as const,
  );
  if (json) console.log(JSON.stringify({ summary, diagnostics, trades: page.items }, null, 2));
  else print(summary, diagnostics, page.items);
} finally {
  await pool.end();
}
