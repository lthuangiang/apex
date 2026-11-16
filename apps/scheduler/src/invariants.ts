import { botRuntime, bots, botVersions, fills, orders, outbox, type Db } from "@drift/db";
import { dec, Decimal, Strategy, type TeamOpsEvent } from "@drift/shared";
import { and, eq, gte, inArray, not, or, sql } from "drizzle-orm";

// Bất biến tiền thật trên prod (DEC-TBD-prod-invariants; DevOps chọn theo ủy quyền, chờ người dùng xác nhận). Mỗi
// phút, chỉ đọc DB: không gọi SoDEX, không tự sửa, không đặt lệnh. Một bất biến sai ở 2 lần kiểm tra liền nhau
// (≥ 2 phút) mới báo `jobs.team_ops`; mỗi (bất biến, bot) tối đa 1 tin / 30 phút; đúng trở lại, hoặc bot không còn
// được xét, thì 1 tin "resolved". Chỉ xét bot running / stopping / paused và bot dừng trong 1 giờ qua. Mọi so sánh
// thời gian dùng đồng hồ của DB. Tin không chứa ví / key.

export const PROD_INVARIANTS = {
  /** P1: (max inventory + một lệnh) × 1.05; lệnh cuối có thể vượt max tối đa một lệnh (thiết kế). */
  positionTolerance: "1.05",
  /** P2 / P3: bot dừng trong chừng này thì còn xét. */
  stoppedWindowMs: 3_600_000,
  /** P3: lệnh còn mở quá chừng này sau khi bot dừng. */
  openAfterStopMs: 60_000,
  /** P3: chỉ xét lệnh tạo trong chừng này (chặn quét cả bảng lệnh). */
  openOrderAgeMs: 7 * 86_400_000,
  /** P5: không báo giá quá refreshSeconds + chừng này. */
  quoteGapExtraMs: 30_000,
  /** P5: bỏ qua bot vừa cắt vị thế (đang giữ phía tăng vị thế, DEC-TBD-mm-cut-hold). */
  cutHoldMs: 60_000,
  /** P5: từ chừng này bot (và ≥ một nửa bot MM đang chạy) cùng đứng thì gộp thành một tin (SoDEX / engine). */
  massStaleMin: 3,
  /** P7: bot ở `stopping` quá chừng này (đang chờ đối soát lệnh unknown, #154). */
  stoppingMaxMs: 5 * 60_000,
  /** Đánh dấu "sai ở lần trước"; > 1 phút để lần kế tiếp còn thấy. */
  seenMs: 150_000,
  throttleMs: 30 * 60_000,
} as const;

export type InvariantId = "P1" | "P2" | "P3" | "P4" | "P5" | "P7";
export const INVARIANT_IDS: readonly InvariantId[] = ["P1", "P2", "P3", "P4", "P5", "P7"];

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
  mode: "live" | "paper";
  /** Lúc bot vào `stopping` (Stop của người dùng hoặc chiến lược dừng), từ outbox; null khi không biết. */
  stopAt: number | null;
  config: Record<string, unknown> | null;
  runtime: Record<string, unknown> | null;
  /** P2: lệnh mở vị thế tạo sau mốc Stop. */
  openingAfterStop: number;
  /** P3: lệnh còn open / partially_filled / unknown. */
  stillOpen: number;
  /** P4: Σ fill (mua − bán) từ lúc version đang chạy bắt đầu; null khi không xét. */
  filledNet: string | null;
  /**
   * P4: sai số cho phép = một đơn vị ở độ chính xác của khối lượng lệnh của bot (engine làm tròn khối lượng theo step
   * size, nên đây là step hoặc nhỏ hơn); null khi không có lệnh (không xét).
   */
  stepSize: string | null;
}

const usd = (v: Decimal) =>
  `${v.toDecimalPlaces(0).toNumber().toLocaleString("en-US", { maximumFractionDigits: 0 })} USDC`;
const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null;

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

/** P5 có xét bot này không (bot MM thật đang chạy). */
const quoting = (b: BotSnapshot) =>
  b.strategy === Strategy.volumeMaker && b.mode === "live" && b.state === "running";

/** Các bất biến sai của một bot lúc `now` (hàm thuần; so sánh bằng decimal). */
export function findingsOf(b: BotSnapshot, now: number): Finding[] {
  const out: Finding[] = [];
  const push = (invariant: InvariantId, detail: string) => {
    out.push({ invariant, botId: b.id, detail });
  };
  // P1 / P4 / P5 chỉ cho bot thật: fill paper không vào bảng fills (DEC-105). P2 / P3 / P7 xét cả paper.
  const mm = b.strategy === Strategy.volumeMaker && b.mode === "live";
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
  // P2: lệnh mở vị thế tới sau khi bot vào `stopping`.
  if (b.openingAfterStop > 0)
    push("P2", `${String(b.openingAfterStop)} opening order(s) placed after Stop`);
  // P3: bot đã dừng còn lệnh mở.
  if (
    (b.state === "stopped" || b.state === "archived") &&
    b.stopAt !== null &&
    now - b.stopAt > PROD_INVARIANTS.openAfterStopMs &&
    b.stillOpen > 0
  )
    push("P3", `${String(b.stillOpen)} order(s) still open after the bot stopped`);
  // P4: sổ cái của bot lệch tổng fill quá sai số.
  if (mm && position !== null && b.filledNet !== null && b.stepSize !== null) {
    const diff = dec(position).sub(b.filledNet).abs();
    if (diff.gt(b.stepSize))
      push("P4", `ledger position ${position} vs fills ${dec(b.filledNet).toString()}`);
  }
  // P5: bot Market Making đang chạy không báo giá lại, mà không có lý do chờ có chủ đích.
  if (quoting(b) && b.config !== null) {
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
  // P7: bot nằm ở `stopping` quá lâu (lệnh unknown chưa đối soát được, #154).
  if (b.state === "stopping" && b.stopAt !== null && now - b.stopAt > PROD_INVARIANTS.stoppingMaxMs)
    push("P7", `stopping for ${String(Math.round((now - b.stopAt) / 60_000))} min`);
  return out;
}

/**
 * Nhiều bot MM cùng không báo giá (SoDEX sập, engine backoff): gộp P5 thành một tin trên bot đầu tiên, không báo
 * hàng loạt.
 */
export function collapseMassStale(findings: Finding[], quotingBots: number): Finding[] {
  const stale = findings.filter((f) => f.invariant === "P5");
  const first = stale[0];
  if (
    first === undefined ||
    stale.length < PROD_INVARIANTS.massStaleMin ||
    stale.length * 2 < quotingBots
  )
    return findings;
  return [
    ...findings.filter((f) => f.invariant !== "P5"),
    {
      invariant: "P5",
      botId: first.botId,
      detail: `${String(stale.length)} of ${String(quotingBots)} Market Making bots not quoting (possible SoDEX or engine issue)`,
    },
  ];
}

/** Redis cho bất biến: đánh dấu có hạn, khoá chặn lặp (NX), và tập các bất biến đang báo. */
export interface InvariantStore {
  has(key: string): Promise<boolean>;
  mark(key: string, ms: number): Promise<void>;
  drop(key: string): Promise<void>;
  /** Đặt khoá nếu chưa có, hết hạn sau `ms`; true = vừa đặt (được gửi). */
  claim(key: string, ms: number): Promise<boolean>;
  /** Tập "bất biến:bot" đã báo mà chưa resolved (bền qua restart). */
  active(): Promise<string[]>;
  addActive(member: string): Promise<void>;
  /** true = vừa xoá (có trong tập). */
  removeActive(member: string): Promise<boolean>;
}

const ACTIVE_SET = "team:invariant:active";

export function redisInvariantStore(redis: {
  exists(key: string): Promise<number>;
  set(key: string, value: string, px: "PX", ms: number): Promise<unknown>;
  set(key: string, value: string, px: "PX", ms: number, nx: "NX"): Promise<string | null>;
  del(key: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
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
    active: () => redis.smembers(ACTIVE_SET),
    async addActive(member) {
      await redis.sadd(ACTIVE_SET, member);
    },
    async removeActive(member) {
      return (await redis.srem(ACTIVE_SET, member)) > 0;
    },
  };
}

const keyOf = (kind: "seen" | "alert" | "ok", f: { invariant: string; botId: string }) =>
  `team:invariant:${kind}:${f.invariant}:${f.botId}`;

/** Tin cần gửi kèm khoá chặn lặp đã giữ (để nhả nếu ghi outbox lỗi). */
export interface Decision {
  event: TeamOpsEvent;
  claimKey: string;
  /** Tin "resolved": khi ghi lỗi thì trả bất biến về tập đang báo. */
  member: string | null;
}

/**
 * Lọc kết quả của một lượt thành tin cần gửi: sai 2 lần liền mới báo (1 / 30 phút); bất biến đang báo mà nay đúng,
 * hoặc bot không còn được xét, thì báo "resolved" (1 / 30 phút). `botIds`: mọi bot đã xét trong lượt này.
 */
export async function decide(
  store: InvariantStore,
  botIds: readonly string[],
  findings: readonly Finding[],
): Promise<Decision[]> {
  const out: Decision[] = [];
  const failing = new Set(findings.map((f) => `${f.invariant}:${f.botId}`));
  for (const f of findings) {
    const seenBefore = await store.has(keyOf("seen", f));
    await store.mark(keyOf("seen", f), PROD_INVARIANTS.seenMs);
    if (!seenBefore) continue;
    const claimKey = keyOf("alert", f);
    if (!(await store.claim(claimKey, PROD_INVARIANTS.throttleMs))) continue;
    await store.addActive(`${f.invariant}:${f.botId}`);
    out.push({
      event: { type: "team_invariant", ...f, status: "failing" },
      claimKey,
      member: null,
    });
  }
  // Đúng ở lượt này: xoá dấu "sai ở lần trước", để một lần sai lẻ không cộng với lần sai sau.
  for (const botId of botIds)
    for (const invariant of INVARIANT_IDS)
      if (!failing.has(`${invariant}:${botId}`))
        await store.drop(keyOf("seen", { invariant, botId }));
  const checked = new Set(botIds);
  for (const member of await store.active()) {
    if (failing.has(member)) continue;
    const [invariant = "", botId = ""] = member.split(":");
    const f = { invariant, botId };
    await store.drop(keyOf("seen", f));
    const claimKey = keyOf("ok", f);
    if (!(await store.claim(claimKey, PROD_INVARIANTS.throttleMs))) continue;
    if (!(await store.removeActive(member))) continue;
    out.push({
      event: {
        type: "team_invariant",
        invariant: invariant as InvariantId,
        botId,
        status: "resolved",
        detail: checked.has(botId) ? "" : "no longer checked",
      },
      claimKey,
      member,
    });
  }
  return out;
}

/** Đọc dữ liệu cần thiết từ DB (chỉ bot trong phạm vi; lệnh / fill chặn theo thời gian). */
export async function loadSnapshots(db: Db, now: number): Promise<BotSnapshot[]> {
  const since = new Date(now - PROD_INVARIANTS.stoppedWindowMs);
  const rows = await db
    .select({
      b: bots,
      runtime: botRuntime.state,
      config: botVersions.config,
      appliedAt: botVersions.appliedAt,
    })
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
  // Mốc vào `stopping`: dòng outbox `user.<account>.bot` mà API (Stop) hoặc engine (chiến lược dừng) ghi trong cùng
  // transaction với lần đổi trạng thái. `bots.updated_at` không dùng được (đổi ở mọi lần ghi).
  const stops =
    stoppingIds.length === 0
      ? []
      : await db
          .selectDistinctOn([sql`${outbox.payload}->>'botId'`], {
            botId: sql<string>`${outbox.payload}->>'botId'`,
            at: outbox.createdAt,
          })
          .from(outbox)
          .where(
            and(
              sql`${outbox.topic} like 'user.%.bot'`,
              sql`${outbox.payload}->>'state' = 'stopping'`,
              inArray(sql<string>`${outbox.payload}->>'botId'`, stoppingIds),
              gte(outbox.createdAt, new Date(now - PROD_INVARIANTS.openOrderAgeMs)),
            ),
          )
          .orderBy(sql`${outbox.payload}->>'botId'`, sql`${outbox.createdAt} desc`);
  const stopAtOf = (id: string) => stops.find((s) => s.botId === id)?.at.getTime() ?? null;
  const recentOrders =
    stoppingIds.length === 0
      ? []
      : await db
          .select({ botId: orders.botId, createdAt: orders.createdAt })
          .from(orders)
          .where(
            and(
              inArray(orders.botId, stoppingIds),
              eq(orders.reduceOnly, false),
              not(sql`${orders.tag} like 'close%'`),
              gte(orders.createdAt, new Date(now - PROD_INVARIANTS.openOrderAgeMs)),
            ),
          );
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
              gte(orders.createdAt, new Date(now - PROD_INVARIANTS.openOrderAgeMs)),
            ),
          )
          .groupBy(orders.botId);
  const mm = rows.filter(
    (r) =>
      r.b.strategy === Strategy.volumeMaker &&
      r.b.mode === "live" &&
      ["running", "paused"].includes(r.b.state),
  );
  // P4: fill của version đang chạy (sổ cái của engine tính từ lúc version bắt đầu); chặn theo `orders.created_at`.
  const nets: { botId: string; net: string; decimals: number }[] = [];
  for (const r of mm) {
    const from = r.appliedAt ?? new Date(now - PROD_INVARIANTS.openOrderAgeMs);
    const [x] = await db
      .select({
        net: sql<string>`coalesce(sum(case when ${orders.side} = 'buy' then ${fills.size} else -${fills.size} end), 0)::text`,
        decimals: sql<number>`coalesce(max(length(rtrim(split_part(${orders.size}::text, '.', 2), '0'))), -1)::int`,
      })
      .from(orders)
      .leftJoin(fills, eq(fills.orderId, orders.id))
      .where(and(eq(orders.botId, r.b.id), gte(orders.createdAt, from)));
    if (x !== undefined) nets.push({ botId: r.b.id, net: x.net, decimals: x.decimals });
  }
  const count = (list: { botId: string; n: number }[], id: string) =>
    list.find((x) => x.botId === id)?.n ?? 0;
  return rows.map((r) => {
    const stopAt = stopAtOf(r.b.id);
    const n = nets.find((x) => x.botId === r.b.id);
    return {
      id: r.b.id,
      strategy: r.b.strategy,
      market: r.b.market,
      state: r.b.state,
      mode: r.b.mode,
      stopAt,
      config: (r.config ?? null) as Record<string, unknown> | null,
      runtime: (r.runtime ?? null) as Record<string, unknown> | null,
      openingAfterStop:
        stopAt === null
          ? 0
          : recentOrders.filter((o) => o.botId === r.b.id && o.createdAt.getTime() > stopAt).length,
      stillOpen: count(open, r.b.id),
      filledNet: n?.net ?? null,
      stepSize:
        n === undefined || n.decimals < 0 ? null : new Decimal(10).pow(-n.decimals).toString(),
    };
  });
}

/** Một lượt kiểm tra; trả số tin đã ghi outbox và thời gian chạy (để log). */
export async function checkProdInvariants(
  db: Db,
  store: InvariantStore,
): Promise<{ bots: number; findings: number; queued: number; ms: number }> {
  const started = Date.now();
  // Một đồng hồ cho mọi so sánh: của DB (cùng nguồn với created_at của lệnh / outbox).
  const clock = await db.execute<{ ms: string }>(
    sql`select (extract(epoch from now()) * 1000)::bigint::text as ms`,
  );
  const now = Number(clock.rows[0]?.ms ?? Date.now());
  const snaps = await loadSnapshots(db, now);
  const findings = collapseMassStale(
    snaps.flatMap((s) => findingsOf(s, now)),
    snaps.filter(quoting).length,
  );
  const decisions = await decide(
    store,
    snaps.map((s) => s.id),
    findings,
  );
  let queued = 0;
  for (const d of decisions) {
    try {
      await db.insert(outbox).values({ topic: "jobs.team_ops", payload: d.event });
      queued += 1;
    } catch (error) {
      // Ghi lỗi: nhả khoá chặn lặp (và trả bất biến về tập đang báo) để lượt sau gửi lại.
      await store.drop(d.claimKey);
      if (d.member !== null) await store.addActive(d.member);
      throw error;
    }
  }
  return { bots: snaps.length, findings: findings.length, queued, ms: Date.now() - started };
}
