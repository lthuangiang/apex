import { bots, notifications, telegramLinks, users, type Db } from "@drift/db";
import { DeferError, isBlockedResult, type BotApi } from "@drift/runtime";
import {
  groupOf,
  NOTIFICATION_GROUPS,
  TEAM_ONLY_GROUPS,
  UserRole,
  type NotificationType,
} from "@drift/shared";
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { z } from "zod";

import { renderTelegram, type RenderRow } from "./telegram-render";

// Worker gửi tin Telegram (docs/NOTIFICATIONS.md mục 6, DEC-170). `jobs.notify` ghi bản `channel = telegram`
// (`delivery_status = queued`) và đẩy `jobs.telegram_alert` (Bot problems, ưu tiên) hoặc `jobs.telegram`.
// - Gộp tin (mục 5): tin đầu của một nhóm chờ COLLECT_MS để gom các tin cùng nhóm; trong WINDOW_MS sau một lần
//   gửi, tin cùng nhóm được giữ tới cuối cửa sổ rồi gửi chung (CẦN CHỐT PR4 (1), phương án A).
// - Giới hạn Telegram: ~1 tin/giây/chat, ~30 tin/giây toàn bot; đếm trong Redis vì jobs chạy nhiều replica.
//   Bot problems được dùng cả 30, nhóm khác tối đa NORMAL_GLOBAL_PER_SEC.
// - Gửi lại được (không phải thao tác tài chính); idempotent theo notification id.
//   429 → chờ `retry_after`; 5xx / mạng → backoff, tối đa MAX_FAILURES lần; 403 hoặc 400 "chat not found" →
//   `blocked`, ngừng gửi, báo in-app.

export const TELEGRAM_SUBJECT = "jobs.telegram";
export const TELEGRAM_ALERT_SUBJECT = "jobs.telegram_alert";
export const COLLECT_MS = 5_000;
export const WINDOW_MS = 60_000;
export const ALERT_GLOBAL_PER_SEC = 30;
export const NORMAL_GLOBAL_PER_SEC = 20;
export const MAX_FAILURES = 5;
/** Số lượt giao của consumer: đủ cho các lần hoãn (gom tin, giới hạn tốc độ) cộng MAX_FAILURES. */
export const TELEGRAM_MAX_DELIVER = 30;

export const telegramJobSchema = z.object({ notificationId: z.uuid() });

/** Redis tối thiểu cho bộ đếm (dễ giả trong test). */
export interface Counter {
  /** Tăng `key`, đặt hạn `ttlMs` nếu mới; trả về giá trị sau khi tăng. */
  incr(key: string, ttlMs: number): Promise<number>;
}

export interface TelegramWorkerDeps {
  db: Db;
  counter: Counter;
  botApi: BotApi;
  appUrl: string;
  now: () => Date;
  warn: (msg: string, data: Record<string, unknown>) => void;
}

/** Subject theo nhóm: Bot problems đi hàng ưu tiên. */
export function subjectFor(type: NotificationType): string {
  return groupOf(type) === "botErrors" ? TELEGRAM_ALERT_SUBJECT : TELEGRAM_SUBJECT;
}

/** Còn bao nhiêu ms nữa mới được gửi cho chat này; 0 = gửi được ngay (đã giữ chỗ). */
export async function reserveSend(
  counter: Counter,
  chatId: number,
  urgent: boolean,
  nowMs: number,
): Promise<number> {
  const sec = Math.floor(nowMs / 1000);
  const wait = 1000 - (nowMs % 1000);
  const perChat = await counter.incr(`tg:rl:chat:${String(chatId)}:${String(sec)}`, 2_000);
  if (perChat > 1) return wait;
  const global = await counter.incr(`tg:rl:all:${String(sec)}`, 2_000);
  if (global > (urgent ? ALERT_GLOBAL_PER_SEC : NORMAL_GLOBAL_PER_SEC)) return wait;
  return 0;
}

export async function handleTelegram(
  deps: TelegramWorkerDeps,
  raw: unknown,
  urgent: boolean,
): Promise<void> {
  const { notificationId } = telegramJobSchema.parse(raw);
  const [n] = await deps.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.id, notificationId), eq(notifications.channel, "telegram")))
    .limit(1);
  // Đã gửi (riêng hoặc trong một tin gộp), đã thất bại, hoặc không tồn tại: không làm gì.
  if (n?.deliveryStatus !== "queued") return;
  const group = groupOf(n.type as NotificationType);
  // Báo team (DEC-184): chỉ gộp CÙNG loại sự kiện; role `team` kiểm tra lại lúc gửi (bị gỡ role thì ngừng nhận ngay).
  const types = TEAM_ONLY_GROUPS.includes(group)
    ? [n.type]
    : (NOTIFICATION_GROUPS[group] as readonly string[]);
  if (TEAM_ONLY_GROUPS.includes(group)) {
    const [u] = await deps.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, n.userId))
      .limit(1);
    if (u?.role !== UserRole.team) {
      await deps.db
        .update(notifications)
        .set({ deliveryStatus: "failed" })
        .where(eq(notifications.id, n.id));
      return;
    }
  }
  const nowMs = deps.now().getTime();

  const [last] = await deps.db
    .select({ at: notifications.updatedAt })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, n.userId),
        eq(notifications.channel, "telegram"),
        eq(notifications.deliveryStatus, "sent"),
        inArray(notifications.type, [...types]),
      ),
    )
    .orderBy(desc(notifications.updatedAt))
    .limit(1);
  const due = Math.max(
    n.createdAt.getTime() + COLLECT_MS,
    last === undefined ? 0 : last.at.getTime() + WINDOW_MS,
  );
  if (due > nowMs) throw new DeferError(due - nowMs);

  const [link] = await deps.db
    .select()
    .from(telegramLinks)
    .where(eq(telegramLinks.userId, n.userId))
    .limit(1);
  if (link?.status !== "active") {
    // Ngắt kết nối hoặc đã bị chặn trong lúc chờ: không gửi.
    await failQueued(deps.db, n.userId, types, nowMs);
    return;
  }

  const wait = await reserveSend(deps.counter, link.chatId, urgent, nowMs);
  if (wait > 0) throw new DeferError(wait);

  await deps.db.transaction(async (tx) => {
    // Khoá các tin còn chờ của cùng nhóm; replica khác đang gửi chúng thì bỏ qua (SKIP LOCKED).
    const rows = await tx
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, n.userId),
          eq(notifications.channel, "telegram"),
          eq(notifications.deliveryStatus, "queued"),
          inArray(notifications.type, [...types]),
          lte(notifications.createdAt, new Date(nowMs)),
        ),
      )
      .orderBy(asc(notifications.createdAt))
      .limit(50)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return;
    const botIds = [
      ...new Set(
        rows.flatMap((r) => {
          const id = (r.payload as Record<string, unknown>).botId;
          return typeof id === "string" ? [id] : [];
        }),
      ),
    ];
    const names =
      botIds.length === 0
        ? []
        : await tx
            .select({ id: bots.id, name: bots.name })
            .from(bots)
            .where(and(inArray(bots.id, botIds), eq(bots.userId, n.userId)));
    const renderRows: RenderRow[] = rows.map((r) => {
      const data = r.payload as Record<string, unknown>;
      return {
        type: r.type as NotificationType,
        data,
        botName: names.find((b) => b.id === data.botId)?.name ?? null,
      };
    });
    const msg = renderTelegram(renderRows, deps.appUrl);
    const res = await deps.botApi.sendMessage({
      chat_id: link.chatId,
      text: msg.text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[msg.button]] },
    });
    const ids = rows.map((r) => r.id);
    const sentAt = deps.now();
    if (res.ok) {
      await tx
        .update(notifications)
        .set({ deliveryStatus: "sent", updatedAt: sentAt })
        .where(inArray(notifications.id, ids));
      await tx
        .update(telegramLinks)
        .set({ lastSentAt: sentAt })
        .where(eq(telegramLinks.userId, n.userId));
      return;
    }
    deps.warn("telegram send failed", {
      method: "sendMessage",
      status: res.status,
      description: res.description,
      notifications: ids.length,
    });
    if (isBlockedResult(res)) {
      await tx
        .update(notifications)
        .set({ deliveryStatus: "failed" })
        .where(inArray(notifications.id, ids));
      await blockLink(tx, n.userId, sentAt);
      return;
    }
    if (res.status === 429) {
      // Telegram bảo chờ: rollback (tin vẫn `queued`) và giao lại sau `retry_after`.
      throw new DeferError((res.retryAfterSec ?? 1) * 1000);
    }
    const failures = await deps.counter.incr(`tg:fail:${n.id}`, 24 * 60 * 60 * 1000);
    if (failures >= MAX_FAILURES || (res.status >= 400 && res.status < 500)) {
      // 4xx khác 429/403/chat not found: gửi lại cũng vậy. Hết lượt 5xx/mạng: dừng.
      await tx
        .update(notifications)
        .set({ deliveryStatus: "failed" })
        .where(inArray(notifications.id, ids));
      return;
    }
    throw new Error(`telegram send failed (${String(res.status)})`);
  });
}

/** Đánh dấu `failed` mọi tin còn chờ của nhóm (chat đã ngắt hoặc bị chặn). */
async function failQueued(
  db: Db,
  userId: string,
  types: readonly string[],
  nowMs: number,
): Promise<void> {
  await db
    .update(notifications)
    .set({ deliveryStatus: "failed" })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.channel, "telegram"),
        eq(notifications.deliveryStatus, "queued"),
        inArray(notifications.type, [...types]),
        lte(notifications.createdAt, new Date(nowMs)),
      ),
    );
}

/**
 * Người dùng chặn bot hoặc xoá chat (mục 3 "Bị chặn"): đặt `blocked`, ngừng gửi, báo một lần trong app
 * (`telegram_blocked`, nhóm hệ thống DEC-183). Card Settings hiện "Paused · bot blocked".
 */
async function blockLink(tx: Pick<Db, "update" | "insert">, userId: string, at: Date) {
  const changed = await tx
    .update(telegramLinks)
    .set({ status: "blocked", blockedAt: at })
    .where(and(eq(telegramLinks.userId, userId), eq(telegramLinks.status, "active")))
    .returning({ userId: telegramLinks.userId });
  if (changed.length === 0) return;
  await tx.insert(notifications).values({
    userId,
    type: "telegram_blocked",
    payload: {},
    channel: "in_app",
  });
}

/** Lần giao cuối vẫn lỗi: không để tin nằm `queued` mãi. */
export async function markFailed(db: Db, raw: unknown): Promise<void> {
  const parsed = telegramJobSchema.safeParse(raw);
  if (!parsed.success) return;
  await db
    .update(notifications)
    .set({ deliveryStatus: "failed" })
    .where(
      and(
        eq(notifications.id, parsed.data.notificationId),
        eq(notifications.deliveryStatus, "queued"),
      ),
    );
}
