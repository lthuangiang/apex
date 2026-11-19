import type { Db } from "@drift/db";
import {
  ContextSource,
  NEWS_RULES,
  SIGNAL_CATALYSTS,
  SignalOutcome,
  SignalStage,
  storyKey,
  storyStartOf,
  storyTooOld,
  TradeDirection,
  type SignalCatalyst,
} from "@drift/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { computeSignalContext, insertSignalContext } from "./context";
import { priceBefore } from "./store";

// Backfill ngữ cảnh cho tín hiệu tin cũ (#333, thay #274; thuộc #329). Tín hiệu = bài qua Understand (event `understand` /
// `pass`), kể cả bài sau đó bị loại ở Filter hay thành shadow. Thời điểm quyết định = giờ của event đó (bước 4 live chạy cùng
// chu kỳ, cùng `now`). Chỉ đọc DB của DeskLabs; không gọi SoDEX, Hyperliquid hay dịch vụ ngoài nào.
// Quy tắc (DEC-342):
// - Không nhìn trước: chỉ dữ liệu có timestamp < thời điểm quyết định (funding_time, nến 1 phút đã đóng, story có trước đó
//   và nguồn của story đã qua Understand trước đó).
// - Snapshot gắn `source = backfilled`, tách khỏi `live`; một dòng mỗi bài, insert-or-nothing: không bao giờ ghi đè snapshot
//   live (hay backfilled) đã có. Trigger DB chặn UPDATE.
// - H1 luôn `na` (số H1 null, không phải 0): tập ví theo dõi lúc đó cần lần poll thành công trong 60 phút trước quyết định
//   (`leader_wallets.last_polled_at` chỉ giữ lần mới nhất, không có lịch sử) và follow lúc đó (unfollow xoá dòng), nên không
//   tái dựng trung thực được. Xem `H1_BACKFILL_NA_REASON`.
// - H2 / H3 thiếu dữ liệu quá khứ → `na` (cùng hàm thuần với live). Giá lúc quyết định của H3 = giá đóng nến 1 phút cuối đã
//   đóng trước quyết định (báo giá live không được lưu), không phải giá giữa của báo giá như snapshot live.

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** Lý do H1 = `na` trên mọi snapshot backfilled (log + tài liệu; không có cột riêng). */
export const H1_BACKFILL_NA_REASON =
  "tracked-wallet poll and follow state at the decision time is not stored, so H1 cannot be rebuilt honestly";

export interface BackfillOptions {
  /** Chỉ bài quyết định trước `now − minAgeMs` (bước 4 live chạy cùng chu kỳ; chừa biên để không tranh với live). */
  minAgeMs: number;
  /** Số bài tối đa mỗi lượt. */
  maxPerRun: number;
  /** Số bài mỗi lần đọc danh sách. */
  batchSize: number;
  /** Nghỉ giữa hai bài (giới hạn tốc độ đọc DB). */
  pauseMs: number;
}

export const BACKFILL_DEFAULTS: BackfillOptions = {
  minAgeMs: HOUR_MS,
  maxPerRun: 2_000,
  batchSize: 100,
  pauseMs: 50,
};

export interface BackfillLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface BackfillReport {
  /** Bài đã xét trong lượt. */
  scanned: number;
  /** Snapshot backfilled mới đã ghi. */
  written: number;
  /** Bài đã có snapshot lúc ghi (live vừa chụp, hoặc lượt khác): giữ nguyên. */
  kept: number;
  /** Event Understand không đọc được (thiếu market / chiều / catalyst không có trong quy tắc): bỏ qua, không đoán. */
  invalid: number;
  failed: number;
  /** Còn bài chờ (chạm `maxPerRun`). */
  more: boolean;
}

const detailSchema = z.object({
  market: z.string().min(1),
  catalyst: z.enum(SIGNAL_CATALYSTS as [SignalCatalyst, ...SignalCatalyst[]]),
  direction: z.enum([TradeDirection.long, TradeDirection.short]),
});

interface CandidateRow {
  article_id: string;
  at: Date | string;
  rule_version: string;
  detail: unknown;
  group_first_at: Date | string;
}

const toMs = (v: Date | string) => (v instanceof Date ? v.getTime() : Date.parse(v));

/**
 * Tín hiệu chưa có snapshot, quyết định trước `before`, cũ nhất trước. `group_first_at` = giờ đăng sớm nhất của các tín hiệu
 * cùng chu kỳ (cùng giờ event) cùng story key: bài đầu nhóm như `group[0]` của bước 4 live (bài pending theo giờ đăng).
 */
async function candidates(db: Db, before: number, limit: number): Promise<CandidateRow[]> {
  const r = await db.execute<CandidateRow & Record<string, unknown>>(sql`
    with passes as (
      select distinct on (e.article_id) e.article_id, e.at, e.rule_version, e.detail
        from signal_events e
       where e.stage = ${SignalStage.understand} and e.outcome = ${SignalOutcome.pass}
         and e.article_id is not null
       order by e.article_id, e.at, e.id),
    cyc as (
      select p.*, min(a.published_at) over (
               partition by p.at, p.detail->>'market', p.detail->>'catalyst') as group_first_at
        from passes p join signal_articles a on a.id = p.article_id)
    select article_id, at, rule_version, detail, group_first_at
      from cyc
     where at < ${new Date(before)}
       and not exists (select 1 from signal_contexts c where c.article_id = cyc.article_id)
     order by at, article_id
     limit ${limit}`);
  return r.rows;
}

/**
 * Giờ đăng các nguồn của lần thử trước (story chưa khoá) cùng key, như `earlierAttempts(db, null, …)` của bước 4 live nhưng
 * chỉ thấy thứ đã có trước `t`: story có `first_seen_at` < t (khoá chỉ đổi trong chính chu kỳ tạo story, nên trạng thái khoá
 * hiện tại = lúc đó), và chỉ nguồn đã qua Understand trước `t` (nguồn gộp vào sau đó bị bỏ).
 */
async function earlierSourcesAt(
  db: Db,
  key: string,
  ruleVersion: string,
  t: number,
): Promise<number[]> {
  const r = await db.execute<{ at: string | null }>(sql`
    select src->>'at' as at
      from signal_stories st
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(st.sources) = 'array' then st.sources else '[]'::jsonb end) src
     where st.story_key = ${key} and st.rule_version = ${ruleVersion} and st.locked = false
       and st.first_seen_at >= ${new Date(t - NEWS_RULES.storyWindowDays * DAY_MS)}
       and st.first_seen_at < ${new Date(t)}
       and exists (
         select 1 from signal_events e
          where e.article_id = src->>'articleId' and e.stage = ${SignalStage.understand}
            and e.outcome = ${SignalOutcome.pass} and e.at < ${new Date(t)})`);
  return r.rows.flatMap((x) => {
    const ms = x.at === null ? Number.NaN : Date.parse(x.at);
    return Number.isNaN(ms) ? [] : [ms];
  });
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Một lượt backfill: idempotent (bài đã có snapshot không được chọn lại; ghi là insert-or-nothing), dừng ở `maxPerRun`. Lỗi
 * của một bài chỉ ghi log rồi sang bài sau; lượt sau thử lại bài đó.
 */
export async function runContextBackfill(deps: {
  db: Db;
  log: BackfillLogger;
  now: () => number;
  options?: Partial<BackfillOptions>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<BackfillReport> {
  const o = { ...BACKFILL_DEFAULTS, ...deps.options };
  const sleep = deps.sleep ?? sleepMs;
  const before = deps.now() - o.minAgeMs;
  const report: BackfillReport = {
    scanned: 0,
    written: 0,
    kept: 0,
    invalid: 0,
    failed: 0,
    more: false,
  };
  // Bài lỗi / không đọc được trong lượt này: không chọn lại trong cùng lượt.
  const skip = new Set<string>();
  while (report.scanned < o.maxPerRun) {
    const rows = (await candidates(deps.db, before, o.batchSize + skip.size)).filter(
      (r) => !skip.has(r.article_id),
    );
    if (rows.length === 0) break;
    for (const row of rows.slice(0, o.batchSize)) {
      if (report.scanned >= o.maxPerRun) break;
      report.scanned += 1;
      const p = detailSchema.safeParse(row.detail);
      if (!p.success) {
        report.invalid += 1;
        skip.add(row.article_id);
        deps.log.warn(
          { articleId: row.article_id },
          "signal context backfill: understand event without market / direction, skipped",
        );
        continue;
      }
      try {
        const t = toMs(row.at);
        const key = storyKey(p.data.market, p.data.catalyst);
        const first = toMs(row.group_first_at);
        // Cùng quy tắc với `contextStoryStart` của bước 4 live.
        const s = storyStartOf(await earlierSourcesAt(deps.db, key, row.rule_version, t), first);
        const storyStartAt = s.retry && storyTooOld(s.start, t) ? first : s.start;
        const values = await computeSignalContext(
          deps.db,
          {
            articleId: row.article_id,
            market: p.data.market,
            direction: p.data.direction,
            storyStartAt,
          },
          t,
          await priceBefore(deps.db, p.data.market, t),
          { source: ContextSource.backfilled, ruleVersion: row.rule_version, whales: false },
        );
        if (await insertSignalContext(deps.db, values)) report.written += 1;
        else {
          report.kept += 1;
          skip.add(row.article_id);
        }
      } catch (e) {
        report.failed += 1;
        skip.add(row.article_id);
        deps.log.warn(
          { articleId: row.article_id, error: e instanceof Error ? e.message : "error" },
          "signal context backfill: article failed",
        );
      }
      if (o.pauseMs > 0) await sleep(o.pauseMs);
    }
  }
  if (report.scanned >= o.maxPerRun)
    report.more = (await candidates(deps.db, before, skip.size + 1)).some(
      (r) => !skip.has(r.article_id),
    );
  deps.log.info(
    { ...report, h1: "na", h1Reason: H1_BACKFILL_NA_REASON },
    "signal context backfill done",
  );
  return report;
}
