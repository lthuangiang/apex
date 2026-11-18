import { writeFileSync } from "node:fs";

import { createDb, DeadlineExceededError, readOnlyTx } from "@drift/db";
import { Decimal } from "@drift/shared";
import { z } from "zod";

import { guardIdleKill, IDLE_KILL_MESSAGE, isIdleKill } from "../replay/abort";

import { checkRange, SignalReplayLimitError } from "./load";
import { ALL_PARTS, runSignalReplay, type ReplayPart, type SignalReplayReport } from "./run";

// CLI replay tín hiệu A / B / C + D1 (#274). Chỉ đọc: một `readOnlyTx` (READ ONLY, statement timeout mỗi câu, idle
// timeout, trần thời gian tổng). Không gọi REST SoDEX, không đặt lệnh, không cần Redis. Báo cáo JSON ra --out (hoặc
// stdout), tóm tắt và log ra stderr. Chạy trên prod (image backtest):
//   docker compose run --rm -T backtest apps/backtest/node_modules/.bin/tsx apps/backtest/src/signal-replay/cli.ts \
//     --from 2026-10-28 --to 2026-11-18 > signal-replay.json
// Tuỳ chọn: --parts whale,funding,price_structure,risk_filter (mặc định tất cả)  --trades all|entered|none (mặc định all)

const LONG_DECIMAL = /^-?\d+\.\d{11,}$/;
const QUERY_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 120_000;
const DEADLINE_MS = 20 * 60_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const date = (v: string | undefined, name: string) => {
  if (v === undefined) throw new Error(`--${name} is required (YYYY-MM-DD or ISO time, UTC)`);
  const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(t)) throw new Error(`--${name}: not a date: ${v}`);
  return new Date(t);
};

const env = z.object({ DATABASE_URL: z.string().min(1) }).parse(process.env);
const partSchema = z.enum(["whale", "funding", "price_structure", "risk_filter"]);
const tradesSchema = z.enum(["all", "entered", "none"]);

function fail(message: string): never {
  process.stderr.write(`signal-replay: ${message}\n`);
  process.exit(2);
}

let from: Date;
let to: Date;
let parts: ReplayPart[];
let tradesMode: z.infer<typeof tradesSchema>;
try {
  from = date(arg("from"), "from");
  to = date(arg("to"), "to");
  checkRange(from, to);
  const p = arg("parts");
  parts = p === undefined ? [...ALL_PARTS] : p.split(",").map((x) => partSchema.parse(x.trim()));
  tradesMode = tradesSchema.parse(arg("trades") ?? "all");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
setTimeout(
  () => {
    fail(`stopped after ${String(DEADLINE_MS / 60_000)} min (time limit)`);
  },
  DEADLINE_MS + 2 * QUERY_TIMEOUT_MS,
).unref();

const log = (msg: string) => process.stderr.write(`signal-replay: ${msg}\n`);
const { db, pool } = createDb(env.DATABASE_URL);
guardIdleKill(
  pool,
  () => {
    fail(IDLE_KILL_MESSAGE);
  },
  (e) => {
    log(`database client error (${String(e)})`);
  },
);

function summaryLines(r: SignalReplayReport): string[] {
  const f = (d: { toDecimalPlaces: (n: number) => { toString: () => string } } | null) =>
    d === null ? "n/a" : d.toDecimalPlaces(1).toString();
  const lines = [`range ${r.range.from} → ${r.range.to}`];
  for (const g of r.groups) {
    const a = g.report.all;
    const oos = g.report.outOfSample;
    lines.push(
      `${g.type}/${g.variant} ${g.ruleVersion}: entered ${String(g.report.entered)}, skipped ${String(g.report.skipped)}; mean after fees ${f(a.afterFees.mean)} bp [${f(a.afterFees.ciLow)}, ${f(a.afterFees.ciHigh)}] over ${String(a.afterFees.clusters)} days, vs random ${f(a.difference.mean)} bp [${f(a.difference.ciLow)}, ${f(a.difference.ciHigh)}]; max drawdown ${f(a.maxDrawdown.bp)} bp; out-of-sample n ${String(oos.n)} mean ${f(oos.afterFees.mean)} bp; gate ${g.report.gate.status} (${g.report.gate.tradesNeededNote})`,
    );
  }
  if (r.riskFilter !== null) {
    const v = r.riskFilter.volumeBuilder;
    const m = r.riskFilter.marketMaking;
    lines.push(
      `risk filter (${String(r.riskFilter.windows.length)} windows): VB cost/$1M ${f(v.baseline.costPerMillion)} → ${f(v.filtered.costPerMillion)}, volume lost ${f(v.volumeLostPct)}%; MM cost/$1M ${f(m.baseline.costPerMillion)} → ${f(m.filtered.costPerMillion)}, volume lost ${f(m.volumeLostPct)}%`,
    );
  }
  return lines;
}

try {
  const report = await readOnlyTx(
    db,
    {
      statementTimeoutMs: QUERY_TIMEOUT_MS,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      deadlineMs: DEADLINE_MS,
    },
    (q, checkDeadline) => runSignalReplay(q, { from, to, parts, checkDeadline, log }),
  ).catch((error: unknown) => {
    if (error instanceof SignalReplayLimitError || error instanceof DeadlineExceededError)
      fail(error.message);
    if (isIdleKill(error)) fail(IDLE_KILL_MESSAGE);
    throw error;
  });
  for (const g of report.groups)
    g.trades =
      tradesMode === "all"
        ? g.trades
        : tradesMode === "entered"
          ? g.trades.filter((t) => t.status === "entered")
          : [];
  // Decimal ra JSON với đủ 40 chữ số: giữ 10 chữ số có nghĩa cho dễ đọc (chỉ ở bước in, phép tính đã xong).
  const json = JSON.stringify(
    report,
    (_k, v: unknown) =>
      typeof v === "string" && LONG_DECIMAL.test(v)
        ? new Decimal(v).toSignificantDigits(10).toString()
        : v,
    2,
  );
  const out = arg("out");
  if (out === undefined) process.stdout.write(`${json}\n`);
  else writeFileSync(out, `${json}\n`);
  for (const line of summaryLines(report)) log(line);
} finally {
  await pool.end();
}
