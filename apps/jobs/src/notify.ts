import {
  bots,
  notifications,
  notificationSettings,
  sodexAccounts,
  users,
  type Db,
} from "@drift/db";
import {
  groupOf,
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_TYPES,
  ALWAYS_ON_GROUPS,
  type NotificationType,
} from "@drift/shared";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

// Consumer `jobs.notify` (DEC-41): ghi thông báo in-app và gửi email theo cài đặt của người dùng. Nhóm
// "bot errors" luôn bật cho in-app và email. Email chỉ có tóm tắt; chi tiết xem trong app.

export const notifyPayloadSchema = z.object({
  userId: z.uuid().optional(),
  sodexAccountId: z.uuid().optional(),
  type: z.enum(NOTIFICATION_TYPES),
  data: z.record(z.string(), z.unknown()).default({}),
});

export interface NotifyDeps {
  db: Db;
  sendEmail: ((to: string, subject: string, text: string) => Promise<void>) | null;
}

const REASON_TEXT: Record<string, string> = {
  BUILDER_FEE_REVOKED: "builder fee approval is 0",
  API_KEY_EXPIRED: "DRIFT API key expired",
  API_KEY_UNUSABLE: "DRIFT can't sign with your API key",
  API_KEY_DELETED: "DRIFT API key deleted",
  RISK_DAILY_LOSS: "daily loss limit reached",
  RISK_DRAWDOWN: "drawdown limit reached",
  BOT_MAX_LOSS: "max loss for this bot reached",
  ORDER_REJECTED: "SoDEX rejected an order",
  INSUFFICIENT_BALANCE: "balance too low",
  STOP_LOSS: "stop loss reached",
  TAKE_PROFIT: "take profit reached",
  EMERGENCY_HALT: "emergency halt",
  BUDGET_DONE: "budget used",
  MAX_CYCLES: "max cycles reached",
};

/** Câu chữ email (tiếng Anh). Bản nháp chờ duyệt (DEC-41). */
export function emailText(
  type: NotificationType,
  data: Record<string, unknown>,
  botName: string | null,
): { subject: string; text: string } {
  const bot = botName ?? "A bot";
  const reason = REASON_TEXT[typeof data.reasonCode === "string" ? data.reasonCode : ""] ?? "";
  switch (type) {
    case "bot_paused":
      return {
        subject: `DRIFT: ${bot} paused`,
        text: `${bot} was paused: ${reason}. Open orders were kept. Open DRIFT to review it.`,
      };
    case "bot_stopped":
      return {
        subject: `DRIFT: ${bot} stopped`,
        text: `${bot} stopped: ${reason}. Open DRIFT to review it.`,
      };
    case "unknown_order":
      return {
        subject: `DRIFT: order result unknown on ${bot}`,
        text: `SoDEX didn't confirm an order from ${bot}. DRIFT will not resend it until SoDEX confirms whether it exists.`,
      };
    case "risk_alert":
      return {
        subject: "DRIFT: risk limit reached",
        text: `A server-enforced risk limit was reached (${typeof data.kind === "string" ? data.kind : ""}). Running bots were paused. Open the Risk Center to review.`,
      };
    case "key_fee":
      return {
        subject: "DRIFT: SoDEX access changed",
        text: "Your DRIFT API key or builder fee approval changed. Open Settings to review.",
      };
    case "fill":
      return {
        subject: `DRIFT: ${bot} filled an order`,
        text: `${bot} filled an order. Open DRIFT for details.`,
      };
    case "daily_summary":
      return { subject: "DRIFT: daily summary", text: "Your daily summary is ready in DRIFT." };
  }
}

export async function handleNotify(deps: NotifyDeps, raw: unknown): Promise<void> {
  const p = notifyPayloadSchema.parse(raw);
  let userId = p.userId;
  if (userId === undefined && p.sodexAccountId !== undefined) {
    const [a] = await deps.db
      .select({ userId: sodexAccounts.userId })
      .from(sodexAccounts)
      .where(eq(sodexAccounts.id, p.sodexAccountId))
      .limit(1);
    userId = a?.userId;
  }
  if (userId === undefined) return;
  const group = groupOf(p.type);
  const rows = await deps.db
    .select()
    .from(notificationSettings)
    .where(and(eq(notificationSettings.userId, userId), eq(notificationSettings.type, group)));
  const enabled = (channel: "in_app" | "email") =>
    ALWAYS_ON_GROUPS.includes(group) ||
    (rows.find((r) => r.channel === channel)?.enabled ?? NOTIFICATION_DEFAULTS[group][channel]);
  if (enabled("in_app"))
    await deps.db
      .insert(notifications)
      .values({ userId, type: p.type, payload: p.data, channel: "in_app" });
  if (enabled("email") && deps.sendEmail !== null) {
    const [u] = await deps.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const botId = typeof p.data.botId === "string" ? p.data.botId : null;
    const [b] =
      botId === null
        ? []
        : await deps.db.select({ name: bots.name }).from(bots).where(eq(bots.id, botId)).limit(1);
    if (u !== undefined) {
      const m = emailText(p.type, p.data, b?.name ?? null);
      await deps.sendEmail(u.email, m.subject, m.text);
      await deps.db
        .insert(notifications)
        .values({ userId, type: p.type, payload: p.data, channel: "email", readAt: new Date() });
    }
  }
}
