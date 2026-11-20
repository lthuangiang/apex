import { randomUUID } from "node:crypto";

import { finishSignalExperiments, setSignalBotVersionStatus } from "@drift/db";
import {
  baselineVersionConfig,
  ErrorCode,
  errorResponseSchema,
  meSchema,
  NEWS_CLASSIFIER,
  researchVersionCreatedSchema,
  researchVersionsSchema,
  srMarketsSnapshot,
  type BotVersionConfig,
  type ResearchVersion,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Sổ thí nghiệm (#377): giả thuyết bắt buộc khi tạo version, diff so với Baseline CỐ ĐỊNH, ghép cặp với Baseline trên cùng
// câu chuyện + market, version đủ 100 cặp tự dừng (Finished) qua state machine có audit, Baseline không bao giờ bị dừng.
// API thật trên Postgres (testcontainers); lệnh giấy chèn thẳng như scheduler ghi.

let env: TestEnv;
let team: TestClient;
let baselineId: string;
const base = "/api/v1/admin/signal-research";
const CURRENT = NEWS_CLASSIFIER.promptVersion;
const cfg = baselineVersionConfig();
const HYP = "Trading only Medium and up gives a better result after fees.";

/** Đăng nhập một user team mới (phiên hết hạn khi đẩy đồng hồ đi xa). */
async function signInTeam() {
  team = new TestClient(env.app);
  const id = meSchema.parse((await signIn(env, team, `exp-${randomUUID()}@drift.test`)).json()).id;
  await env.pool.query("update users set role = 'team' where id = $1", [id]);
}

/** Đẩy đồng hồ test đi `days` ngày: version tạo sau đó không "chạy" trong lúc có lệnh của test trước. */
async function advance(days: number) {
  env.clock.now = new Date(env.clock.now.getTime() + days * 86_400_000);
  await signInTeam();
}

const post = (path: string, body: unknown) =>
  team.request("POST", `${base}${path}`, { body, idempotencyKey: randomUUID() });
const errOf = (r: { json: () => unknown }) => errorResponseSchema.parse(r.json()).error;
const list = async () => {
  const r = await team.request("GET", `${base}/versions`);
  expect(r.statusCode).toBe(200);
  return researchVersionsSchema.parse(r.json());
};
const item = async (id: string): Promise<ResearchVersion> => {
  const v = (await list()).items.find((x) => x.id === id);
  if (v === undefined) throw new Error(`version ${id} missing`);
  return v;
};

async function create(
  name: string,
  config: BotVersionConfig,
  opts: { start?: boolean; from?: string | null; hypothesis?: string } = {},
): Promise<ResearchVersion> {
  const r = await post("/versions", {
    name,
    config,
    start: opts.start ?? false,
    savedFromVersionId: opts.from ?? null,
    hypothesis: opts.hypothesis ?? HYP,
  });
  expect(r.statusCode).toBe(201);
  return researchVersionCreatedSchema.parse(r.json());
}

/**
 * `n` lệnh đã đóng của một version, câu chuyện `s-<tag>-<g>` (cùng tag = cùng bài với Baseline), mỗi 3 giờ một lệnh từ
 * `fromMin` phút sau đồng hồ test, kết quả `pct` %. `versionId` null = lệnh news-v3 trước khi có version (của Baseline).
 */
async function trades(
  versionId: string | null,
  tag: string,
  n: number,
  pct: string,
  fromMin = 60,
  startAt = 1,
) {
  await env.pool.query(
    `insert into signal_paper_trades (id, lane, label, version_id, story_id, article_id, market, token, catalyst, direction, size_usdc,
       qty, entry_price, entry_mid, spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price,
       max_hold_until, event_at, seen_at, opened_at, level_at_entry, sources_at_entry, outside_market_hours, price_source, status,
       exit_price, exit_reason, exited_at, exit_fee, result_usdc, result_pct, random_pct, rule_version, classifier_version)
     select gen_random_uuid(), 'news', 'live', $1, md5($2 || '-' || g)::uuid, 'a-' || $2 || '-' || g, 'ETH-USD', 'ETH',
       'etf_approved', 'long', 500, 0.15, 3400, 3400, 0.01, 0.05, 0.25, 1, 1.6, 0.8, 3454, 3372, t + interval '3 days', t, t, t,
       'medium', '[]', false, 'book', 'closed', 3450, 'take_profit', t + interval '30 minutes', 0.25, $3::numeric * 5, $3::numeric, 0,
       'news-v3', $4
     from (select g, $5::timestamptz + (g * interval '3 hours') as t from generate_series($7::int, $7::int + $6::int - 1) g) s`,
    [
      versionId,
      tag,
      pct,
      CURRENT,
      new Date(env.clock.now.getTime() + fromMin * 60_000).toISOString(),
      n,
      startAt,
    ],
  );
}

beforeAll(async () => {
  env = await startTestEnv();
  await signInTeam();
  env.srMarkets.value = JSON.stringify(
    srMarketsSnapshot(
      [
        { name: "BTC-USD", status: "TRADING", baseCoin: "BTC" },
        { name: "ETH-USD", status: "TRADING", baseCoin: "ETH" },
      ],
      env.clock.now,
    ),
  );
  const b = await env.pool.query<{ id: string }>(
    "select id from signal_bot_versions where is_baseline",
  );
  baselineId = b.rows[0]?.id ?? "";
  // Baseline seed (migration 0047) có created_at = lúc chạy migration (giờ thật), sau đồng hồ test: ghi khoảng chạy của nó
  // từ trước đồng hồ test, như trên prod (Baseline chạy từ lệnh news-v3 đầu tiên).
  await env.pool.query(
    `update signal_bot_versions set running_periods = '[{"from":"2026-01-01T00:00:00.000Z","to":null}]' where is_baseline`,
  );
});

afterAll(async () => {
  await env.close();
});

describe("experiments: hypothesis (#377)", () => {
  it("a new version needs a one-line hypothesis; it is saved and returned, Baseline has none", async () => {
    for (const hypothesis of [undefined, "", "   ", "Line one.\nLine two.", "x".repeat(201)]) {
      const r = await post("/versions", {
        name: "No hypothesis",
        config: cfg,
        start: false,
        ...(hypothesis === undefined ? {} : { hypothesis }),
      });
      expect(r.statusCode).toBe(400);
      const e = errOf(r);
      expect(e.code).toBe("VALIDATION_FAILED");
      expect(Object.keys((e.details as { fieldErrors: object }).fieldErrors)).toEqual([
        "hypothesis",
      ]);
    }
    const v = await create(
      "Has hypothesis",
      { ...cfg, minLevel: "medium" },
      { hypothesis: `  ${HYP}  ` },
    );
    expect(v.hypothesis).toBe(HYP);
    const audit = await env.pool.query<{ metadata: { hypothesis?: string } }>(
      "select metadata from audit_log where action = 'signal_research.version_created' and target = $1",
      [v.id],
    );
    expect(audit.rows[0]?.metadata.hypothesis).toBe(HYP);
    const baseline = await item(baselineId);
    expect(baseline.hypothesis).toBeNull();
    expect(baseline.experiment).toBeNull();
    // Giả thuyết bất biến (trigger DB), như config.
    await expect(
      env.pool.query("update signal_bot_versions set hypothesis = 'Other.' where id = $1", [v.id]),
    ).rejects.toThrow(/immutable/);
  });
});

describe("experiments: diff against the fixed Baseline (#377)", () => {
  it("compares with Baseline, not with the version it was copied from; more than one thing is not a clean test", async () => {
    const a = await create("Medium up", { ...cfg, minLevel: "medium" });
    expect(a.experiment).toMatchObject({
      control: { id: baselineId, number: 3 },
      changes: [{ field: "minLevel", from: "low", to: "medium" }],
      changedThings: 1,
      clean: true,
      verdict: "collecting",
      pairs: 0,
      needed: 100,
      meanDiffPct: null,
      finishedAt: null,
    });
    // Copy từ `a` (không phải Baseline) rồi đổi thêm SL: so với version cha chỉ khác SL, so với Baseline khác 2 thứ.
    const b = await create(
      "Medium up + wider SL",
      { ...cfg, minLevel: "medium", slMultiple: "1.0" },
      { from: a.id },
    );
    expect(b.changedFromPrevious).toEqual([{ field: "slMultiple", from: "0.75", to: "1.0" }]);
    expect(b.experiment?.changes?.map((c) => c.field)).toEqual(["minLevel", "slMultiple"]);
    expect(b.experiment?.changedThings).toBe(2);
    expect(b.experiment?.clean).toBe(false);
    expect(b.experiment?.control.id).toBe(baselineId);
    // Assets (chế độ + danh sách) là MỘT thứ.
    const c = await create("Majors", {
      ...cfg,
      assets: { mode: "only", markets: ["BTC-USD", "ETH-USD"], crypto: true, stocks: true },
    });
    expect(c.experiment?.changes?.map((x) => x.field)).toEqual(["assetMode", "assets"]);
    expect(c.experiment?.changedThings).toBe(1);
    expect(c.experiment?.clean).toBe(true);
    // Không đổi gì so với Baseline cũng không phải thí nghiệm sạch.
    const same = await create("Same as Baseline", cfg);
    expect(same.experiment?.changedThings).toBe(0);
    expect(same.experiment?.clean).toBe(false);
    // Không chặn: version "Not a clean test" vẫn được lưu.
    expect(b.status).toBe("paused");
  });
});

describe("experiments: paired with Baseline, Finished at 100 pairs (#377)", () => {
  it("pairs on the union of signals, waits for open trades, and stops the version at 100 closed pairs with an audit row", async () => {
    const v = await create("Strict subject", { ...cfg, tpMultiple: "1.2" }, { start: true });
    // 99 tín hiệu cả hai cùng vào (Baseline 1.0 %, thí nghiệm 1.5 %), lệnh thứ 99 của thí nghiệm còn mở; một tín hiệu chỉ
    // thí nghiệm vào (Baseline = 0).
    await trades(baselineId, "p1", 99, "1.0");
    await trades(v.id, "p1", 99, "1.5");
    await trades(v.id, "lonely", 1, "0.5", 61);
    await env.pool.query(
      `update signal_paper_trades set status = 'open', exit_price = null, exit_reason = null, exited_at = null, exit_fee = null,
         result_usdc = null, result_pct = null
       where version_id = $1 and article_id = 'a-p1-99'`,
      [v.id],
    );
    let e = (await item(v.id)).experiment;
    expect(e?.pairs).toBe(99);
    expect(e?.verdict).toBe("collecting");
    expect(e?.meanDiffPct).toBe("0.5");
    expect(await finishSignalExperiments(env.db, env.clock.now)).toEqual([]);
    expect((await item(v.id)).status).toBe("running");

    // Đóng lệnh còn mở (đủ 100 cặp); thêm một tín hiệu chỉ Baseline vào, đóng sau: cặp 101 không đổi kết quả.
    await env.pool.query(
      `update signal_paper_trades set status = 'closed', exit_price = 3450, exit_reason = 'take_profit',
         exited_at = opened_at + interval '30 minutes', exit_fee = 0.25, result_usdc = 7.5, result_pct = 1.5
       where version_id = $1 and article_id = 'a-p1-99'`,
      [v.id],
    );
    await trades(baselineId, "p1", 1, "-30", 60, 150);
    e = (await item(v.id)).experiment;
    expect(e?.pairs).toBe(100);
    expect(e?.verdict).toBe("better");

    const done = await finishSignalExperiments(env.db, env.clock.now);
    expect(done.map((d) => [d.id, d.result.verdict, d.result.pairs])).toEqual([
      [v.id, "better", 100],
    ]);
    const after = await item(v.id);
    expect(after.status).toBe("stopped");
    expect(after.experiment).toMatchObject({
      pairs: 100,
      verdict: "better",
      meanDiffPct: "0.5",
      ciLow: "0.5",
      ciHigh: "0.5",
      finishedAt: env.clock.now.toISOString(),
    });
    const audit = await env.pool.query<{
      user_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      "select user_id, metadata from audit_log where action = 'signal_research.version_status' and target = $1",
      [v.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.user_id).toBeNull();
    expect(audit.rows[0]?.metadata).toMatchObject({
      from: "running",
      to: "stopped",
      reason: "experiment_finished",
      result: { verdict: "better", pairs: 100 },
    });
    // Lần sau không làm gì; kết quả đã đóng băng (trigger DB).
    expect(await finishSignalExperiments(env.db, env.clock.now)).toEqual([]);
    await expect(
      env.pool.query("update signal_bot_versions set experiment_result = '{}' where id = $1", [
        v.id,
      ]),
    ).rejects.toThrow(/finished experiment is immutable/);
    // Thêm lệnh sau khi Finished: kết quả hiển thị vẫn là kết quả đóng băng.
    await trades(v.id, "p1", 1, "-50", 60, 200);
    await trades(baselineId, "p1", 1, "1.0", 60, 200);
    expect((await item(v.id)).experiment?.meanDiffPct).toBe("0.5");
    // Baseline vẫn chạy.
    expect((await item(baselineId)).status).toBe("running");
  });

  it("Worse when the whole range is below 0; old Baseline rows (version_id null) still pair", async () => {
    await advance(60);
    const v = await create("Tighter TP", { ...cfg, tpMultiple: "1.1" }, { start: true });
    await trades(null, "w1", 100, "1.0", 4_000);
    await trades(v.id, "w1", 100, "0.2", 4_000);
    const done = await finishSignalExperiments(env.db, env.clock.now);
    expect(done.map((d) => [d.id, d.result.verdict])).toEqual([[v.id, "worse"]]);
    const after = await item(v.id);
    expect(after.status).toBe("stopped");
    expect(after.experiment?.meanDiffPct).toBe("-0.8");
  });

  it("a filtering version that skips Baseline's losing trades is Better; a trade blocked by a limit counts 0", async () => {
    await advance(60);
    const v = await create("High only", { ...cfg, minLevel: "high" }, { start: true });
    // Baseline vào 100 tín hiệu: 50 lời 1 %, rồi 50 lỗ 1 %. Version chỉ vào 50 lệnh lời; 10 tín hiệu lỗ bị giới hạn chặn
    // (chỉ có lệnh shadow, kết quả giả định 5 % không bao giờ tính).
    await trades(baselineId, "f", 50, "1", 20_000);
    await trades(baselineId, "f", 50, "-1", 20_000, 51);
    await trades(v.id, "f", 50, "1", 20_000);
    await trades(v.id, "f", 10, "5", 20_000, 51);
    await env.pool.query(
      `update signal_paper_trades set label = 'shadow', shadow_reason = 'LIMIT_OPEN'
       where version_id = $1 and result_pct = 5`,
      [v.id],
    );
    const e = (await item(v.id)).experiment;
    expect(e).toMatchObject({
      pairs: 100,
      meanDiffPct: "0.5",
      verdict: "better",
      changedThings: 1,
    });
    const done = await finishSignalExperiments(env.db, env.clock.now);
    expect(done.map((d) => [d.id, d.result.verdict])).toEqual([[v.id, "better"]]);
  });

  it("counts only while Baseline runs too: experiment trades while Baseline was paused are left out", async () => {
    await advance(60);
    const v = await create(
      "Skip late news",
      { ...cfg, maxSourceDelayMinutes: 10 },
      { start: true },
    );
    // Baseline (cột running_periods trong DB) tạm dừng trong ngày 2–3 sau khi version được lưu.
    const day = 86_400_000;
    const t0 = env.clock.now.getTime();
    await env.pool.query("update signal_bot_versions set running_periods = $1 where is_baseline", [
      JSON.stringify([
        { from: "2026-01-01T00:00:00.000Z", to: new Date(t0 + day).toISOString() },
        { from: new Date(t0 + 3 * day).toISOString(), to: null },
      ]),
    ]);
    try {
      // 8 lệnh mỗi ngày từ lúc lưu: 8 lệnh ngày 1 tính, 16 lệnh ngày 2–3 (Baseline tạm dừng) không tính, 8 lệnh ngày 4 tính.
      await trades(v.id, "bp", 32, "1", 0, 0);
      const e = (await item(v.id)).experiment;
      expect(e?.pairs).toBe(16);
      expect(e?.meanDiffPct).toBe("1");
    } finally {
      await env.pool.query(
        `update signal_bot_versions set running_periods = '[{"from":"2026-01-01T00:00:00.000Z","to":null}]' where is_baseline`,
      );
      // Nhường chỗ chạy (tối đa 3) cho test sau.
      await setSignalBotVersionStatus(env.db, { id: v.id, status: "stopped", userId: null });
    }
  });

  it("a version saved before #377 (no hypothesis) is never stopped automatically", async () => {
    await advance(60);
    const id = randomUUID();
    await env.pool.query(
      `insert into signal_bot_versions (id, number, name, config, status, created_at, updated_at, status_changed_at)
       values ($1, 90, 'Old version', $2, 'running', $3, $3, $3)`,
      [id, JSON.stringify({ ...cfg, slMultiple: "0.9" }), env.clock.now.toISOString()],
    );
    await trades(baselineId, "old", 100, "1.0", 8_000);
    await trades(id, "old", 100, "2.0", 8_000);
    expect(await finishSignalExperiments(env.db, env.clock.now)).toEqual([]);
    const v = await item(id);
    expect(v.status).toBe("running");
    expect(v.hypothesis).toBeNull();
    // Kết quả vẫn được tính để xem, chỉ không tự dừng.
    expect(v.experiment?.verdict).toBe("better");
    expect(v.experiment?.finishedAt).toBeNull();
  });
});

describe("experiments: Baseline is never stopped (#377)", () => {
  it("the state machine refuses to finish Baseline and the DB refuses an experiment result on it", async () => {
    await expect(
      setSignalBotVersionStatus(env.db, {
        id: baselineId,
        status: "stopped",
        userId: null,
        finish: {
          pairs: 100,
          needed: 100,
          meanDiffPct: "0",
          ciLow: "0",
          ciHigh: "0",
          clusters: 2,
          verdict: "no_clear_difference",
        },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.stateConflict });
    await expect(
      env.pool.query("update signal_bot_versions set experiment_result = '{}' where id = $1", [
        baselineId,
      ]),
    ).rejects.toThrow(/baseline is never an experiment/);
    expect(await finishSignalExperiments(env.db, env.clock.now)).toEqual([]);
    const b = await item(baselineId);
    expect(b.status).toBe("running");
    expect(b.experiment).toBeNull();
  });
});
