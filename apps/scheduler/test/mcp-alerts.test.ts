import { createDb, runMigrations, type Db } from "@drift/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { checkMcpAlerts, type AlertStore } from "../src/mcp-alerts";

// Theo dõi MCP (DEC-TBD-mcp-monitoring): lỗi tool ≥ 20 lượt và ≥ 20% trong 5 phút; introspect lỗi ≥ 10 lần trong 5 phút
// (bộ đếm Redis theo phút); user chạm giới hạn ngày trong 30 phút. Mỗi loại tối đa 1 tin / 30 phút. Không token / client id.

const NOW = Date.parse("2026-11-13T10:05:30Z");
const MIN = 60_000;

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];

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
  await pool.query("delete from mcp_calls; delete from outbox where topic = 'jobs.team_ops'");
});

/** Redis giả: bộ đếm theo khoá và khoá chặn lặp (bỏ qua hết hạn; test dùng store mới khi cần). */
function memStore(counts: Record<string, number> = {}): AlertStore & { claimed: string[] } {
  const claimed: string[] = [];
  return {
    claimed,
    sum: (keys) => Promise.resolve(keys.reduce((n, k) => n + (counts[k] ?? 0), 0)),
    claim: (key) => {
      if (claimed.includes(key)) return Promise.resolve(false);
      claimed.push(key);
      return Promise.resolve(true);
    },
  };
}

async function calls(n: number, status: string, tool: string, agoMs: number, userId?: string) {
  for (let i = 0; i < n; i++)
    await pool.query(
      "insert into mcp_calls (id, token_id, user_id, client_id, endpoint, tool, status, created_at) values (gen_random_uuid(), gen_random_uuid(), $1, 'dlc_secret_client', 'user', $2, $3, $4)",
      [userId ?? null, tool, status, new Date(NOW - agoMs)],
    );
}

const queued = async () =>
  (
    await pool.query<{ payload: Record<string, unknown> }>(
      "select payload from outbox where topic = 'jobs.team_ops' order by created_at",
    )
  ).rows.map((r) => r.payload);

describe("MCP alerts", () => {
  it("alerts on tool errors only with enough calls and a high enough rate, once per 30 minutes", async () => {
    // 19 lượt, 10 lỗi: chưa đủ lượt.
    await calls(9, "ok", "list_bots", MIN);
    await calls(10, "error", "get_bot", MIN);
    expect(await checkMcpAlerts(db, memStore(), NOW)).toEqual([]);
    // 25 lượt, 5 lỗi = 20%: báo. Lượt cũ hơn 5 phút và denied / rate_limited không tính.
    await calls(6, "ok", "list_bots", MIN);
    await calls(50, "error", "get_bot", 6 * MIN);
    await calls(30, "denied", "-", MIN);
    await pool.query("delete from mcp_calls where status = 'error' and created_at > $1", [
      new Date(NOW - 5 * MIN),
    ]);
    await calls(5, "error", "get_bot", MIN);
    await calls(5, "ok", "get_bot", MIN);
    const store = memStore();
    expect(await checkMcpAlerts(db, store, NOW)).toEqual(["team_mcp_tool_errors"]);
    expect(await queued()).toEqual([
      { type: "team_mcp_tool_errors", calls: 25, errors: 5, pct: "20", tool: "get_bot" },
    ]);
    // Lần sau trong 30 phút: không gửi lại.
    expect(await checkMcpAlerts(db, store, NOW + MIN)).toEqual([]);
  });

  it("alerts when introspect keeps failing (Redis per-minute counters over 5 minutes)", async () => {
    const m = Math.floor(NOW / MIN);
    const few = memStore({ [`mcp:introspect_fail:${String(m)}`]: 9 });
    expect(await checkMcpAlerts(db, few, NOW)).toEqual([]);
    const many = memStore({
      [`mcp:introspect_fail:${String(m)}`]: 4,
      [`mcp:introspect_fail:${String(m - 4)}`]: 6,
      // Ngoài cửa sổ 5 phút.
      [`mcp:introspect_fail:${String(m - 5)}`]: 100,
    });
    expect(await checkMcpAlerts(db, many, NOW)).toEqual(["team_mcp_introspect_failing"]);
    expect(await queued()).toEqual([{ type: "team_mcp_introspect_failing", failures: 10 }]);
  });

  it("alerts when users hit the daily limit, never with token or client ids", async () => {
    const u = (
      await pool.query<{ id: string }>(
        "insert into users (id, email) values (gen_random_uuid(), 'heavy@example.test') returning id",
      )
    ).rows[0]?.id;
    await calls(3, "rate_limited", "limit:per_day", 10 * MIN, u);
    await calls(5, "rate_limited", "limit:per_minute", MIN, u);
    await calls(1, "rate_limited", "limit:per_day", 40 * MIN, u);
    expect(await checkMcpAlerts(db, memStore(), NOW)).toEqual(["team_mcp_daily_limit"]);
    const [p] = await queued();
    expect(p).toEqual({ type: "team_mcp_daily_limit", userIds: [u] });
    expect(JSON.stringify(p)).not.toContain("dlc_secret_client");
  });

  it("only per-minute limits do not alert", async () => {
    await calls(5, "rate_limited", "limit:per_minute", MIN);
    expect(await checkMcpAlerts(db, memStore(), NOW)).toEqual([]);
  });
});
