import {
  bots,
  notifications,
  notificationSettings,
  outbox,
  sodexAccounts,
  telegramLinks,
  users,
  type Db,
} from "@drift/db";
import {
  teamIncidentCountKey,
  teamIncidentThrottle,
  teamMaskAddress,
  teamMaskEmail,
  NOTIFICATION_DEFAULTS,
  TEAM_INCIDENT_RULES,
  TEAM_INCIDENT_SEVERITY,
  teamOpsEventSchema,
  UserRole,
  type TeamOpsEvent,
} from "@drift/shared";
import { and, eq, inArray } from "drizzle-orm";

import { subjectFor } from "./telegram";

// Báo team qua Telegram (docs/NOTIFICATIONS.md mục 13, DEC-184): một sự kiện → một tin cho mỗi thành viên role `team`
// có Telegram `active` và bật nhóm `teamOps` (mặc định bật). Email / ví che NGAY lúc fan-out: bản đầy đủ không vào
// bảng notifications của team. Không báo hoạt động của chính tài khoản team, không báo bot tiền ảo. Gửi qua worker
// Telegram hiện có (giới hạn tốc độ, gửi lại, 403 → blocked); worker kiểm tra lại role lúc gửi.

export const TEAM_OPS_SUBJECT = "jobs.team_ops";

interface Subject {
  data: Record<string, string | number | null>;
}

/**
 * Redis cho sự cố tiền thật (#241): chặn lặp bằng SET NX PX (như DEC-225) và bộ đếm theo giờ cho tin tổng hợp.
 */
export interface IncidentStore {
  /** Đặt khoá nếu chưa có, hết hạn sau `ms`; true = vừa đặt (được gửi). */
  claim(key: string, ms: number): Promise<boolean>;
  /** Nhả khoá chặn lặp (ghi fan-out lỗi: lần giao lại vẫn gửi được). */
  release(key: string): Promise<void>;
  /** Tăng bộ đếm, đặt hạn nếu mới. */
  incr(key: string, ttlMs: number): Promise<void>;
}

export function redisIncidentStore(redis: {
  set(key: string, value: string, px: "PX", ms: number, nx: "NX"): Promise<string | null>;
  del(key: string): Promise<number>;
  multi(): {
    incr(key: string): unknown;
    pexpire(key: string, ms: number, nx: "NX"): unknown;
    exec(): Promise<unknown>;
  };
}): IncidentStore {
  return {
    async claim(key, ms) {
      return (await redis.set(key, "1", "PX", ms, "NX")) === "OK";
    },
    async release(key) {
      await redis.del(key);
    },
    async incr(key, ttlMs) {
      const m = redis.multi();
      m.incr(key);
      m.pexpire(key, ttlMs, "NX");
      await m.exec();
    },
  };
}

/** Dữ liệu (đã che) của sự kiện; null = không báo (tài khoản team, bot paper, không tìm thấy). */
async function subjectOf(db: Db, e: TeamOpsEvent): Promise<Subject | null> {
  // Theo dõi MCP (DEC-225): chỉ số đếm; daily limit thì email đã che, tối đa 3. Không bao giờ token id /
  // client id.
  if (e.type === "team_mcp_tool_errors")
    return { data: { calls: e.calls, errors: e.errors, pct: e.pct, tool: e.tool } };
  if (e.type === "team_mcp_introspect_failing") return { data: { failures: e.failures } };
  // Sự cố tiền thật (#241): bot id (cho link), chiến lược, market, số liệu ngắn. Không email / ví đầy đủ / key / tên bot.
  if (e.type === "team_incident") {
    const b =
      e.botId === undefined
        ? undefined
        : (
            await db
              .select({ strategy: bots.strategy, market: bots.market, userId: bots.userId })
              .from(bots)
              .where(eq(bots.id, e.botId))
              .limit(1)
          )[0];
    return {
      data: {
        kind: e.kind,
        severity: TEAM_INCIDENT_SEVERITY[e.kind],
        botId: e.botId ?? null,
        // Chủ bot (id, không email): link trang Users › chi tiết (team không mở được trang bot của user).
        userId: b?.userId ?? null,
        strategy: b?.strategy ?? null,
        market: e.market ?? b?.market ?? null,
        detail: e.detail,
      },
    };
  }
  if (e.type === "team_incident_digest") return { data: e.counts };
  // Signal research (#311): chỉ tên market SoDEX và version asset map, không có dữ liệu người dùng.
  if (e.type === "team_sr_new_market")
    return {
      data: { markets: e.markets.join(", "), total: e.total, version: e.assetMapVersion },
    };
  // Bất biến tiền thật (DEC-274): báo cả bot paper (ghi rõ mode); không ví / key / email.
  if (e.type === "team_invariant") {
    const [b] = await db
      .select({ strategy: bots.strategy, market: bots.market, mode: bots.mode })
      .from(bots)
      .where(eq(bots.id, e.botId))
      .limit(1);
    if (b === undefined) return null;
    return {
      data: {
        invariant: e.invariant,
        status: e.status,
        strategy: b.strategy,
        market: b.market,
        mode: b.mode,
        bot: `··${e.botId.slice(-8)}`,
        detail: e.detail,
      },
    };
  }
  if (e.type === "team_mcp_daily_limit") {
    const rows = await db
      .select({ email: users.email, role: users.role })
      .from(users)
      .where(inArray(users.id, e.userIds));
    const shown = rows.filter((r) => r.role !== UserRole.team);
    if (shown.length === 0) return null;
    return {
      data: {
        count: shown.length,
        emails: shown
          .slice(0, 3)
          .map((r) => teamMaskEmail(r.email))
          .join(", "),
      },
    };
  }
  const userOf = async (id: string) =>
    (
      await db
        .select({ email: users.email, role: users.role })
        .from(users)
        .where(eq(users.id, id))
        .limit(1)
    )[0];
  if (e.type === "team_bot_started") {
    const [b] = await db
      .select({
        name: bots.name,
        strategy: bots.strategy,
        market: bots.market,
        mode: bots.mode,
        userId: bots.userId,
      })
      .from(bots)
      .where(eq(bots.id, e.botId))
      .limit(1);
    if (b?.mode !== "live") return null;
    const u = await userOf(b.userId);
    if (u === undefined || u.role === UserRole.team) return null;
    return {
      data: {
        email: teamMaskEmail(u.email),
        botName: b.name,
        strategy: b.strategy,
        market: b.market,
        capital: e.capital,
        capitalAsset: e.capitalAsset,
      },
    };
  }
  const u = await userOf(e.userId);
  if (u === undefined || u.role === UserRole.team) return null;
  if (e.type === "team_signup") return { data: { email: teamMaskEmail(u.email) } };
  const [a] = await db
    .select({ address: sodexAccounts.address })
    .from(sodexAccounts)
    .where(eq(sodexAccounts.id, e.sodexAccountId))
    .limit(1);
  return {
    data: {
      email: teamMaskEmail(u.email),
      wallet: a === undefined ? null : teamMaskAddress(a.address),
    },
  };
}

export interface TeamOpsDeps {
  db: Db;
  telegramEnabled: boolean;
  /** Chặn lặp + bộ đếm của sự cố (#241). Không truyền thì không chặn lặp, không đếm. */
  incidents?: IncidentStore;
  now?: () => number;
  warn?: (msg: string, data: Record<string, unknown>) => void;
}

export async function handleTeamOps(deps: TeamOpsDeps, raw: unknown): Promise<number> {
  const e = teamOpsEventSchema.parse(raw);
  if (e.type !== "team_incident" || deps.incidents === undefined) {
    if (!deps.telegramEnabled) return 0;
    return fanOut(deps, e);
  }
  // Sự cố (#241): đếm mọi lần (kể cả bị chặn lặp) cho tin tổng hợp, rồi chặn lặp theo loại / bot. Redis lỗi thì vẫn gửi
  // (báo thừa hơn báo thiếu), không bao giờ ném vì Redis.
  const store = deps.incidents;
  const hour = Math.floor((deps.now?.() ?? Date.now()) / 3_600_000);
  try {
    await store.incr(teamIncidentCountKey(hour, e.kind), TEAM_INCIDENT_RULES.countTtlMs);
  } catch (error) {
    deps.warn?.("team incident count failed", { err: String(error), kind: e.kind });
  }
  if (!deps.telegramEnabled) return 0;
  // Lệch vị thế / khớp lại không bao giờ bị chặn lặp (engine phát mỗi lần chuyển một lần).
  const t = teamIncidentThrottle(e);
  if (t === null) return fanOut(deps, e);
  let claimed = false;
  try {
    if (!(await store.claim(t.key, t.ms))) return 0;
    claimed = true;
  } catch (error) {
    deps.warn?.("team incident throttle failed", { err: String(error), kind: e.kind });
  }
  try {
    return await fanOut(deps, e);
  } catch (error) {
    if (claimed) await store.release(t.key).catch(() => undefined);
    throw error;
  }
}

async function fanOut(deps: TeamOpsDeps, e: TeamOpsEvent): Promise<number> {
  const subject = await subjectOf(deps.db, e);
  if (subject === null) return 0;
  // Thành viên team có Telegram đang hoạt động.
  const members = await deps.db
    .select({ id: users.id })
    .from(users)
    .innerJoin(telegramLinks, eq(telegramLinks.userId, users.id))
    .where(and(eq(users.role, UserRole.team), eq(telegramLinks.status, "active")));
  if (members.length === 0) return 0;
  const ids = members.map((m) => m.id);
  const off = await deps.db
    .select({ userId: notificationSettings.userId, enabled: notificationSettings.enabled })
    .from(notificationSettings)
    .where(
      and(
        inArray(notificationSettings.userId, ids),
        eq(notificationSettings.type, "teamOps"),
        eq(notificationSettings.channel, "telegram"),
      ),
    );
  const on = ids.filter(
    (id) => off.find((s) => s.userId === id)?.enabled ?? NOTIFICATION_DEFAULTS.teamOps.telegram,
  );
  if (on.length === 0) return 0;
  await deps.db.transaction(async (tx) => {
    const rows = await tx
      .insert(notifications)
      .values(
        on.map((userId) => ({
          userId,
          type: e.type,
          payload: subject.data,
          channel: "telegram" as const,
          deliveryStatus: "queued" as const,
          // Không hiện trong danh sách in-app (chỉ đọc `channel = in_app`).
          readAt: new Date(),
        })),
      )
      .returning({ id: notifications.id });
    if (rows.length > 0)
      await tx
        .insert(outbox)
        .values(
          rows.map((r) => ({ topic: subjectFor(e.type), payload: { notificationId: r.id } })),
        );
  });
  return on.length;
}
