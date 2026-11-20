import {
  candles1m,
  mmMarketHourly,
  signalEvents,
  signalResearchUsage,
  signalSourceHealth,
  signalStories,
  type Db,
} from "@drift/db";
import {
  movedPct,
  NEWS_RULES,
  typicalMovePct,
  type Decimal,
  type DecimalInput,
  type SignalOutcome,
  type SignalReason,
  type SignalSourceKey,
  type SignalStage,
} from "@drift/shared";
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";

import type { ClaudeUsage } from "./classifier";

// Truy vấn DB của lane tin tức (#271). Chỉ đọc candles_1m / mm_market_hourly (marketdata ghi); ghi các bảng signal_*.

type Exec = Pick<Db, "insert" | "select" | "update" | "execute">;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface EventInput {
  articleId?: string | null;
  storyId?: string | null;
  tradeId?: string | null;
  /** News bot version (#303): chỉ event Filter / Decide / Watch. */
  versionId?: string | null;
  stage: SignalStage;
  outcome: SignalOutcome;
  reason?: SignalReason | null;
  detail?: Record<string, unknown> | null;
  at: number;
  /** #375: giờ đồng hồ thật lúc quyết định (chỉ event Filter / Decide); `at` là giờ bắt đầu chu kỳ. */
  decidedClockAt?: number | null;
}

export async function recordEvents(db: Exec, events: readonly EventInput[]): Promise<void> {
  if (events.length === 0) return;
  await db.insert(signalEvents).values(
    events.map((e) => ({
      articleId: e.articleId ?? null,
      storyId: e.storyId ?? null,
      tradeId: e.tradeId ?? null,
      versionId: e.versionId ?? null,
      stage: e.stage,
      outcome: e.outcome,
      reason: e.reason ?? null,
      detail: e.detail ?? null,
      ruleVersion: NEWS_RULES.version,
      at: new Date(e.at),
      decidedClockAt: e.decidedClockAt == null ? null : new Date(e.decidedClockAt),
    })),
  );
}

// ── Hạn mức ───────────────────────────────────────────────────────────────────────────────────────────────────────

export async function addSosoRequests(db: Exec, now: number, n: number): Promise<void> {
  await db
    .insert(signalResearchUsage)
    .values({ day: utcDay(now), sosoRequests: n })
    .onConflictDoUpdate({
      target: signalResearchUsage.day,
      set: {
        sosoRequests: sql`${signalResearchUsage.sosoRequests} + ${n}`,
        updatedAt: new Date(now),
      },
    });
}

export async function addClaudeUsage(db: Exec, now: number, u: ClaudeUsage): Promise<void> {
  if (u.calls === 0) return;
  await db
    .insert(signalResearchUsage)
    .values({
      day: utcDay(now),
      claudeCalls: u.calls,
      claudeInputTokens: u.input,
      claudeCacheWriteTokens: u.cacheWrite,
      claudeCacheReadTokens: u.cacheRead,
      claudeOutputTokens: u.output,
    })
    .onConflictDoUpdate({
      target: signalResearchUsage.day,
      set: {
        claudeCalls: sql`${signalResearchUsage.claudeCalls} + ${u.calls}`,
        claudeInputTokens: sql`${signalResearchUsage.claudeInputTokens} + ${u.input}`,
        claudeCacheWriteTokens: sql`${signalResearchUsage.claudeCacheWriteTokens} + ${u.cacheWrite}`,
        claudeCacheReadTokens: sql`${signalResearchUsage.claudeCacheReadTokens} + ${u.cacheRead}`,
        claudeOutputTokens: sql`${signalResearchUsage.claudeOutputTokens} + ${u.output}`,
        updatedAt: new Date(now),
      },
    });
}

export async function usageToday(db: Exec, now: number): Promise<ClaudeUsage & { soso: number }> {
  const [r] = await db
    .select()
    .from(signalResearchUsage)
    .where(eq(signalResearchUsage.day, utcDay(now)));
  return {
    soso: r?.sosoRequests ?? 0,
    calls: r?.claudeCalls ?? 0,
    input: r?.claudeInputTokens ?? 0,
    cacheWrite: r?.claudeCacheWriteTokens ?? 0,
    cacheRead: r?.claudeCacheReadTokens ?? 0,
    output: r?.claudeOutputTokens ?? 0,
  };
}

export async function sosoRequestsThisMonth(db: Exec, now: number): Promise<number> {
  const [r] = await db
    .select({ n: sql<string | null>`sum(${signalResearchUsage.sosoRequests})` })
    .from(signalResearchUsage)
    .where(gte(signalResearchUsage.day, `${utcDay(now).slice(0, 7)}-01`));
  return Number(r?.n ?? 0);
}

// ── Sức khoẻ nguồn và watermark ──────────────────────────────────────────────────────────────────────────────────

export async function markSource(
  db: Exec,
  source: SignalSourceKey,
  now: number,
  error: string | null,
): Promise<void> {
  const at = new Date(now);
  const set =
    error === null
      ? { lastOkAt: at, updatedAt: at }
      : { lastErrorAt: at, lastError: error.slice(0, 120), updatedAt: at };
  await db
    .insert(signalSourceHealth)
    .values({ source, ...set })
    .onConflictDoUpdate({ target: signalSourceHealth.source, set });
}

export async function newsState(
  db: Exec,
): Promise<{ watermarkAt: number | null; lastCycleAt: number | null }> {
  const [r] = await db
    .select({ w: signalSourceHealth.watermarkAt, c: signalSourceHealth.lastCycleAt })
    .from(signalSourceHealth)
    .where(eq(signalSourceHealth.source, "sosovalue"));
  return { watermarkAt: r?.w?.getTime() ?? null, lastCycleAt: r?.c?.getTime() ?? null };
}

export async function saveNewsState(db: Exec, watermarkAt: number, now: number): Promise<void> {
  const set = {
    watermarkAt: new Date(watermarkAt),
    lastCycleAt: new Date(now),
    updatedAt: new Date(now),
  };
  await db
    .insert(signalSourceHealth)
    .values({ source: "sosovalue", ...set })
    .onConflictDoUpdate({ target: signalSourceHealth.source, set });
}

// ── Giá (chỉ dữ liệu marketdata đã lưu) ──────────────────────────────────────────────────────────────────────────

export async function spreadHists(
  db: Exec,
  markets: readonly string[],
  since: number,
): Promise<Map<string, Record<string, number>[]>> {
  const out = new Map<string, Record<string, number>[]>();
  if (markets.length === 0) return out;
  const rows = await db
    .select({ market: mmMarketHourly.market, ticks: mmMarketHourly.spreadTicks })
    .from(mmMarketHourly)
    .where(
      and(inArray(mmMarketHourly.market, [...markets]), gte(mmMarketHourly.hour, new Date(since))),
    );
  for (const r of rows) {
    if (r.ticks === null || typeof r.ticks !== "object" || Array.isArray(r.ticks)) continue;
    const h: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.ticks)) if (typeof v === "number") h[k] = v;
    out.set(r.market, [...(out.get(r.market) ?? []), h]);
  }
  return out;
}

/** Giá đóng của nến 1 phút cuối cùng đã xong trước `at` (tìm lùi tối đa 10 phút); không có → null. */
export async function priceBefore(db: Exec, market: string, at: number): Promise<string | null> {
  const end = Math.floor(at / 60_000) * 60_000 - 60_000;
  const [r] = await db
    .select({ close: candles1m.close })
    .from(candles1m)
    .where(
      and(
        eq(candles1m.market, market),
        lte(candles1m.ts, new Date(end)),
        gte(candles1m.ts, new Date(end - 10 * 60_000)),
      ),
    )
    .orderBy(desc(candles1m.ts))
    .limit(1);
  return r?.close ?? null;
}

/**
 * `moved_before_entry` (#312): giá đã chạy (%) từ nến đóng trước giờ bắt đầu story tới giá giữa lúc vào. Decide (giá trị lưu
 * trên lệnh) và H3 của bước 4 · Context gọi cùng hàm này với cùng mốc, nên là MỘT con số (review PR #349).
 */
export async function movedBeforeEntry(
  db: Exec,
  market: string,
  storyStart: number,
  entryMid: DecimalInput,
): Promise<Decimal | null> {
  const before = await priceBefore(db, market, storyStart);
  return before === null ? null : movedPct(before, entryMid);
}

export const storySources = z.array(
  z.object({
    name: z.string(),
    tier: z.enum(["top", "mid", "low"]),
    articleId: z.string(),
    at: z.string(),
  }),
);
export type StorySourceRef = z.infer<typeof storySources>[number];

/** Mốc dưới của cửa sổ story 7 ngày (theo `first_seen_at`). */
export const storyWindowStart = (now: number) =>
  new Date(now - NEWS_RULES.storyWindowDays * DAY_MS);

/**
 * Các lần thử trước (không khoá, chưa vào lệnh) cùng key trong 7 ngày, cũ nhất trước. `versionId` = của một version (Decide);
 * null = của mọi version (bước 4 · Context, chạy trước Filter và không theo version).
 */
export async function earlierAttempts(
  db: Exec,
  versionId: string | null,
  key: string,
  now: number,
) {
  const rows = await db
    .select({ id: signalStories.id, sources: signalStories.sources })
    .from(signalStories)
    .where(
      and(
        versionId === null ? undefined : eq(signalStories.versionId, versionId),
        eq(signalStories.storyKey, key),
        eq(signalStories.ruleVersion, NEWS_RULES.version),
        eq(signalStories.locked, false),
        gte(signalStories.firstSeenAt, storyWindowStart(now)),
      ),
    )
    .orderBy(asc(signalStories.firstSeenAt));
  return rows.map((r) => {
    const p = storySources.safeParse(r.sources);
    return { id: r.id, sources: p.success ? p.data : [] };
  });
}

const moveCache = new Map<string, { at: number; v: Decimal | null }>();

/** Biến động thường gặp (%) trong `holdHours`, từ giá đóng mỗi giờ của 30 ngày nến 1 phút; cache 1 giờ. */
export async function typicalMove(
  db: Exec,
  market: string,
  holdHours: number,
  now: number,
): Promise<Decimal | null> {
  const key = `${market}|${String(holdHours)}`;
  const hit = moveCache.get(key);
  if (hit !== undefined && now - hit.at < HOUR_MS) return hit.v;
  const since = new Date(now - NEWS_RULES.volatilityLookbackDays * DAY_MS);
  const hour = sql<Date>`date_trunc('hour', ${candles1m.ts})`;
  const rows = await db.execute<{ hour: Date | string; close: string }>(sql`
    select distinct on (date_trunc('hour', ${candles1m.ts})) ${hour} as hour, ${candles1m.close} as close
    from ${candles1m}
    where ${candles1m.market} = ${market} and ${candles1m.ts} >= ${since}
    order by date_trunc('hour', ${candles1m.ts}), ${candles1m.ts} desc`);
  const closes = rows.rows.map((r) => ({ hour: new Date(r.hour).getTime(), close: r.close }));
  const v = typicalMovePct(closes, holdHours);
  moveCache.set(key, { at: now, v });
  return v;
}

/**
 * Nến 1 phút của MỘT market trong một khoảng (đi theo PK `(market, ts)`). Không bao giờ truy vấn `candles_1m` mà không có
 * điều kiện market (review PR #278 B1).
 */
export async function candlesOf(
  db: Exec,
  market: string,
  from: number,
  until: number,
): Promise<{ ts: number; high: string; low: string; close: string }[]> {
  const rows = await db
    .select({ ts: candles1m.ts, high: candles1m.high, low: candles1m.low, close: candles1m.close })
    .from(candles1m)
    .where(
      and(
        eq(candles1m.market, market),
        gte(candles1m.ts, new Date(from)),
        lt(candles1m.ts, new Date(until)),
      ),
    )
    .orderBy(asc(candles1m.ts));
  return rows.map((r) => ({ ts: r.ts.getTime(), high: r.high, low: r.low, close: r.close }));
}
