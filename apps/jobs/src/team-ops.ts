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
  teamMaskAddress,
  teamMaskEmail,
  NOTIFICATION_DEFAULTS,
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

/** Dữ liệu (đã che) của sự kiện; null = không báo (tài khoản team, bot paper, không tìm thấy). */
async function subjectOf(db: Db, e: TeamOpsEvent): Promise<Subject | null> {
  // Theo dõi MCP (DEC-TBD-mcp-monitoring): chỉ số đếm; daily limit thì email đã che, tối đa 3. Không bao giờ token id /
  // client id.
  if (e.type === "team_mcp_tool_errors")
    return { data: { calls: e.calls, errors: e.errors, pct: e.pct, tool: e.tool } };
  if (e.type === "team_mcp_introspect_failing") return { data: { failures: e.failures } };
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

export async function handleTeamOps(
  deps: { db: Db; telegramEnabled: boolean },
  raw: unknown,
): Promise<number> {
  if (!deps.telegramEnabled) return 0;
  const e = teamOpsEventSchema.parse(raw);
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
