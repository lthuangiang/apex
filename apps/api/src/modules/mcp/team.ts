import {
  botEvents,
  bots,
  botVersions,
  builderRevenueDaily,
  connectEvents,
  orders,
  sodexAccounts,
  sodexSignatureRequests,
  users,
  type Db,
} from "@drift/db";
import {
  AppError,
  ErrorCode,
  MCP_REVENUE_MAX_DAYS,
  OrderStatus,
  type TeamBotTimeline,
  type TeamBuilderRevenue,
  type TeamConnectAttempts,
  type TeamFindUser,
  type TeamUnknownOrders,
  type TeamUser,
  type TeamUserBots,
} from "@drift/shared";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";

// Dữ liệu cho tool MCP nội bộ của team (docs/MCP.md mục 5A, DEC-219). Chỉ đọc. Người gọi đã qua
// `requireMcpCaller(…, "team")`. Không bao giờ trả key, secret, chữ ký hay message EIP-712; thiếu dữ liệu → null kèm
// lý do, không bao giờ 0. Tên bot là chữ người dùng nhập → bọc `userText`.

export interface TeamDeps {
  db: Db;
  now: () => Date;
}

const at = (d: Date) => d.toISOString();
const atOrNull = (d: Date | null) => (d === null ? null : d.toISOString());
const DAY_MS = 86_400_000;

/**
 * Field của `connect_events.data` được trả cho team (DEC-114; review #75): chỉ những gì cần để hỗ trợ. Không trả UA đầy
 * đủ hay field lạ do client gửi. `message` của lỗi ví bị che các chuỗi hex dài (địa chỉ, chữ ký, calldata).
 */
const CONNECT_DATA_FIELDS = [
  "device",
  "os",
  "browser",
  "standalone",
  "width",
  "lang",
  "hasEthereum",
  "ethereumFlags",
  "sodex",
  "walletsDetected",
  "browserWallet",
  "walletConnect",
  "notDetected",
  "id",
  "name",
  "kind",
  "wallet",
  "address",
  "which",
  "reason",
  "code",
  "status",
  "message",
  "builderFeeExempt",
] as const;

const HEX_RUN = /0x[0-9a-fA-F]{12,}/g;

export function connectDataView(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of CONNECT_DATA_FIELDS) {
    const v = src[k];
    if (v === undefined) continue;
    if (typeof v === "string") out[k] = v.replace(HEX_RUN, "0x…").slice(0, 300);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string").slice(0, 30);
  }
  return out;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OrderRow = typeof orders.$inferSelect;
const orderView = (o: OrderRow) => ({
  id: o.id,
  clOrdId: o.clOrdId,
  market: o.market,
  side: o.side,
  type: o.type,
  price: o.price,
  size: o.size,
  filledSize: o.filledSize,
  avgPrice: o.avgPrice,
  status: o.status,
  reduceOnly: o.reduceOnly,
  tag: o.tag,
  rejectCode: o.rejectCode,
  rejectMessage: o.rejectMessage,
  submittedAt: atOrNull(o.submittedAt),
  reconciledAt: atOrNull(o.reconciledAt),
});

/** Con trỏ trang: `<ISO mili giây>~<id>` hoặc `<ISO>~<event|order>~<id>` (timeline). */
const cursorOf = (t: Date, id: string, kind?: "event" | "order") =>
  kind === undefined ? `${t.toISOString()}~${id}` : `${t.toISOString()}~${kind}~${id}`;

function parseCursor(raw: string, withKind: boolean) {
  const parts = raw.split("~");
  const [time, a, b] = parts;
  const kind = withKind ? a : undefined;
  const id = withKind ? b : a;
  const ok =
    parts.length === (withKind ? 3 : 2) &&
    time !== undefined &&
    !Number.isNaN(Date.parse(time)) &&
    id !== undefined &&
    UUID.test(id) &&
    (!withKind || kind === "event" || kind === "order");
  if (!ok) throw new AppError(ErrorCode.validationFailed, "Invalid cursor.");
  return {
    at: new Date(time),
    id,
    kind: kind === "order" ? ("order" as const) : ("event" as const),
  };
}

/** Tìm user theo id, email (không phân biệt hoa thường) hoặc 4+ ký tự cuối ví (tối đa 20 kết quả). */
export async function teamFindUser(deps: TeamDeps, query: string): Promise<TeamFindUser> {
  const q = query.trim();
  const matchedBy: TeamFindUser["matchedBy"] = UUID.test(q)
    ? "id"
    : q.includes("@")
      ? "email"
      : "wallet_tail";
  if (matchedBy === "wallet_tail" && !/^[0-9a-fA-F]{4,40}$/.test(q))
    throw new AppError(
      ErrorCode.validationFailed,
      "Use an email, a user id or the last 4 wallet characters.",
    );
  const tail = `%${q.toLowerCase()}`;
  const where =
    matchedBy === "id"
      ? eq(users.id, q)
      : matchedBy === "email"
        ? sql`lower(${users.email}) = ${q.toLowerCase()}`
        : sql`(lower(${users.walletAddress}) like ${tail} or exists (select 1 from ${sodexAccounts} where ${sodexAccounts.userId} = ${users.id} and lower(${sodexAccounts.address}) like ${tail}))`;
  const rows = await deps.db
    .select()
    .from(users)
    .where(and(where, isNull(users.deletedAt)))
    .orderBy(desc(users.createdAt))
    .limit(20);
  const accounts =
    rows.length === 0
      ? []
      : await deps.db
          .select()
          .from(sodexAccounts)
          .where(
            inArray(
              sodexAccounts.userId,
              rows.map((r) => r.id),
            ),
          )
          .orderBy(desc(sodexAccounts.updatedAt));
  const out: TeamUser[] = rows.map((u) => {
    const a = accounts.find((x) => x.userId === u.id);
    return {
      id: u.id,
      email: u.email,
      role: u.role,
      createdAt: at(u.createdAt),
      flags: { aiDesk: u.aiDesk, volumeBots: u.volumeBots, adaptiveDca: u.adaptiveDca },
      twoFactor: u.twofaEnabled,
      sodex:
        a === undefined
          ? null
          : {
              address: a.address,
              accountId: a.sodexAccountId.toString(),
              network: a.network,
              status: a.status,
            },
      sodexReason: a === undefined ? "not_connected" : null,
    };
  });
  return { asOf: at(deps.now()), source: "users, sodex_accounts", matchedBy, users: out };
}

/** Các lần thử Connect SoDEX (DEC-114), gộp theo `attemptId`, mới nhất trước. */
export async function teamConnectAttempts(
  deps: TeamDeps,
  input: {
    userId?: string | undefined;
    attemptId?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    limit: number;
  },
): Promise<TeamConnectAttempts> {
  const now = deps.now();
  const from =
    input.from === undefined ? new Date(now.getTime() - 30 * DAY_MS) : new Date(input.from);
  const to = input.to === undefined ? now : new Date(input.to);
  const conds: SQL[] = [gte(connectEvents.occurredAt, from), lte(connectEvents.occurredAt, to)];
  if (input.userId !== undefined) conds.push(eq(connectEvents.userId, input.userId));
  if (input.attemptId !== undefined) conds.push(eq(connectEvents.attemptId, input.attemptId));
  // Chọn `limit` lần thử mới nhất, rồi lấy đủ bước của từng lần.
  const ids = await deps.db
    .select({
      attemptId: connectEvents.attemptId,
      last: sql<Date>`max(${connectEvents.occurredAt})`,
    })
    .from(connectEvents)
    .where(and(...conds))
    .groupBy(connectEvents.attemptId)
    .orderBy(desc(sql`max(${connectEvents.occurredAt})`))
    .limit(input.limit);
  const events =
    ids.length === 0
      ? []
      : await deps.db
          .select()
          .from(connectEvents)
          .where(
            inArray(
              connectEvents.attemptId,
              ids.map((r) => r.attemptId),
            ),
          )
          .orderBy(asc(connectEvents.occurredAt))
          .limit(2_000);
  const attempts = ids.flatMap(({ attemptId }) => {
    const steps = events.filter((e) => e.attemptId === attemptId);
    const first = steps[0];
    const last = steps[steps.length - 1];
    if (first === undefined || last === undefined) return [];
    const failed = [...steps]
      .reverse()
      .find((s) => s.type.endsWith("_failed") || s.type.endsWith("_rejected"));
    const outcome = steps.some((s) => s.type === "connected")
      ? "connected"
      : failed !== undefined
        ? failed.type
        : "abandoned";
    const data = connectDataView(first.data);
    const device = typeof data.device === "string" ? data.device : null;
    return [
      {
        attemptId,
        userId: first.userId,
        startedAt: at(first.occurredAt),
        lastAt: at(last.occurredAt),
        outcome,
        device,
        steps: steps.map((s) => ({
          type: s.type,
          at: at(s.occurredAt),
          data: connectDataView(s.data),
        })),
      },
    ];
  });
  const userIds = [...new Set(attempts.map((a) => a.userId))];
  const requests =
    userIds.length === 0
      ? []
      : await deps.db
          .select({
            action: sodexSignatureRequests.action,
            status: sodexSignatureRequests.status,
            sodexError: sodexSignatureRequests.sodexError,
            at: sodexSignatureRequests.createdAt,
          })
          .from(sodexSignatureRequests)
          .where(
            and(
              inArray(sodexSignatureRequests.userId, userIds),
              gte(sodexSignatureRequests.createdAt, from),
              lte(sodexSignatureRequests.createdAt, to),
            ),
          )
          .orderBy(desc(sodexSignatureRequests.createdAt))
          .limit(20);
  return {
    asOf: at(now),
    source: "connect_events, sodex_signature_requests",
    attempts,
    signatureRequests: requests.map((r) => ({ ...r, at: at(r.at) })),
  };
}

async function userExists(db: Db, userId: string): Promise<void> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (u === undefined) throw new AppError(ErrorCode.notFound, "User not found.");
}

/** Bot của một user (kể cả đã lưu trữ), version đang chạy và lệnh lỗi gần nhất. */
export async function teamUserBots(deps: TeamDeps, userId: string): Promise<TeamUserBots> {
  await userExists(deps.db, userId);
  const rows = await deps.db
    .select({ b: bots, version: botVersions.version })
    .from(bots)
    .leftJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
    .where(eq(bots.userId, userId))
    .orderBy(desc(bots.updatedAt))
    .limit(100);
  const errors =
    rows.length === 0
      ? []
      : await deps.db
          .selectDistinctOn([orders.botId])
          .from(orders)
          .where(
            and(
              inArray(
                orders.botId,
                rows.map((r) => r.b.id),
              ),
              inArray(orders.status, [OrderStatus.rejected, OrderStatus.unknown]),
            ),
          )
          .orderBy(orders.botId, desc(orders.createdAt));
  return {
    asOf: at(deps.now()),
    source: "bots, bot_versions, orders",
    userId,
    bots: rows.map(({ b, version }) => {
      const e = errors.find((o) => o.botId === b.id);
      return {
        id: b.id,
        name: { userText: b.name },
        strategy: b.strategy,
        market: b.market,
        mode: b.mode,
        state: b.state,
        reasonCode: b.reasonCode,
        needsAttention: b.needsAttention,
        archived: b.archivedAt !== null,
        version: version ?? null,
        lastError:
          e === undefined
            ? null
            : {
                at: at(e.createdAt),
                clOrdId: e.clOrdId,
                status: e.status,
                rejectCode: e.rejectCode,
                rejectMessage: e.rejectMessage,
              },
        updatedAt: at(b.updatedAt),
      };
    }),
  };
}

/** Quyết định (bot_events) và lệnh của một bot theo thời gian, mới nhất trước; phân trang theo thời điểm. */
export interface TimelineInput {
  botId: string;
  from?: string | undefined;
  to?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

export async function teamBotTimeline(
  deps: TeamDeps,
  input: TimelineInput,
): Promise<TeamBotTimeline> {
  const [bot] = await deps.db.select().from(bots).where(eq(bots.id, input.botId)).limit(1);
  if (bot === undefined) throw new AppError(ErrorCode.botNotFound, "Bot not found.");
  return botTimeline(deps, bot, input);
}

/** Timeline của một bot đã được kiểm tra quyền (team: bot bất kỳ; người dùng: `ownBotOr404`). */
export async function botTimeline(
  deps: TeamDeps,
  bot: typeof bots.$inferSelect,
  input: Omit<TimelineInput, "botId">,
): Promise<TeamBotTimeline> {
  const now = deps.now();
  const from = input.from === undefined ? new Date(0) : new Date(input.from);
  const to = input.to === undefined ? now : new Date(input.to);
  const c = input.cursor === undefined ? null : parseCursor(input.cursor, true);
  // Thứ tự: thời điểm (cắt tới mili giây, DB lưu micro giây) giảm dần, event trước order, rồi id giảm dần. Con trỏ là
  // (thời điểm, loại, id) của mục cuối trang trước, nên không sót hay lặp mục cùng mili giây.
  const evT = sql`date_trunc('milliseconds', ${botEvents.occurredAt})`;
  const ordT = sql`date_trunc('milliseconds', ${orders.createdAt})`;
  const evAfter =
    c === null
      ? []
      : [
          c.kind === "event"
            ? sql`(${evT} < ${c.at} or (${evT} = ${c.at} and ${botEvents.id} < ${c.id}))`
            : sql`${evT} < ${c.at}`,
        ];
  const ordAfter =
    c === null
      ? []
      : [
          c.kind === "event"
            ? sql`${ordT} <= ${c.at}`
            : sql`(${ordT} < ${c.at} or (${ordT} = ${c.at} and ${orders.id} < ${c.id}))`,
        ];
  const [events, ords] = await Promise.all([
    deps.db
      .select()
      .from(botEvents)
      .where(
        and(
          eq(botEvents.botId, bot.id),
          gte(botEvents.occurredAt, from),
          lte(botEvents.occurredAt, to),
          ...evAfter,
        ),
      )
      .orderBy(desc(evT), desc(botEvents.id))
      .limit(input.limit + 1),
    deps.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.botId, bot.id),
          gte(orders.createdAt, from),
          lte(orders.createdAt, to),
          ...ordAfter,
        ),
      )
      .orderBy(desc(ordT), desc(orders.id))
      .limit(input.limit + 1),
  ]);
  const merged = [
    ...events.map((e) => ({
      t: e.occurredAt,
      rank: 0,
      id: e.id,
      kind: "event" as const,
      item: {
        kind: "event" as const,
        at: at(e.occurredAt),
        type: e.type,
        decision: e.decision,
        why: e.why,
        result: e.result,
      },
    })),
    ...ords.map((o) => ({
      t: o.createdAt,
      rank: 1,
      id: o.id,
      kind: "order" as const,
      item: { kind: "order" as const, at: at(o.createdAt), order: orderView(o) },
    })),
  ].sort(
    (a, b) =>
      b.t.getTime() - a.t.getTime() || a.rank - b.rank || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  const page = merged.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    asOf: at(now),
    source: "bot_events, orders",
    bot: {
      id: bot.id,
      userId: bot.userId,
      name: { userText: bot.name },
      strategy: bot.strategy,
      market: bot.market,
      mode: bot.mode,
      state: bot.state,
      reasonCode: bot.reasonCode,
    },
    items: page.map((p) => p.item),
    nextCursor:
      merged.length > input.limit && last !== undefined
        ? cursorOf(last.t, last.id, last.kind)
        : null,
  };
}

/** Lệnh `unknown` chưa đối soát xong (quy tắc 1.7), cũ nhất trước. */
export async function teamUnknownOrders(
  deps: TeamDeps,
  input: { userId?: string | undefined; cursor?: string | undefined; limit: number },
): Promise<TeamUnknownOrders> {
  const now = deps.now();
  const conds: SQL[] = [eq(orders.status, OrderStatus.unknown)];
  if (input.userId !== undefined) conds.push(eq(bots.userId, input.userId));
  // Con trỏ (thời điểm cắt tới mili giây, id): không sót lệnh cùng mili giây (DB lưu micro giây).
  const t = sql`date_trunc('milliseconds', ${orders.createdAt})`;
  const c = input.cursor === undefined ? null : parseCursor(input.cursor, false);
  if (c !== null) conds.push(sql`(${t} > ${c.at} or (${t} = ${c.at} and ${orders.id} > ${c.id}))`);
  const rows = await deps.db
    .select({ o: orders, userId: bots.userId, botName: bots.name })
    .from(orders)
    .innerJoin(bots, eq(bots.id, orders.botId))
    .where(and(...conds))
    .orderBy(asc(t), asc(orders.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    asOf: at(now),
    source: "orders",
    orders: page.map(({ o, userId, botName }) => ({
      userId,
      botId: o.botId,
      botName: { userText: botName },
      ageSeconds: Math.max(
        0,
        Math.floor((now.getTime() - (o.submittedAt ?? o.createdAt).getTime()) / 1000),
      ),
      reconcile: o.reconciledAt === null ? ("pending" as const) : ("retrying" as const),
      order: orderView(o),
      createdAt: at(o.createdAt),
    })),
    nextCursor:
      rows.length > input.limit && last !== undefined
        ? cursorOf(last.o.createdAt, last.o.id)
        : null,
  };
}

const dayList = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

/** `builder_revenue_daily` (DEC-64) theo ngày và engine; ngày chưa có dòng được liệt kê riêng, không điền 0. */
export async function teamBuilderRevenue(
  deps: TeamDeps,
  input: { from: string; to: string },
): Promise<TeamBuilderRevenue> {
  const days = dayList(input.from, input.to);
  if (days.length === 0)
    throw new AppError(ErrorCode.validationFailed, "`from` must be on or before `to`.");
  if (days.length > MCP_REVENUE_MAX_DAYS)
    throw new AppError(ErrorCode.validationFailed, `At most ${String(MCP_REVENUE_MAX_DAYS)} days.`);
  const rows = await deps.db
    .select()
    .from(builderRevenueDaily)
    .where(and(gte(builderRevenueDaily.date, input.from), lte(builderRevenueDaily.date, input.to)))
    .orderBy(asc(builderRevenueDaily.date), asc(builderRevenueDaily.engine));
  const seen = new Set(rows.map((r) => r.date));
  return {
    asOf: at(deps.now()),
    source: "builder_revenue_daily",
    from: input.from,
    to: input.to,
    days: rows.map((r) => ({
      date: r.date,
      engine: r.engine,
      fromFills: r.fromFills,
      fills: r.fills,
      notional: r.notional,
      balanceDelta: r.balanceDelta,
      difference: r.difference,
      reason: r.balanceDelta === null || r.difference === null ? "balance_not_reconciled" : null,
      status: r.status,
    })),
    missingDates: days.filter((d) => !seen.has(d)),
  };
}
