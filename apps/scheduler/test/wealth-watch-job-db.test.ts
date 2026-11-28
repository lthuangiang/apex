import {
  createDb,
  outbox,
  runMigrations,
  sodexAccounts,
  users,
  wealthWatch,
  type Db,
} from "@drift/db";
import type { WealthReadClient } from "@drift/sodex";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFundNames,
  runWealthWatchTick,
  type WealthWatchJobDeps,
} from "../src/wealth-watch/job";

// #594 (DEC-404): job cảnh báo SoDEX Wealth trên Postgres thật (Testcontainers, CI). Gateway Wealth là giả. Địa chỉ ví
// là địa chỉ giả.

const INTERVAL = 10 * 60_000;

type Reader = WealthWatchJobDeps["reader"];
type Details = Awaited<ReturnType<WealthReadClient["getFundDetails"]>>;
type Plans = Awaited<ReturnType<WealthReadClient["getRecurringBuys"]>>;
type Execs = Awaited<ReturnType<WealthReadClient["getRecurringBuyExecutions"]>>;
type Entry = Extract<Details, { kind: "ok" }>["data"]["entries"][number];

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];

const state = {
  now: new Date("2026-11-28T08:00:00Z"),
  details: null as Details | null,
  plans: null as Plans | null,
  execs: null as Execs | null,
  calls: [] as string[],
  warns: [] as { obj: Record<string, unknown>; msg: string }[],
};

const reader: Reader = {
  getFundDetails: (address) => {
    state.calls.push(`details:${address}`);
    return Promise.resolve(state.details ?? { kind: "not_provided", reason: "network" });
  },
  getRecurringBuys: () => {
    state.calls.push("plans");
    return Promise.resolve(state.plans ?? { kind: "not_provided", reason: "business" });
  },
  getRecurringBuyExecutions: (_a, planIndex) => {
    state.calls.push(`execs:${planIndex}`);
    return Promise.resolve(state.execs ?? { kind: "not_provided", reason: "network" });
  },
  getFunds: () => {
    state.calls.push("funds");
    return Promise.resolve({
      kind: "ok",
      data: [
        {
          fundId: "fund-a",
          name: "Sample Fund A",
          fundType: "escrow_vault",
          fundStatus: "live",
          iconUrl: null,
          tagline: null,
          nav: null,
          aum: null,
          asOf: null,
        },
      ],
    });
  },
};

function deps(enabled = true): WealthWatchJobDeps {
  return {
    db,
    now: () => state.now,
    reader,
    enabled,
    intervalMs: INTERVAL,
    batch: 20,
    log: { warn: (obj, msg) => state.warns.push({ obj, msg }) },
  };
}
const tick = (enabled = true) => runWealthWatchTick(deps(enabled), createFundNames());

const entry = (over: Partial<Entry> = {}): Entry => ({
  fundId: "fund-a",
  entryId: null,
  kind: "subscribe",
  status: "processing",
  transactionType: null,
  channel: null,
  source: null,
  requestedAt: "2026-11-27T10:00:00Z",
  at: "2026-11-27T10:00:00Z",
  shares: null,
  requestedShares: null,
  proceeds: null,
  cost: "500.000000",
  costEstimated: null,
  planIndex: null,
  ...over,
});
const details = (entries: Entry[]): Details => ({
  kind: "ok",
  data: { totals: [], entries, bridgeStatus: null },
});

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await db.delete(wealthWatch);
  await db.delete(outbox);
  state.details = details([]);
  state.plans = null;
  state.execs = null;
  state.calls = [];
  state.warns = [];
});

let n = 0;
async function watcher(opts: { baseline?: boolean; role?: "user" | "team" } = {}) {
  n += 1;
  const [u] = await db
    .insert(users)
    .values({ email: `ww-job${String(n)}@x.test`, role: opts.role ?? "user" })
    .returning();
  const address = `0x${(0xc000 + n).toString(16).padStart(40, "0")}`;
  const [a] = await db
    .insert(sodexAccounts)
    .values({
      userId: u?.id ?? "",
      address,
      sodexAccountId: BigInt(19000 + n),
      network: "mainnet",
      status: "connected",
    })
    .returning();
  const userId = u?.id ?? "";
  await db.insert(wealthWatch).values({
    userId,
    sodexAccountId: a?.id ?? "",
    baselinePending: opts.baseline ?? true,
    nextCheckAt: new Date(state.now.getTime() - 1000),
  });
  return { userId, accountId: a?.id ?? "", address };
}

const rowOf = async (userId: string) =>
  (await db.select().from(wealthWatch).where(eq(wealthWatch.userId, userId)))[0];
const notices = async () =>
  (await db.select().from(outbox).where(eq(outbox.topic, "jobs.notify"))).map(
    (o) =>
      o.payload as {
        userId: string;
        type: string;
        data: Record<string, unknown>;
        dedupeKey: string;
      },
  );
const makeDue = (userId: string) =>
  db
    .update(wealthWatch)
    .set({ nextCheckAt: new Date(state.now.getTime() - 1000) })
    .where(eq(wealthWatch.userId, userId));

describe("wealth watch job", () => {
  it("first pass only sets marks: no alert for old history; stores no amounts", async () => {
    const w = await watcher();
    state.details = details([
      entry({ status: "completed" }),
      entry({ kind: "redeem", status: "failed" }),
    ]);
    const r = await tick();
    expect(r).toMatchObject({ checked: 1, baselined: 1, notified: 0 });
    expect(await notices()).toHaveLength(0);
    const row = await rowOf(w.userId);
    expect(row?.baselinePending).toBe(false);
    expect(Object.values(row?.fundMarks ?? {})).toEqual(["completed", "failed"]);
    // Không lưu số tiền / địa chỉ.
    const stored = JSON.stringify(row);
    expect(stored).not.toContain("500");
    expect(stored).not.toContain(w.address.slice(2));
    expect(row?.nextCheckAt.getTime()).toBeGreaterThan(state.now.getTime());
  });

  it("a request moving to completed sends exactly one alert, with the SoDEX amount and fund name", async () => {
    const w = await watcher();
    state.details = details([entry()]);
    await tick();
    state.details = details([entry({ status: "completed", shares: "4.9" })]);
    await makeDue(w.userId);
    const r = await tick();
    expect(r.notified).toBe(1);
    const sent = await notices();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      userId: w.userId,
      type: "wealth_request_settled",
      data: {
        fundId: "fund-a",
        fundName: "Sample Fund A",
        what: "invest",
        status: "completed",
        cost: "500.000000",
        shares: "4.9",
      },
    });
    expect(sent[0]?.dedupeKey).toMatch(/^wf:[0-9a-f]{24}:completed$/);
    expect(JSON.stringify(sent[0])).not.toContain(w.address.slice(2));
    // Lượt sau cùng dữ liệu: không báo lại.
    await makeDue(w.userId);
    await tick();
    expect(await notices()).toHaveLength(1);
  });

  it("unknown status: no alert, a log line without the wallet address", async () => {
    const w = await watcher({ baseline: false });
    state.details = details([entry({ status: "mystery_state" })]);
    await tick();
    expect(await notices()).toHaveLength(0);
    const line = state.warns.find((x) => x.msg.includes("unknown SoDEX value"));
    expect(line?.obj).toMatchObject({ field: "fund_status", value: "mystery_state" });
    expect(JSON.stringify(state.warns)).not.toContain(w.address.slice(2));
  });

  it("recurring-buys code -1 counts as no plans, not as an error", async () => {
    const w = await watcher();
    state.plans = { kind: "not_provided", reason: "business" };
    const r = await tick();
    expect(r.errors).toBe(0);
    const row = await rowOf(w.userId);
    expect(row).toMatchObject({ hasPlans: false, consecutiveErrors: 0, lastErrorCode: null });
    expect(row?.plansCheckedAt?.getTime()).toBe(state.now.getTime());
    // Không có plan: lượt sau trong ngày không đọc recurring-buys.
    state.calls = [];
    await makeDue(w.userId);
    await tick();
    expect(state.calls).not.toContain("plans");
  });

  it("a skipped recurring run on an ACTIVE plan alerts once; paused plans are not read", async () => {
    const w = await watcher();
    const plan = (planIndex: string, status: string) => ({
      planIndex,
      dcaAddress: "0x2222222222222222222222222222222222222222",
      fundId: "fund-a",
      target: null,
      amount: "25",
      planType: "WEEKLY",
      dayOfPeriod: 1,
      createdAt: null,
      status,
      successfulExecutionCount: 1,
      nextScheduledAt: null,
      totalBuyAmount: null,
      totalBuyShares: null,
      avgCost: null,
      processingAmount: null,
      anomalyCount: null,
    });
    state.plans = {
      kind: "ok",
      data: { availableAssets: null, plans: [plan("1", "ACTIVE"), plan("2", "PAUSED")] },
    };
    const run = (status: string) => ({
      kind: "ok" as const,
      data: {
        planIndex: "1",
        executions: [
          {
            scheduledLocalDate: "2026-11-28",
            scheduledAt: null,
            status,
            reasonCode: null,
            amount: "25",
            attemptedAt: null,
            executedAt: null,
          },
        ],
      },
    });
    state.execs = run("pending");
    await tick();
    expect(state.calls).toContain("execs:1");
    expect(state.calls).not.toContain("execs:2");
    expect((await rowOf(w.userId))?.hasPlans).toBe(true);
    state.execs = run("SKIPPED");
    await makeDue(w.userId);
    await tick();
    await makeDue(w.userId);
    await tick();
    const sent = await notices();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "wealth_recurring_issue",
      data: { fundId: "fund-a", status: "skipped", scheduledDate: "2026-11-28", amount: "25" },
    });
  });

  it("out of budget: the pass moves to the next tick, no error, nothing written", async () => {
    const w = await watcher({ baseline: false });
    state.details = { kind: "not_provided", reason: "budget", retryAfterMs: 5000 };
    const r = await tick();
    expect(r).toMatchObject({ stopped: "budget", errors: 0, checked: 0 });
    const row = await rowOf(w.userId);
    expect(row?.consecutiveErrors).toBe(0);
    expect(row?.lastCheckedAt).toBeNull();
    expect(row?.nextCheckAt.getTime()).toBeLessThanOrEqual(state.now.getTime());
  });

  it("other read failures back off and count as errors", async () => {
    const w = await watcher();
    state.details = { kind: "not_provided", reason: "http_status", status: 502 };
    const r = await tick();
    expect(r.errors).toBe(1);
    const row = await rowOf(w.userId);
    expect(row).toMatchObject({
      consecutiveErrors: 1,
      lastErrorCode: "fund_details_http_status_502",
    });
    expect(row?.nextCheckAt.getTime()).toBeGreaterThan(state.now.getTime());
  });

  it("switch off: regular users are not read, team users still are", async () => {
    const regular = await watcher();
    const team = await watcher({ role: "team" });
    await tick(false);
    expect(state.calls).toEqual([`details:${team.address}`, "plans"]);
    expect((await rowOf(regular.userId))?.baselinePending).toBe(true);
    expect((await rowOf(team.userId))?.baselinePending).toBe(false);
  });

  it("disconnected SoDEX account: the row is deleted, SoDEX is not read", async () => {
    const w = await watcher();
    await db
      .update(sodexAccounts)
      .set({ status: "disconnected" })
      .where(eq(sodexAccounts.id, w.accountId));
    const r = await tick();
    expect(r.removed).toBe(1);
    expect(await rowOf(w.userId)).toBeUndefined();
    expect(state.calls).toHaveLength(0);
  });
});
