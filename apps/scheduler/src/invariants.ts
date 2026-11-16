import { botRuntime, bots, botVersions, fills, orders, outbox, type Db } from "@drift/db";
import { dec, Decimal, Strategy, type TeamOpsEvent } from "@drift/shared";
import { and, eq, gt, gte, inArray, not, or, sql } from "drizzle-orm";

// Bất biến tiền thật trên prod (DEC-TBD-prod-invariants; DevOps chọn theo ủy quyền, chờ người dùng xác nhận). Mỗi
// phút, chỉ đọc DB (không gọi SoDEX, không tự sửa, không đặt lệnh). Một bất biến sai ở 2 lần kiểm tra liền nhau
// (≥ 2 phút) mới báo `jobs.team_ops`; mỗi (bất biến, bot) tối đa 1 tin / 30 phút; đúng trở lại thì 1 tin "resolved"
// (cũng tối đa 1 / 30 phút). Chỉ xét bot running / stopping / paused và bot dừng trong 1 giờ qua. Tin không chứa ví / key.

export const PROD_INVARIANTS = {
  /** P1: (max inventory + một lệnh) × 1.05; lệnh cuối có thể vượt max tối đa một lệnh (thiết kế). */
  positionTolerance: "1.05",
  /** P2 / P3: bot dừng trong chừng này thì còn xét. */
  stoppedWindowMs: 3_600_000,
  /** P3: lệnh còn mở quá chừng này sau khi bot dừng. */
  openAfterStopMs: 60_000,
  /** P5: không báo giá quá refreshSeconds + chừng này. */
  quoteGapExtraMs: 30_000,
  /** P5: bỏ qua bot vừa cắt vị thế (đang giữ phía tăng vị thế, DEC-TBD-mm-cut-hold). */
  cutHoldMs: 60_000,
  /** Đánh dấu "sai ở lần trước"; > 1 phút để lần kế tiếp còn thấy. */
  seenMs: 150_000,
  throttleMs: 30 * 60_000,
  /** Bất biến đã báo mà chưa resolved: nhớ tối đa 1 ngày. */
  activeMs: 86_400_000,
} as const;

export type InvariantId = "P1" | "P2" | "P3" | "P4" | "P5";
export const INVARIANT_IDS: readonly InvariantId[] = ["P1", "P2", "P3", "P4", "P5"];

export interface Finding {
  invariant: InvariantId;
  botId: string;
  detail: string;
}

/** Dữ liệu của một bot cho các bất biến (đã đọc từ DB). */
export interface BotSnapshot {
  id: string;
  strategy: string;
  market: string;
  state: string;
  /** Lúc đổi trạng thái gần nhất (`bots.updated_at`): mốc Stop với bot stopping / stopped. */
  updatedAt: number;
  config: Record<string, unknown> | null;
  runtime: Record<string, unknown> | null;
  /** P2: lệnh mở vị thế tạo sau mốc Stop. */
  openingAfterStop: number;
  /** P3: lệnh còn open / partially_filled / unknown. */
  stillOpen: number;
  /** P4: Σ fill (mua − bán) theo sổ fills; null khi không xét. */
  filledNet: string | null;
  /** P4: step size của market; null khi không biết (không xét). */
  stepSize: string | null;
}

const usd = (v: Decimal) =>
  `${v.toDecimalPlaces(0).toNumber().toLocaleString("en-US", { maximumFractionDigits: 0 })} USDC`;
/**
 * Max open position của Market Making, cùng công thức `vmMaxInventory` (`packages/strategies/src/volume-maker/schema.ts`):
 * `maxInventory`, hoặc order size × `maxOrders` (mặc định 2, DEC-100). Viết lại ở đây để scheduler không phụ thuộc
 * `@drift/strategies`.
 */
export function mmMaxInventory(c: Record<string, unknown>): Decimal | null {
  const max = str(c.maxInventory);
  if (max !== null) return dec(max);
  const size = str(c.orderSize);
  if (size === null) return null;
  return dec(size).mul(typeof c.maxOrders === "number" ? c.maxOrders : 2);
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null;

/** Các bất biến sai của một bot lúc `now` (hàm thuần; so sánh bằng decimal). */
export function findingsOf(b: BotSnapshot, now: number): Finding[] {
  const out: Finding[] = [];
  const push = (invariant: InvariantId, detail: string) => {
    out.push({ invariant, botId: b.id, detail });
  };
  const mm = b.strategy === Strategy.volumeMaker;
  const st = b.runtime ?? {};
  const ledger = st.ledger;
  const position =
    typeof ledger === "object" && ledger !== null && "position" in ledger
      ? str(ledger.position)
      : null;

  // P1: vị thế vượt giới hạn của bot.
  if (mm && ["running", "paused", "stopping"].includes(b.state) && b.config !== null) {
    const mid = str(st.mid);
    const orderSize = str(b.config.orderSize);
    const max = mmMaxInventory(b.config);
    if (position !== null && mid !== null && orderSize !== null && max !== null) {
      const limit = max.add(orderSize);
      const notional = dec(position).abs().mul(mid);
      if (notional.gt(limit.mul(PROD_INVARIANTS.positionTolerance)))
        push("P1", `position ${usd(notional)} over limit ${usd(limit)}`);
    }
  }
  // P2: lệnh mở vị thế tới sau khi người dùng bấm Stop.
  if (b.openingAfterStop > 0)
    push("P2", `${String(b.openingAfterStop)} opening order(s) placed after Stop`);
  // P3: bot đã dừng còn lệnh mở.
  if (
    (b.state === "stopped" || b.state === "archived") &&
    now - b.updatedAt > PROD_INVARIANTS.openAfterStopMs &&
    b.stillOpen > 0
  )
    push("P3", `${String(b.stillOpen)} order(s) still open after the bot stopped`);
  // P4: sổ cái của bot lệch tổng fill quá một step size.
  if (mm && position !== null && b.filledNet !== null && b.stepSize !== null) {
    const diff = dec(position).sub(b.filledNet).abs();
    if (diff.gt(b.stepSize))
      push("P4", `ledger position ${position} vs fills ${dec(b.filledNet).toString()}`);
  }
  // P5: bot Market Making đang chạy không báo giá lại, mà không có lý do chờ có chủ đích.
  if (mm && b.state === "running" && b.config !== null) {
    const last = typeof st.lastRefresh === "number" ? st.lastRefresh : null;
    const refresh = typeof b.config.refreshSeconds === "number" ? b.config.refreshSeconds : null;
    const halted = st.phase === "halted";
    const fastPause = typeof st.fastPauseUntil === "number" && now < st.fastPauseUntil;
    const cutHold = typeof st.cutAt === "number" && now - st.cutAt < PROD_INVARIANTS.cutHoldMs;
    if (last !== null && refresh !== null && !halted && !fastPause && !cutHold) {
      const gap = now - last;
      if (gap > refresh * 1000 + PROD_INVARIANTS.quoteGapExtraMs)
        push("P5", `no quote for ${String(Math.round(gap / 1000))} s`);
    }
  }
  return out;
}

/** Redis cho bất biến: đánh dấu có hạn, đọc, xoá, và khoá chặn lặp (NX). */
export interface InvariantStore {
  has(key: string): Promise<boolean>;
  mark(key: string, ms: number): Promise<void>;
  drop(key: string): Promise<void>;
  /** Đặt khoá nếu chưa có, hết hạn sau `ms`; true = vừa đặt (được gửi). */
  claim(key: string, ms: number): Promise<boolean>;
}

export function redisInvariantStore(redis: {
  exists(key: string): Promise<number>;
  set(key: string, value: string, px: "PX", ms: number): Promise<unknown>;
  set(key: string, value: string, px: "PX", ms: number, nx: "NX"): Promise<string | null>;
  del(key: string): Promise<number>;
}): InvariantStore {
  return {
    async has(key) {
      return (await redis.exists(key)) > 0;
    },
    async mark(key, ms) {
      await redis.set(key, "1", "PX", ms);
    },
    async drop(key) {
      await redis.del(key);
    },
    async claim(key, ms) {
      return (await redis.set(key, "1", "PX", ms, "NX")) === "OK";
    },
  };
}

const keyOf = (kind: "seen" | "active" | "alert" | "ok", f: { invariant: string; botId: string }) =>
  `team:invariant:${kind}:${f.invariant}:${f.botId}`;

/**
 * Lọc kết quả của một lượt thành tin cần gửi: sai 2 lần liền mới báo (1 / 30 phút); bất biến đã báo mà nay đúng thì
 * báo "resolved" (1 / 30 phút). `botIds`: mọi bot đã xét trong lượt này.
 */
export async function decide(
  store: InvariantStore,
  botIds: readonly string[],
  findings: readonly Finding[],
): Promise<TeamOpsEvent[]> {
  const out: TeamOpsEvent[] = [];
  const failing = new Set(findings.map((f) => `${f.invariant}:${f.botId}`));
  for (const f of findings) {
    const seenBefore = await store.has(keyOf("seen", f));
    await store.mark(keyOf("seen", f), PROD_INVARIANTS.seenMs);
    if (!seenBefore) continue;
    if (!(await store.claim(keyOf("alert", f), PROD_INVARIANTS.throttleMs))) continue;
    await store.mark(keyOf("active", f), PROD_INVARIANTS.activeMs);
    out.push({ type: "team_invariant", ...f, status: "failing" });
  }
  for (const botId of botIds)
    for (const invariant of INVARIANT_IDS) {
      const f = { invariant, botId };
      if (failing.has(`${invariant}:${botId}`)) continue;
      await store.drop(keyOf("seen", f));
      if (!(await store.has(keyOf("active", f)))) continue;
      if (!(await store.claim(keyOf("ok", f), PROD_INVARIANTS.throttleMs))) continue;
      await store.drop(keyOf("active", f));
      out.push({ type: "team_invariant", invariant, botId, status: "resolved", detail: "" });
    }
  return out;
}

/** Đọc dữ liệu cần thiết từ DB (chỉ bot trong phạm vi, không quét cả bảng lệnh / fill). */
export async function loadSnapshots(
  db: Db,
  now: number,
  stepOf: (market: string) => string | null,
): Promise<BotSnapshot[]> {
  const since = new Date(now - PROD_INVARIANTS.stoppedWindowMs);
  const rows = await db
    .select({ b: bots, runtime: botRuntime.state, config: botVersions.config })
    .from(bots)
    .leftJoin(botRuntime, eq(botRuntime.botId, bots.id))
    .leftJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
    .where(
      or(
        inArray(bots.state, ["running", "stopping", "paused"]),
        and(inArray(bots.state, ["stopped", "archived"]), gte(bots.updatedAt, since)),
      ),
    );
  if (rows.length === 0) return [];
  const stoppingIds = rows
    .filter((r) => ["stopping", "stopped", "archived"].includes(r.b.state))
    .map((r) => r.b.id);
  const opening =
    stoppingIds.length === 0
      ? []
      : await db
          .select({ botId: orders.botId, n: sql<number>`count(*)::int` })
          .from(orders)
          .innerJoin(bots, eq(bots.id, orders.botId))
          .where(
            and(
              inArray(orders.botId, stoppingIds),
              eq(orders.reduceOnly, false),
              not(sql`${orders.tag} like 'close%'`),
              gt(orders.createdAt, bots.updatedAt),
            ),
          )
          .groupBy(orders.botId);
  const open =
    stoppingIds.length === 0
      ? []
      : await db
          .select({ botId: orders.botId, n: sql<number>`count(*)::int` })
          .from(orders)
          .where(
            and(
              inArray(orders.botId, stoppingIds),
              inArray(orders.status, ["open", "partially_filled", "unknown"]),
            ),
          )
          .groupBy(orders.botId);
  const mmIds = rows
    .filter(
      (r) => r.b.strategy === Strategy.volumeMaker && ["running", "paused"].includes(r.b.state),
    )
    .map((r) => r.b.id);
  const nets =
    mmIds.length === 0
      ? []
      : await db
          .select({
            botId: orders.botId,
            net: sql<string>`coalesce(sum(case when ${orders.side} = 'buy' then ${fills.size} else -${fills.size} end), 0)::text`,
          })
          .from(fills)
          .innerJoin(orders, eq(orders.id, fills.orderId))
          .where(inArray(orders.botId, mmIds))
          .groupBy(orders.botId);
  const count = (list: { botId: string; n: number }[], id: string) =>
    list.find((x) => x.botId === id)?.n ?? 0;
  return rows.map((r) => ({
    id: r.b.id,
    strategy: r.b.strategy,
    market: r.b.market,
    state: r.b.state,
    updatedAt: r.b.updatedAt.getTime(),
    config: (r.config ?? null) as Record<string, unknown> | null,
    runtime: (r.runtime ?? null) as Record<string, unknown> | null,
    openingAfterStop: count(opening, r.b.id),
    stillOpen: count(open, r.b.id),
    filledNet: mmIds.includes(r.b.id) ? (nets.find((x) => x.botId === r.b.id)?.net ?? "0") : null,
    stepSize: stepOf(r.b.market),
  }));
}

/** Một lượt kiểm tra; trả số tin đã ghi outbox và thời gian chạy (để log). */
export async function checkProdInvariants(
  db: Db,
  store: InvariantStore,
  now: number,
  stepOf: (market: string) => string | null,
): Promise<{ bots: number; findings: number; queued: number; ms: number }> {
  const started = Date.now();
  const snaps = await loadSnapshots(db, now, stepOf);
  const findings = snaps.flatMap((s) => findingsOf(s, now));
  const events = await decide(
    store,
    snaps.map((s) => s.id),
    findings,
  );
  for (const e of events) await db.insert(outbox).values({ topic: "jobs.team_ops", payload: e });
  return {
    bots: snaps.length,
    findings: findings.length,
    queued: events.length,
    ms: Date.now() - started,
  };
}
