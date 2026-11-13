import {
  aiSuggestions,
  botEvents,
  botVersions,
  bots,
  orders,
  paperAccounts,
  paperFills,
  paperSnapshots,
} from "@drift/db";
import {
  Decimal,
  AppError,
  assetOf,
  BotState,
  DESK_CONFIG,
  deskNotes,
  dec,
  ENGINE_ACTIVE_STATES,
  ErrorCode,
  holdResult,
  lossLimitOf,
  paperDay,
  paperReasons,
  paperVerdict,
  ReasonCode,
  type BotSummary,
  type DeskBotsView,
  type GoLiveView,
  type PaperView,
  type StartPaperBody,
} from "@drift/shared";
import { meetsMinSize, paperEquity, requirementOf, type PaperBook } from "@drift/strategies";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { AuditAction, audit } from "../../lib/audit";
import { analystBots } from "../account/service";
import {
  account,
  aiDeskOn,
  listBots,
  ownBot,
  parseConfig,
  rulesFor,
  summary,
  type BotDeps,
} from "../bots/service";
import { aiParams, type RecoDeps } from "../reco/service";
import { iso } from "../security/service";

import type { DeskLlm } from "./llm";
import type { DeskMarketSource } from "./market";

// AI Desk (DEC-105, AI_DESK_RECOMMENDED.md): bot paper chạy bằng tiền giả, kết quả theo quy tắc cố định, chuyển
// sang tiền thật bằng một bot MỚI (không đổi `mode` tại chỗ). Không có gì ở đây gửi lệnh hay ký.

export interface DeskDeps {
  bots: BotDeps;
  reco: RecoDeps;
  /** Desk AI (DEC-165): null = LLM tắt, câu mẫu. */
  llm: DeskLlm | null;
  /** Fact "Market today" (DEC-211); thiếu = không có fact thị trường. */
  market?: DeskMarketSource | null;
}

/** Lý do dừng có nghĩa là đã chạm giới hạn lỗ (stop hoặc max loss). */
const LOSS_STOPS: readonly string[] = [ReasonCode.stopLoss, ReasonCode.botMaxLoss];

export async function requireDesk(deps: DeskDeps, userId: string): Promise<void> {
  if (!(await aiDeskOn(deps.bots.db, userId)))
    throw new AppError(ErrorCode.forbidden, "AI Desk is not enabled for this account.");
}

async function paperBot(deps: DeskDeps, userId: string, botId: string) {
  const b = await ownBot(deps.bots.db, userId, botId);
  if (b.mode !== "paper") throw new AppError(ErrorCode.botNotFound, "Fake-money test not found.");
  return b;
}

/**
 * Try with fake money: tạo bot paper từ một đề xuất đã lưu và chạy ngay. Không cần builder fee, API key hay 2FA vì
 * không có tiền thật; vẫn kiểm tra cấu hình và lệnh tối thiểu của SoDEX. Bản đầu cần account SoDEX đã kết nối vì
 * engine chia việc theo account (ghi ở DEC-105).
 */
export async function startPaper(
  deps: DeskDeps,
  userId: string,
  body: StartPaperBody & { name: string },
  ip: string | null,
): Promise<BotSummary> {
  await requireDesk(deps, userId);
  const db = deps.bots.db;
  const [s] = await db
    .select()
    .from(aiSuggestions)
    .where(and(eq(aiSuggestions.id, body.suggestionId), eq(aiSuggestions.userId, userId)))
    .limit(1);
  if (s === undefined) throw new AppError(ErrorCode.notFound, "Suggestion not found.");
  const a = await account(db, userId).catch(() => {
    throw new AppError(ErrorCode.notFound, "Connect SoDEX to run a fake-money test.");
  });
  const [running] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bots)
    .where(
      and(
        eq(bots.userId, userId),
        eq(bots.mode, "paper"),
        inArray(bots.state, [...ENGINE_ACTIVE_STATES]),
      ),
    );
  if ((running?.n ?? 0) >= DESK_CONFIG.maxRunningPaperBots)
    throw new AppError(
      ErrorCode.botStateConflict,
      `You can run up to ${String(DESK_CONFIG.maxRunningPaperBots)} fake-money tests at a time.`,
      { limit: DESK_CONFIG.maxRunningPaperBots },
    );
  const config = parseConfig(s.strategy, s.values);
  const req = requirementOf(s.strategy, config);
  const last = await deps.bots.lastPrice(req.market);
  const rules = await rulesFor(deps.bots, req.market).catch(() => undefined);
  if (last === null || rules === undefined)
    throw new AppError(
      ErrorCode.validationFailed,
      "No recent price for this market yet. Try again soon.",
    );
  if (!meetsMinSize(s.strategy, config, rules, last.price))
    throw new AppError(ErrorCode.orderBelowMinSize, "An order is below SoDEX minimum size.");
  const now = deps.bots.now();
  const capital = dec(s.capital).toString();
  const bot = await db.transaction(async (tx) => {
    const [b] = await tx
      .insert(bots)
      .values({
        userId,
        sodexAccountId: a.id,
        strategy: s.strategy,
        market: req.market,
        engine: req.engine,
        name: body.name,
        mode: "paper",
        state: BotState.starting,
      })
      .returning();
    if (b === undefined) throw new AppError(ErrorCode.internal, "Could not create the test.");
    const [v] = await tx
      .insert(botVersions)
      .values({
        botId: b.id,
        version: 1,
        config,
        paramSource: "ai",
        aiSuggestionId: s.id,
        status: "active",
        appliedAt: now,
      })
      .returning();
    await tx.insert(paperAccounts).values({
      botId: b.id,
      capital,
      cash: capital,
      positions: {},
      peakEquity: capital,
      startPrice: last.price,
      startedAt: now,
    });
    const [u] = await tx
      .update(bots)
      .set({ activeVersionId: v?.id ?? null })
      .where(eq(bots.id, b.id))
      .returning();
    return u ?? b;
  });
  await audit(db, {
    userId,
    action: AuditAction.botCreated,
    target: bot.id,
    metadata: { paper: true },
    ip,
  });
  return summary(bot, 1, null);
}

async function enginesOf(deps: DeskDeps, botId: string, market: string, engine: string) {
  const rows = await deps.bots.db
    .selectDistinct({ market: orders.market, engine: orders.engine })
    .from(orders)
    .where(eq(orders.botId, botId));
  const out: Record<string, "spot" | "perps"> = Object.fromEntries(
    rows.map((r) => [r.market, r.engine]),
  );
  if (out[market] === undefined && engine !== "spot+perps")
    out[market] = engine === "perps" ? "perps" : "spot";
  return out;
}

/** Số dư giả hiện tại; null khi thiếu giá của một market đang giữ. */
async function equityOf(
  deps: DeskDeps,
  a: typeof paperAccounts.$inferSelect,
  bot: typeof bots.$inferSelect,
): Promise<string | null> {
  const book: PaperBook = {
    cash: a.cash,
    positions: (a.positions ?? {}) as PaperBook["positions"],
    fees: a.fees,
    funding: a.funding,
    fills: a.fills,
  };
  const markets = Object.keys(book.positions);
  const prices = markets.length === 0 ? {} : await deps.bots.prices(markets).catch(() => null);
  if (prices === null || markets.some((m) => prices[m] === undefined)) return null;
  const engines = await enginesOf(deps, bot.id, bot.market, bot.engine);
  return paperEquity(book, engines, prices).toDecimalPlaces(8).toString();
}

export async function paperView(deps: DeskDeps, userId: string, botId: string): Promise<PaperView> {
  await requireDesk(deps, userId);
  const db = deps.bots.db;
  const b = await paperBot(deps, userId, botId);
  const [a] = await db.select().from(paperAccounts).where(eq(paperAccounts.botId, b.id)).limit(1);
  if (a === undefined) throw new AppError(ErrorCode.botNotFound, "Fake-money test not found.");
  const [v] = await db
    .select()
    .from(botVersions)
    .where(eq(botVersions.id, b.activeVersionId ?? ""))
    .limit(1);
  const config = (v?.config ?? {}) as Record<string, unknown>;
  const now = deps.bots.now().getTime();
  const startedAt = a.startedAt.getTime();
  const equity = await equityOf(deps, a, b);
  const net = equity === null ? null : dec(equity).sub(a.capital).toDecimalPlaces(8).toString();
  const lossLimit = lossLimitOf(config);
  const stoppedByLossLimit =
    b.state === BotState.stopped && LOSS_STOPS.includes(b.reasonCode ?? "");
  const last = await deps.bots.lastPrice(b.market);
  const startPrice = a.startPrice === null ? null : dec(a.startPrice).toString();
  // Hai ngày đầu gom theo giờ, sau đó theo ngày; luôn có điểm vốn ban đầu và số dư hiện tại để biểu đồ hiện ngay
  // từ ngày đầu.
  const unit = now - startedAt < 2 * 86_400_000 ? "hour" : "day";
  // `unit` là hằng số của code, không phải dữ liệu người dùng: nhúng thẳng để DISTINCT ON và ORDER BY khớp nhau.
  const bucket = sql`date_trunc(${sql.raw(`'${unit}'`)}, ${paperSnapshots.at} at time zone 'UTC')`;
  const rows = await db
    .selectDistinctOn([bucket], {
      date: sql<string>`to_char(${bucket}, 'YYYY-MM-DD"T"HH24:00')`,
      equity: paperSnapshots.equity,
    })
    .from(paperSnapshots)
    .where(eq(paperSnapshots.botId, b.id))
    .orderBy(bucket, desc(paperSnapshots.at));
  const daily = [
    { date: iso(a.startedAt), equity: a.capital },
    ...rows,
    ...(equity === null ? [] : [{ date: iso(new Date(now)), equity }]),
  ];
  // Sụt giảm lớn nhất tính cả số dư lúc này: snapshot chỉ ghi định kỳ nên có thể chưa thấy lần sụt mới nhất.
  const peak = Decimal.max(dec(a.peakEquity), dec(a.capital));
  const maxDrawdown = Decimal.max(
    dec(a.maxDrawdown),
    equity === null ? new Decimal(0) : peak.sub(equity),
  ).toString();
  const fillRows = await db
    .select()
    .from(paperFills)
    .where(eq(paperFills.botId, b.id))
    .orderBy(desc(paperFills.filledAt))
    .limit(15);
  const events = await db
    .select()
    .from(botEvents)
    .where(eq(botEvents.botId, b.id))
    .orderBy(desc(botEvents.occurredAt))
    .limit(15);
  const activity = [
    ...fillRows.map((f) => ({
      at: f.filledAt.getTime(),
      kind: "fill" as const,
      side: f.side,
      market: f.market,
      price: dec(f.price).toString(),
      size: dec(f.size).toString(),
      decision: null,
      why: null,
    })),
    ...events.map((e) => ({
      at: e.occurredAt.getTime(),
      kind: "event" as const,
      side: null,
      market: null,
      price: null,
      size: null,
      decision: e.decision,
      why: e.why,
    })),
  ]
    .sort((x, y) => y.at - x.at)
    .slice(0, 15)
    .map((x) => ({ ...x, at: new Date(x.at).toISOString() }));
  const lastPrice = last?.price ?? null;
  return {
    bot: summary(b, v?.version ?? null, null),
    suggestionId: v?.aiSuggestionId ?? null,
    startedAt: iso(a.startedAt),
    day: paperDay(startedAt, now),
    capital: dec(a.capital).toString(),
    equity,
    net,
    fees: dec(a.fees).toString(),
    funding: dec(a.funding).toString(),
    fills: a.fills,
    maxDrawdown: dec(maxDrawdown).toDecimalPlaces(8).toString(),
    lossLimit,
    stoppedByLossLimit,
    verdict: paperVerdict({ stoppedByLossLimit, startedAt, now, net: net ?? "0" }),
    minDays: DESK_CONFIG.minDaysForComparison,
    hold: {
      asset: assetOf(b.market),
      amount: holdResult(a.capital, startPrice, lastPrice),
      changePct:
        startPrice === null || lastPrice === null || !dec(startPrice).gt(0)
          ? null
          : dec(lastPrice).div(startPrice).sub(1).mul(100).toDecimalPlaces(2).toString(),
    },
    reasons: paperReasons({
      fills: a.fills,
      net: net ?? "0",
      fees: a.fees,
      maxDrawdown,
      lossLimit,
      stoppedByLossLimit,
    }),
    daily: daily.map((d) => ({
      date: d.date,
      equity: dec(d.equity).toDecimalPlaces(8).toString(),
    })),
    activity,
  };
}

/** Your bots: nhận xét theo quy tắc AI Analyst cho bot thật, kèm thẻ của các bài thử tiền giả. */
export async function deskBots(deps: DeskDeps, userId: string): Promise<DeskBotsView> {
  await requireDesk(deps, userId);
  const db = deps.bots.db;
  const now = deps.bots.now().getTime();
  const all = await listBots(deps.bots, userId);
  const notes = deskNotes(await analystBots(db, userId), now);
  const paperRows = await db
    .select({ b: bots, a: paperAccounts })
    .from(bots)
    .innerJoin(paperAccounts, eq(paperAccounts.botId, bots.id))
    .where(and(eq(bots.userId, userId), eq(bots.mode, "paper"), sql`${bots.state} <> 'archived'`))
    .orderBy(desc(bots.updatedAt));
  const paper = [];
  for (const { b, a } of paperRows) {
    const s = all.find((x) => x.id === b.id);
    if (s === undefined) continue;
    const equity = await equityOf(deps, a, b);
    paper.push({
      bot: s,
      day: paperDay(a.startedAt.getTime(), now),
      net: equity === null ? null : dec(equity).sub(a.capital).toDecimalPlaces(2).toString(),
    });
  }
  return {
    notes: notes.flatMap((n) => {
      const bot = all.find((x) => x.id === n.botId);
      return bot === undefined
        ? []
        : [
            {
              bot,
              note: {
                kind: n.kind,
                fills: n.fills,
                fees: n.fees,
                net: n.net,
                quote: n.quote,
                since: n.since === null ? null : new Date(n.since).toISOString(),
              },
            },
          ];
    }),
    paper,
  };
}

const show = (v: unknown): string | null =>
  v === undefined || v === null ? null : typeof v === "string" ? v : JSON.stringify(v);

/**
 * Use real money (mục 9): tính lại tham số bằng `aiParameters()` với giá hiện tại cho cùng chiến lược, market và
 * vốn, rồi liệt kê thay đổi so với bản đã thử. Không tạo bot: web tạo bot MỚI `live` và đi qua Start (kiểm tra + 2FA).
 */
export async function goLive(deps: DeskDeps, userId: string, botId: string): Promise<GoLiveView> {
  await requireDesk(deps, userId);
  const b = await paperBot(deps, userId, botId);
  const db = deps.bots.db;
  const [a] = await db.select().from(paperAccounts).where(eq(paperAccounts.botId, b.id)).limit(1);
  const [v] = await db
    .select()
    .from(botVersions)
    .where(eq(botVersions.id, b.activeVersionId ?? ""))
    .limit(1);
  const paperConfig = (v?.config ?? {}) as Record<string, unknown>;
  const capital = dec(a?.capital ?? "0").toString();
  const live = await aiParams(deps.reco, userId, {
    strategy: b.strategy as Parameters<typeof aiParams>[2]["strategy"],
    market: b.market,
    capital,
    context: "create",
  }).catch(() => null);
  const keys = [
    ...new Set([...Object.keys(paperConfig), ...Object.keys(live?.values ?? {})]),
  ].filter((k) => k !== "market");
  const changes =
    live === null
      ? []
      : keys
          .map((k) => ({ key: k, from: show(paperConfig[k]), to: show(live.values[k]) }))
          .filter((c) => c.from !== c.to);
  return {
    paperBotId: b.id,
    strategy: b.strategy,
    market: b.market,
    name: b.name,
    capital,
    paperConfig,
    live,
    changes,
  };
}
