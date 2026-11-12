import {
  botEvents,
  botReviews,
  bots,
  botVersions,
  deskItems,
  fills,
  orders,
  type Db,
} from "@drift/db";
import {
  botHealth,
  botReviewResultSchema,
  dec,
  Decimal,
  deskNotes,
  evaluateBot,
  NEEDS_YOU_CONFIG,
  pickNeedsYou,
  Strategy,
  type BotHealth,
  type DeskBotFacts,
  type DeskStopCheck,
  type DeskTakerStats,
  type MarginTier,
  type NeedsYouCandidate,
  type NeedsYouRule,
  type NeedsYouView,
} from "@drift/shared";
import type { PerpsSymbol } from "@drift/sodex";
import {
  buildTrades,
  farmStopFraction,
  requirementOf,
  STRATEGIES,
  type ReviewFill,
  type VolumeFarmConfig,
} from "@drift/strategies";
import { and, desc, eq, gte, inArray, isNull, like, sql } from "drizzle-orm";

import { analystBots } from "../account/service";
import type { BotDeps } from "../bots/service";

// AI Desk B+ M1 (DEC-164, DEC-166): gom dữ liệu thật thành `DeskBotFacts`, chạy 4 quy tắc (hàm thuần ở
// `@drift/shared`), lưu việc vào `desk_items`, trả tối đa 3 việc + sức khoẻ từng bot. Chỉ đọc bot: không sửa, không
// gửi lệnh. Copy Trade không xét ở v1 (nối Copy Trading là v2, DEC-166).

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Config đã parse bằng schema của chiến lược (giá trị mặc định đã điền); lỗi parse → null (không đoán). */
function parsed(strategy: string, config: unknown): Record<string, unknown> | null {
  const entry = (
    STRATEGIES as Record<
      string,
      { schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } } | undefined
    >
  )[strategy];
  if (entry === undefined) return null;
  const r = entry.schema.safeParse(config);
  return r.success ? (r.data as Record<string, unknown>) : null;
}

/** Khoảng stop loss + đòn bẩy của bot Perps có stop theo giá. Chiến lược không có stop theo giá → null. */
export function stopCheckOf(
  strategy: string,
  rawConfig: unknown,
  tiers: readonly MarginTier[] | undefined,
): DeskStopCheck | null {
  if (tiers === undefined || tiers.length === 0) return null;
  const c = parsed(strategy, rawConfig);
  if (c === null) return null;
  const leverage = num(c.leverage);
  if (leverage === null) return null;
  const marginMode = c.marginMode === "isolated" ? "isolated" : "cross";
  let notional: string;
  try {
    notional = dec(requirementOf(strategy, c).capital).mul(leverage).toString();
  } catch {
    return null;
  }
  const base = { leverage, marginMode, notional, tiers } as const;
  const pct = (v: unknown) => (str(v) === null ? null : dec(str(v) ?? "0").div(100));
  switch (strategy) {
    case Strategy.volumeFarm: {
      const f = farmStopFraction(c as unknown as VolumeFarmConfig);
      return {
        ...base,
        side: "both",
        stopDistance: f.toString(),
        stopLabel: `${f.mul(100).toDecimalPlaces(3).toString()}% price`,
      };
    }
    case Strategy.futuresDca: {
      const f = pct(c.stopLossPct);
      if (f === null) return null;
      return {
        ...base,
        side: c.direction === "short" ? "short" : "long",
        stopDistance: f.toString(),
        stopLabel: `${f.mul(100).toString()}%`,
      };
    }
    case Strategy.adaptiveDca: {
      const f = pct(c.hardStopLossPct);
      if (f === null) return null;
      return {
        ...base,
        side: c.direction === "short" ? "short" : "long",
        stopDistance: f.toString(),
        stopLabel: `${f.mul(100).toString()}%`,
      };
    }
    case Strategy.futuresGrid: {
      // Lệnh vào xa stop nhất của lưới: mua ở giá trên cùng (stop dưới), bán ở giá dưới cùng (stop trên).
      const upper = str(c.upperPrice);
      const lower = str(c.lowerPrice);
      const below = str(c.stopBelow);
      const above = str(c.stopAbove);
      const dists: Decimal[] = [];
      if (upper !== null && below !== null && c.direction !== "short")
        dists.push(dec(upper).sub(below).div(upper));
      if (lower !== null && above !== null && c.direction !== "long")
        dists.push(dec(above).sub(lower).div(lower));
      if (dists.length === 0) return null;
      const f = Decimal.max(...dists);
      const side = c.direction === "long" ? "long" : c.direction === "short" ? "short" : "both";
      return {
        ...base,
        side,
        stopDistance: f.toString(),
        stopLabel: `${f.mul(100).toDecimalPlaces(2).toString()}%`,
      };
    }
    default:
      return null;
  }
}

/** Lượt maker / taker của Volume Farm trong cửa sổ (cách tính DEC-130: (phí − lãi giá) ÷ volume × 1e6 mỗi nhóm). */
export function takerStats(fs: readonly ReviewFill[]): DeskTakerStats {
  const trades = buildTrades(fs);
  const cpm = (ts: typeof trades): number | null => {
    const v = ts.reduce((s, t) => s + t.volume, 0);
    if (ts.length === 0 || v === 0) return null;
    return ((ts.reduce((s, t) => s + t.fees, 0) - ts.reduce((s, t) => s + t.gross, 0)) / v) * 1e6;
  };
  const taker = trades.filter((t) => !t.allMaker);
  const maker = trades.filter((t) => t.allMaker);
  return {
    trades: trades.length,
    takerTrades: taker.length,
    takerCostPerMillion: cpm(taker),
    makerCostPerMillion: cpm(maker),
  };
}

async function volumeFarmFills(db: Db, botId: string, since: number): Promise<ReviewFill[]> {
  const rows = await db
    .select({
      tag: orders.tag,
      side: orders.side,
      price: fills.price,
      size: fills.size,
      fee: fills.fee,
      builderFee: fills.builderFee,
      isMaker: fills.isMaker,
      at: fills.filledAt,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(
      and(eq(orders.botId, botId), like(orders.tag, "vf:%"), gte(fills.filledAt, new Date(since))),
    );
  return rows.map((r) => ({
    tag: r.tag,
    side: r.side,
    price: Number(r.price),
    size: Number(r.size),
    fee: Number(r.fee),
    builderFee: Number(r.builderFee ?? "0"),
    isMaker: r.isMaker === true,
    at: r.at.getTime(),
  }));
}

/** Sự kiện do API ghi lên bot (không phải engine): không phải mốc dừng. */
const NON_ENGINE_DECISIONS = ["Builder fee changed"];

/**
 * Lúc bot dừng thật: sự kiện `state` (engine pause: "Paused") hoặc `decision` (log dừng của chiến lược ngay trước khi
 * engine stop) gần nhất. Bot đã dừng thì engine không ghi thêm sự kiện, nên đây là mốc dừng; đổi tên hay lưu version
 * không ghi `state` / `decision` (khác `bots.updatedAt`).
 */
async function stoppedAtOf(db: Db, botIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (botIds.length === 0) return out;
  const rows = await db
    .select({ botId: botEvents.botId, at: sql<Date>`max(${botEvents.occurredAt})` })
    .from(botEvents)
    .where(
      and(
        inArray(botEvents.botId, [...botIds]),
        inArray(botEvents.type, ["state", "decision"]),
        sql`coalesce(${botEvents.decision}, '') not in (${sql.join(
          NON_ENGINE_DECISIONS.map((d) => sql`${d}`),
          sql`, `,
        )})`,
      ),
    )
    .groupBy(botEvents.botId);
  for (const r of rows) out.set(r.botId, new Date(r.at).getTime());
  return out;
}

export interface NeedsYouDeps {
  db: Db;
  rest: Pick<BotDeps["rest"], "getPerpsSymbols">;
  now: () => Date;
}

/**
 * Dữ liệu thật của mọi bot thật (không draft, không paper) của user. Mặc định bỏ bot archived (Needs you, "Your bots").
 * `archivedSince`: thêm bot archived từ mốc đó (Desk AI, DEC-TBD-desk-archived) để câu trả lời về lãi / lỗ / phí đủ hơn.
 */
export async function collectFacts(
  deps: NeedsYouDeps,
  userId: string,
  opts: { archivedSince?: Date } = {},
): Promise<DeskBotFacts[]> {
  const now = deps.now().getTime();
  const state =
    opts.archivedSince === undefined
      ? sql`${bots.state} not in ('draft', 'archived')`
      : sql`(${bots.state} not in ('draft', 'archived') or (${bots.state} = 'archived' and ${bots.archivedAt} >= ${opts.archivedSince}))`;
  const rows = await deps.db
    .select({ b: bots, config: botVersions.config, appliedAt: botVersions.appliedAt })
    .from(bots)
    .leftJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
    .where(and(eq(bots.userId, userId), eq(bots.mode, "live"), state));
  const list = rows.filter((r) => r.b.strategy !== Strategy.copyTrade);
  if (list.length === 0) return [];
  const analyst = new Map(
    deskNotes(await analystBots(deps.db, userId), now).map((n) => [n.botId, n]),
  );
  let symbols: PerpsSymbol[] = [];
  try {
    symbols = await deps.rest.getPerpsSymbols();
  } catch {
    // SoDEX không đọc được: bỏ quy tắc 1 lần này (không đoán bậc margin).
    symbols = [];
  }
  const stopped = list
    .filter((r) => r.b.state === "paused" || r.b.state === "stopped")
    .map((r) => r.b.id);
  const stopAt = await stoppedAtOf(deps.db, stopped);
  const reviews = await deps.db
    .select()
    .from(botReviews)
    .where(
      inArray(
        botReviews.botId,
        list.map((r) => r.b.id),
      ),
    )
    .orderBy(desc(botReviews.createdAt));
  const out: DeskBotFacts[] = [];
  for (const { b, config, appliedAt } of list) {
    const note = analyst.get(b.id);
    const c = (config ?? {}) as Record<string, unknown>;
    const tiers = symbols.find((s) => s.name === b.market)?.marginTiers;
    const r = reviews.find((x) => x.botId === b.id);
    const parsedResult = r?.result == null ? null : botReviewResultSchema.safeParse(r.result);
    const result =
      parsedResult?.success === true && parsedResult.data.status === "done"
        ? parsedResult.data
        : null;
    out.push({
      botId: b.id,
      name: b.name,
      strategy: b.strategy,
      market: b.market,
      state: b.state,
      reasonCode: b.reasonCode,
      net: note?.net ?? null,
      maxLoss: str(c.maxLoss),
      fees: note?.fees ?? null,
      stoppedAt: stopAt.get(b.id) ?? null,
      stop: stopCheckOf(b.strategy, c, tiers),
      taker:
        b.strategy === Strategy.volumeFarm
          ? takerStats(await volumeFarmFills(deps.db, b.id, now - NEEDS_YOU_CONFIG.takerWindowMs))
          : null,
      review:
        r === undefined
          ? null
          : {
              id: r.id,
              status: result === null ? (r.status === "done" ? "invalid" : r.status) : "done",
              suggestion:
                result === null
                  ? null
                  : (result.suggestion ?? (result.recommended ? "strong" : "none")),
              appliedVersion: r.appliedVersion,
              createdAt: (r.finishedAt ?? r.createdAt).getTime(),
              activeVersionAppliedAt: appliedAt?.getTime() ?? null,
              currentCostPerMillion: result?.current.costPerMillion ?? null,
              bestCostPerMillion: result?.best.costPerMillion ?? null,
            },
      analyst: note?.kind ?? "fine",
    });
  }
  return out;
}

/**
 * Tính lại việc của user: upsert từng việc còn đúng, đánh dấu `resolved` việc không còn đúng, rồi chọn tối đa 3 việc
 * không hoãn. Trả kèm sức khoẻ từng bot.
 */
export async function needsYou(deps: NeedsYouDeps, userId: string): Promise<NeedsYouView> {
  const now = deps.now();
  const facts = await collectFacts(deps, userId);
  const candidates = facts.flatMap((b) => evaluateBot(b, now.getTime()));
  const stored = await deps.db.select().from(deskItems).where(eq(deskItems.userId, userId));
  const keyOf = (x: { botId: string; rule: string }) => `${x.botId}:${x.rule}`;
  for (const c of candidates) {
    // Một câu lệnh upsert theo (bot_id, rule): hai request song song không vi phạm unique. Giữ `snoozedAt` khi
    // fingerprint không đổi và việc chưa resolved; fingerprint đổi (lần dừng mới, đòn bẩy đổi, review mới) → việc mới.
    await deps.db
      .insert(deskItems)
      .values({
        userId,
        botId: c.botId,
        rule: c.rule,
        severity: c.severity,
        facts: c.facts,
        fingerprint: c.fingerprint,
        badness: c.badness,
        lastSeenAt: now,
        snoozedAt: null,
        resolvedAt: null,
      })
      .onConflictDoUpdate({
        target: [deskItems.botId, deskItems.rule],
        set: {
          severity: c.severity,
          facts: c.facts,
          badness: c.badness,
          lastSeenAt: now,
          snoozedAt: sql`case when ${deskItems.fingerprint} = excluded.fingerprint and ${deskItems.resolvedAt} is null then ${deskItems.snoozedAt} else null end`,
          fingerprint: sql`excluded.fingerprint`,
          resolvedAt: null,
          updatedAt: now,
        },
      });
  }
  const live = new Set(candidates.map(keyOf));
  const gone = stored.filter((s) => s.resolvedAt === null && !live.has(keyOf(s))).map((s) => s.id);
  if (gone.length > 0)
    await deps.db
      .update(deskItems)
      .set({ resolvedAt: now })
      .where(and(inArray(deskItems.id, gone), isNull(deskItems.resolvedAt)));

  const current = await deps.db
    .select()
    .from(deskItems)
    .where(and(eq(deskItems.userId, userId), isNull(deskItems.resolvedAt)));
  const picked = pickNeedsYou(
    candidates,
    current.map((s) => ({
      botId: s.botId,
      rule: s.rule,
      fingerprint: s.fingerprint,
      badness: s.badness,
      snoozedAt: s.snoozedAt?.getTime() ?? null,
    })),
    now.getTime(),
  );
  const idOf = new Map(current.map((s) => [keyOf(s), s.id]));
  const nameOf = new Map(facts.map((f) => [f.botId, f]));
  return {
    checkedAt: now.toISOString(),
    items: picked.map((c: NeedsYouCandidate) => {
      const b = nameOf.get(c.botId);
      return {
        id: idOf.get(keyOf(c)) ?? "",
        botId: c.botId,
        botName: b?.name ?? "",
        strategy: b?.strategy ?? "",
        market: b?.market ?? "",
        rule: c.rule,
        severity: c.severity,
        facts: c.facts,
      };
    }),
    bots: facts.map((b) => ({
      botId: b.botId,
      name: b.name,
      strategy: b.strategy,
      market: b.market,
      state: b.state,
      health: botHealth(b, candidates) satisfies BotHealth,
    })),
  };
}

/** "Later" / "Not now": ẩn 7 ngày trừ khi dữ liệu xấu đi. Việc của user khác → null (API trả 404). */
export async function snoozeItem(
  deps: NeedsYouDeps,
  userId: string,
  itemId: string,
): Promise<{ id: string; rule: NeedsYouRule; snoozedUntil: string } | null> {
  const now = deps.now();
  const [row] = await deps.db
    .update(deskItems)
    .set({ snoozedAt: now })
    .where(
      and(eq(deskItems.id, itemId), eq(deskItems.userId, userId), isNull(deskItems.resolvedAt)),
    )
    .returning({ id: deskItems.id, rule: deskItems.rule });
  if (row === undefined) return null;
  return {
    id: row.id,
    rule: row.rule,
    snoozedUntil: new Date(now.getTime() + NEEDS_YOU_CONFIG.snoozeMs).toISOString(),
  };
}
