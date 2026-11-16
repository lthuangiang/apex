import {
  botEvents,
  botRuntime,
  bots,
  botVersions,
  fills,
  orders,
  outbox,
  type Db,
} from "@drift/db";
import { dec, Decimal, Strategy, type TeamOpsEvent } from "@drift/shared";
import { and, eq, gt, gte, inArray, lte, not, or, sql } from "drizzle-orm";

// Bất biến tiền thật trên prod (DEC-274; DevOps chọn theo ủy quyền, chờ người dùng xác nhận). Mỗi
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
  /**
   * P4: lệnh của bot MM sống ngắn; lần đọc tiếp theo chỉ xét lệnh tạo trong chừng này trước mốc lần trước (fill mới của
   * lệnh cũ hơn thì không thấy; chấp nhận vì lệnh MM được làm mới mỗi vài giây).
   */
  p4OrderLagMs: 86_400_000,
  /** P4: mốc lưu lùi lại chừng này so với đồng hồ DB (fill commit trễ / đồng hồ engine lệch vẫn được cộng sau). */
  p4CommitLagMs: 60_000,
  /** P4: mốc tổng fill của một version giữ trong Redis chừng này (làm mới mỗi lượt). */
  p4WatermarkMs: 2 * 86_400_000,
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
  /** Khoá Redis thay cho botId (tin gộp P5 dùng khoá cố định, để đổi bot đầu tiên không làm báo / resolved lại). */
  key?: string;
  /** Vẫn tính là sai (giữ trạng thái từng bot) nhưng không gửi tin riêng: P5 từng bot khi đã gộp. */
  quiet?: boolean;
}

/** Khoá cố định của tin gộp P5. */
export const MASS_STALE_KEY = "mm-group";

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
  /** P4: SoDEX đã được lấy làm vị thế chuẩn ("Position re-synced") trong version này: sổ cái cố ý khác tổng fill. */
  resynced: boolean;
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
  if (mm && !b.resynced && position !== null && b.filledNet !== null && b.stepSize !== null) {
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
 * Nhiều bot MM cùng không báo giá (SoDEX sập, engine backoff): gộp P5 thành một tin (khoá cố định, tin ghi bot đầu
 * tiên), không báo hàng loạt. P5 từng bot vẫn giữ, đánh dấu `quiet`: vẫn là "đang sai" (không gửi "resolved") nhưng
 * không gửi tin riêng.
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
    ...stale.map((f) => ({ ...f, quiet: true })),
    {
      invariant: "P5",
      botId: first.botId,
      key: MASS_STALE_KEY,
      detail: `${String(stale.length)} of ${String(quotingBots)} Market Making bots not quoting (possible SoDEX or engine issue)`,
    },
  ];
}

/** Redis cho bất biến: đánh dấu có hạn, khoá chặn lặp (NX), và tập các bất biến đang báo. */
export interface InvariantStore {
  has(key: string): Promise<boolean>;
  mark(key: string, ms: number): Promise<void>;
  drop(key: string): Promise<void>;
  /** Tập "bất biến:bot" đã báo mà chưa resolved (bền qua restart). */
  active(): Promise<string[]>;
  addActive(member: string): Promise<void>;
  /** true = vừa xoá (có trong tập). */
  removeActive(member: string): Promise<boolean>;
  /** Giá trị có hạn (mốc P4). */
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ms: number): Promise<void>;
}

const ACTIVE_SET = "team:invariant:active";

export function redisInvariantStore(redis: {
  exists(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, px: "PX", ms: number): Promise<unknown>;
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
    active: () => redis.smembers(ACTIVE_SET),
    async addActive(member) {
      await redis.sadd(ACTIVE_SET, member);
    },
    async removeActive(member) {
      return (await redis.srem(ACTIVE_SET, member)) > 0;
    },
    get: (key) => redis.get(key),
    async put(key, value, ms) {
      await redis.set(key, value, "PX", ms);
    },
  };
}

const keyOf = (kind: "seen" | "alert" | "ok", invariant: string, key: string) =>
  `team:invariant:${kind}:${invariant}:${key}`;
const keyFor = (f: Finding) => f.key ?? f.botId;
/** Phần tử của tập đang báo: "bất biến:khoá:bot" (khoá = bot, trừ tin gộp). */
const memberOf = (f: Finding) => `${f.invariant}:${keyFor(f)}:${f.botId}`;

/** Tin cần gửi; trạng thái Redis chỉ đổi (`commit`) sau khi đã ghi outbox. */
export interface Decision {
  event: TeamOpsEvent;
  /** Khoá chặn lặp 30 phút, đặt sau khi ghi outbox. */
  throttleKey: string;
  /** Phần tử tập đang báo: thêm khi `failing`, bỏ khi `resolved`. */
  member: string;
}

/**
 * Lọc kết quả của một lượt thành tin cần gửi: sai 2 lần liền mới báo (1 / 30 phút); bất biến đang báo mà nay đúng,
 * hoặc bot không còn được xét, thì báo "resolved" (1 / 30 phút). `botIds`: mọi bot đã xét trong lượt này. Chỉ đổi dấu
 * "sai ở lần trước"; khoá chặn lặp và tập đang báo đổi ở `commit`, sau khi tin đã vào outbox (ghi lỗi thì lượt sau gửi
 * lại, không mất tin).
 */
export async function decide(
  store: InvariantStore,
  botIds: readonly string[],
  findings: readonly Finding[],
): Promise<Decision[]> {
  const out: Decision[] = [];
  const failing = new Set(findings.map((f) => `${f.invariant}:${keyFor(f)}`));
  for (const f of findings) {
    const seen = keyOf("seen", f.invariant, keyFor(f));
    const seenBefore = await store.has(seen);
    await store.mark(seen, PROD_INVARIANTS.seenMs);
    if (!seenBefore || f.quiet === true) continue;
    const throttleKey = keyOf("alert", f.invariant, keyFor(f));
    if (await store.has(throttleKey)) continue;
    out.push({
      event: {
        type: "team_invariant",
        invariant: f.invariant,
        botId: f.botId,
        detail: f.detail,
        status: "failing",
      },
      throttleKey,
      member: memberOf(f),
    });
  }
  // Đúng ở lượt này: xoá dấu "sai ở lần trước", để một lần sai lẻ không cộng với lần sai sau.
  for (const botId of botIds)
    for (const invariant of INVARIANT_IDS)
      if (!failing.has(`${invariant}:${botId}`)) await store.drop(keyOf("seen", invariant, botId));
  if (!failing.has(`P5:${MASS_STALE_KEY}`)) await store.drop(keyOf("seen", "P5", MASS_STALE_KEY));
  const checked = new Set(botIds);
  for (const member of await store.active()) {
    const [invariant = "", key = "", botId = key] = member.split(":");
    if (failing.has(`${invariant}:${key}`)) continue;
    await store.drop(keyOf("seen", invariant, key));
    const throttleKey = keyOf("ok", invariant, key);
    if (await store.has(throttleKey)) continue;
    out.push({
      event: {
        type: "team_invariant",
        invariant: invariant as InvariantId,
        botId,
        status: "resolved",
        detail: key === MASS_STALE_KEY || checked.has(botId) ? "" : "no longer checked",
      },
      throttleKey,
      member,
    });
  }
  return out;
}

/** Sau khi tin đã vào outbox: đặt khoá chặn lặp và cập nhật tập đang báo. */
export async function commit(store: InvariantStore, d: Decision): Promise<void> {
  await store.mark(d.throttleKey, PROD_INVARIANTS.throttleMs);
  if (d.event.type !== "team_invariant") return;
  if (d.event.status === "failing") await store.addActive(d.member);
  else await store.removeActive(d.member);
}

/**
 * Mốc dừng từ các lần đổi trạng thái của một bot (`starting` / `stopping` / `stopped`): lần dừng đầu tiên sau lần
 * `starting` gần nhất; null khi chưa dừng từ lần Start đó.
 */
export function stopTimeOf(rows: readonly { state: string; at: number }[]): number | null {
  const started = Math.max(
    -Infinity,
    ...rows.filter((x) => x.state === "starting").map((x) => x.at),
  );
  const stops = rows.filter((x) => x.state !== "starting" && x.at >= started).map((x) => x.at);
  return stops.length === 0 ? null : Math.min(...stops);
}

/** Đọc dữ liệu cần thiết từ DB (chỉ bot trong phạm vi; lệnh / fill chặn theo thời gian). */
export async function loadSnapshots(
  db: Db,
  now: number,
  store: Pick<InvariantStore, "get" | "put">,
): Promise<BotSnapshot[]> {
  const since = new Date(now - PROD_INVARIANTS.stoppedWindowMs);
  const rows = await db
    .select({
      b: bots,
      runtime: botRuntime.state,
      runtimeAt: botRuntime.updatedAt,
      config: botVersions.config,
      appliedAt: botVersions.appliedAt,
      versionId: botVersions.id,
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
  // Mốc dừng: dòng outbox `user.<account>.bot` mà API (Stop) hoặc engine (chiến lược dừng) ghi trong cùng transaction
  // với lần đổi trạng thái. `bots.updated_at` không dùng được (đổi ở mọi lần ghi). Lấy lần `stopping` / `stopped` đầu
  // tiên sau lần `starting` gần nhất: bot đã Start lại thì lần Stop cũ không còn là mốc (dừng thẳng sang `stopped`, không
  // qua `stopping`, cũng là mốc).
  const transitions =
    stoppingIds.length === 0
      ? []
      : await db
          .select({
            botId: sql<string>`${outbox.payload}->>'botId'`,
            state: sql<string>`${outbox.payload}->>'state'`,
            at: outbox.createdAt,
          })
          .from(outbox)
          .where(
            and(
              sql`${outbox.topic} like 'user.%.bot'`,
              sql`${outbox.payload}->>'state' in ('starting', 'stopping', 'stopped')`,
              inArray(sql<string>`${outbox.payload}->>'botId'`, stoppingIds),
              gte(outbox.createdAt, new Date(now - PROD_INVARIANTS.openOrderAgeMs)),
            ),
          );
  const stopAtOf = (id: string) =>
    stopTimeOf(
      transitions
        .filter((x) => x.botId === id)
        .map((x) => ({ state: x.state, at: x.at.getTime() })),
    );
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
  // P4: tổng fill của version đang chạy (sổ cái của engine tính từ lúc version bắt đầu), chỉ fill đã ghi trước lần engine
  // lưu sổ cái (fill ghi sau đó chưa vào sổ cái, không phải lệch). Không đọc lại cả version mỗi phút: mốc
  // (tổng tới thời điểm nào) giữ trong Redis theo version, lượt sau chỉ cộng fill mới.
  const nets: { botId: string; net: string; decimals: number; resynced: boolean }[] = [];
  for (const r of mm) {
    const from = r.appliedAt ?? new Date(now - PROD_INVARIANTS.openOrderAgeMs);
    if (r.runtimeAt === null) continue;
    // SoDEX đã được lấy làm vị thế chuẩn trong version này (volume-maker `positionSync`): sổ cái cố ý khác tổng fill.
    const [resync] = await db
      .select({ id: botEvents.id })
      .from(botEvents)
      .where(
        and(
          eq(botEvents.botId, r.b.id),
          eq(botEvents.decision, "Position re-synced from SoDEX"),
          gte(botEvents.occurredAt, from),
        ),
      )
      .limit(1);
    const x = await p4FilledNet(db, store, {
      botId: r.b.id,
      versionId: r.versionId,
      from,
      upTo: r.runtimeAt,
      now,
    });
    nets.push({ botId: r.b.id, ...x, resynced: resync !== undefined });
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
      resynced: n?.resynced ?? false,
      stepSize:
        n === undefined || n.decimals < 0 ? null : new Decimal(10).pow(-n.decimals).toString(),
    };
  });
}

/** Mốc P4 trong Redis: tổng fill (mua − bán) tới `at`, và số chữ số thập phân lớn nhất của khối lượng lệnh. */
interface P4Watermark {
  at: number;
  net: string;
  decimals: number;
}

const p4Key = (botId: string, versionId: string | null) =>
  `team:invariant:p4:${botId}:${versionId ?? "none"}`;

/**
 * Tổng fill của version tới `upTo`. Lần đầu (hoặc mất mốc) đọc cả version một lần; các lượt sau chỉ đọc fill ghi sau mốc,
 * của lệnh tạo trong `p4OrderLagMs` trước mốc. Mốc lưu lùi lại `p4CommitLagMs` so với đồng hồ DB: fill có created_at sớm
 * nhưng commit trễ (hoặc đồng hồ engine lệch) vẫn được cộng ở lượt sau, không bị bỏ vĩnh viễn. Mỗi lượt cộng lại phần đuôi
 * sau mốc.
 */
export async function p4FilledNet(
  db: Db,
  store: Pick<InvariantStore, "get" | "put">,
  q: { botId: string; versionId: string | null; from: Date; upTo: Date; now: number },
): Promise<{ net: string; decimals: number }> {
  const key = p4Key(q.botId, q.versionId);
  const saved = await store.get(key);
  let wm: P4Watermark | null = null;
  if (saved !== null) {
    try {
      const v = JSON.parse(saved) as Partial<P4Watermark>;
      if (typeof v.at === "number" && typeof v.net === "string" && typeof v.decimals === "number")
        wm = { at: v.at, net: v.net, decimals: v.decimals };
    } catch {
      wm = null;
    }
  }
  const upTo = q.upTo.getTime();
  const base = wm?.at ?? null;
  // Mốc mới: không vượt sổ cái của engine, và lùi lại một biên so với đồng hồ DB.
  const safe = Math.min(upTo, q.now - PROD_INVARIANTS.p4CommitLagMs);
  const lo = base === null ? null : Math.min(base, upTo);
  const ordersFrom =
    lo === null ? q.from : new Date(Math.max(q.from.getTime(), lo - PROD_INVARIANTS.p4OrderLagMs));
  const signed = sql`case when ${orders.side} = 'buy' then ${fills.size} else -${fills.size} end`;
  const [x] = await db
    .select({
      // Fill trong (mốc, upTo]: cộng vào; fill trong (upTo, mốc] (sổ cái cũ hơn mốc): trừ ra.
      tail: sql<string>`coalesce(sum(case when ${fills.createdAt} <= ${q.upTo} then ${signed} else -(${signed}) end), 0)::text`,
      // Phần tới mốc mới (để lưu).
      safe: sql<string>`coalesce(sum(case when ${fills.createdAt} <= ${new Date(safe)} and ${fills.createdAt} <= ${q.upTo} then ${signed} else 0 end), 0)::text`,
      decimals: sql<number>`coalesce(max(length(rtrim(split_part(${orders.size}::text, '.', 2), '0'))), -1)::int`,
    })
    .from(orders)
    .leftJoin(
      fills,
      and(
        eq(fills.orderId, orders.id),
        ...(base === null
          ? [lte(fills.createdAt, q.upTo)]
          : upTo >= base
            ? [gt(fills.createdAt, new Date(base)), lte(fills.createdAt, q.upTo)]
            : [gt(fills.createdAt, q.upTo), lte(fills.createdAt, new Date(base))]),
      ),
    )
    .where(and(eq(orders.botId, q.botId), gte(orders.createdAt, ordersFrom)));
  const decimals = Math.max(wm?.decimals ?? -1, x?.decimals ?? -1);
  const net = dec(wm?.net ?? "0").add(x?.tail ?? "0");
  if (base === null || safe > base)
    await store.put(
      key,
      JSON.stringify({
        at: safe,
        net: dec(wm?.net ?? "0")
          .add(x?.safe ?? "0")
          .toString(),
        decimals,
      } satisfies P4Watermark),
      PROD_INVARIANTS.p4WatermarkMs,
    );
  return { net: net.toString(), decimals };
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
  const snaps = await loadSnapshots(db, now, store);
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
    // Ghi outbox trước rồi mới đổi Redis: ghi lỗi thì Redis chưa đổi, lượt sau gửi lại. Redis lỗi sau khi đã ghi thì
    // lượt sau có thể gửi trùng một tin (chấp nhận: thà trùng còn hơn mất).
    await db.insert(outbox).values({ topic: "jobs.team_ops", payload: d.event });
    queued += 1;
    await commit(store, d);
  }
  return { bots: snaps.length, findings: findings.length, queued, ms: Date.now() - started };
}
