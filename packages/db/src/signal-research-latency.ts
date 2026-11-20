import {
  NEWS_RULES,
  RESEARCH_LATENCY_STAGES,
  type ResearchLatency,
  type ResearchLatencyQuery,
  type ResearchLatencyStageKey,
} from "@drift/shared";
import { sql, type SQL } from "drizzle-orm";

import type { Db } from "./client";
import type { DbTx } from "./read-only";
import { rangeSince } from "./signal-research-articles";
import { resolveSignalVersion, versionEventSql } from "./signal-research-versions";

// Độ trễ theo chặng của lane tin tức (#375, DEC-TBD-catalyst-p0 mục 4). Chỉ đọc; nơi gọi bọc transaction chỉ đọc.
//
// Mốc và nguồn giờ:
// - published = `release_time` của SoSoValue (đồng hồ nguồn); collected = giờ bắt đầu chu kỳ của scheduler.
// - Claude done = `claude_done_at`; decided = `decided_clock_at` (event Filter / Decide, hoặc của lệnh); opened =
//   `opened_clock_at` của lệnh. Ba mốc này cùng một đồng hồ: `deps.now()` của scheduler đọc lại ngay lúc đó (Date.now trên
//   cùng tiến trình). KHÔNG dùng `classified_at`, `signal_events.at` hay `opened_at`: các cột đó là giờ bắt đầu chu kỳ,
//   giống nhau trong cả chu kỳ, nên chặng giữa chúng luôn bằng 0.
// - Chặng nguồn gốc → SoSoValue không có nguồn (SoSoValue không trả giờ gốc): luôn null.
// Không đủ hai mốc thì bài không vào chặng đó; không bài nào thì median null (không bao giờ 0).

type Q = Db | DbTx;

interface Row extends Record<string, unknown> {
  median: string | number | null;
  n: string | number;
}

const ms = (v: string | number | null): number | null =>
  v === null ? null : Math.max(0, Math.round(Number(v)));

export async function loadSignalResearchLatency(
  q: Q,
  query: ResearchLatencyQuery,
  now: Date,
  check: () => void = () => undefined,
): Promise<ResearchLatency> {
  const scope = await resolveSignalVersion(q, query.versionId);
  check();
  const since = rangeSince(now, query.range);
  const v = NEWS_RULES.version;
  // Bài trong cửa sổ (theo giờ DeskLabs thu bài, cùng mốc với phễu), không gồm bài backlog.
  const articles = sql`select a.id, a.published_at, a.collected_at, a.claude_done_at from signal_articles a
    where a.rule_version = ${v} and a.status <> 'backlog' and a.collected_at >= ${since}`;
  const median = (expr: SQL) =>
    sql`percentile_cont(0.5) within group (order by ${expr}) as median, count(*) as n`;
  // Giờ nguồn có thể lệch nhẹ (bài "đăng" sau lúc thu): kẹp từng bài ở 0, không để số âm kéo median.
  const epochMs = (to: SQL, from: SQL) =>
    sql`greatest(0, extract(epoch from (${to} - ${from})) * 1000)`;
  const versionTrades =
    scope === null
      ? sql`true`
      : scope.isBaseline
        ? sql`(t.version_id = ${scope.id} or t.version_id is null)`
        : sql`t.version_id = ${scope.id}`;

  const one = async (stmt: SQL) => {
    const r = await q.execute<Row>(stmt);
    check();
    const row = r.rows[0];
    const n = Number(row?.n ?? 0);
    return { medianMs: n === 0 ? null : ms(row?.median ?? null), n };
  };

  const publishedToCollected = await one(sql`with a as (${articles})
    select ${median(epochMs(sql`a.collected_at`, sql`a.published_at`))} from a`);
  const collectedToClaudeDone = await one(sql`with a as (${articles})
    select ${median(epochMs(sql`a.claude_done_at`, sql`a.collected_at`))} from a
    where a.claude_done_at is not null`);
  // Decided của một bài = lần quyết định Filter / Decide đầu tiên của version cho bài đó.
  const claudeDoneToDecided = await one(sql`with a as (${articles}),
    d as (
      select e.article_id, min(e.decided_clock_at) as decided from signal_events e
      join a on a.id = e.article_id
      where e.stage in ('filter', 'decide') and e.decided_clock_at is not null and e.rule_version = ${v}
        and ${versionEventSql(scope, "e")}
      group by e.article_id
    )
    select ${median(epochMs(sql`d.decided`, sql`a.claude_done_at`))} from a join d on d.article_id = a.id
    where a.claude_done_at is not null`);
  // Lệnh paper thật (không gồm shadow) của version, có đủ hai mốc đồng hồ.
  const decidedToOpened = await one(sql`with a as (${articles})
    select ${median(epochMs(sql`t.opened_clock_at`, sql`t.decided_clock_at`))} from signal_paper_trades t
    join a on a.id = t.article_id
    where t.label = 'live' and t.decided_clock_at is not null and t.opened_clock_at is not null
      and ${versionTrades}`);

  const by: Record<ResearchLatencyStageKey, { medianMs: number | null; n: number | null }> = {
    sourceToSoso: { medianMs: null, n: null },
    publishedToCollected,
    collectedToClaudeDone,
    claudeDoneToDecided,
    decidedToOpened,
  };
  return {
    range: query.range,
    computedAt: now.toISOString(),
    stages: RESEARCH_LATENCY_STAGES.map((key) => ({ key, ...by[key] })),
  };
}
