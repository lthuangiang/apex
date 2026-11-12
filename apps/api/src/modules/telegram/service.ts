import { notifications, telegramLinks, telegramLinkTokens, type Db } from "@drift/db";
import {
  AppError,
  ErrorCode,
  TELEGRAM_LINK_TTL_MS,
  type TelegramLinkCreated,
  type TelegramLinkStatus,
} from "@drift/shared";
import { and, eq, gt, isNull, ne } from "drizzle-orm";

import { AuditAction, audit } from "../../lib/audit";
import { randomToken, sha256 } from "../../lib/crypto";
import messages from "../../messages/en.json" with { type: "json" };
import type { RateLimiter } from "../../plugins/rate-limit";

import type { BotApi, SendMessage } from "./bot-api";
import { isWellFormedToken, parseCommand, type TelegramUpdate } from "./update";

// Kết nối Telegram (docs/NOTIFICATIONS.md mục 3 và 9, DEC-170). Bot chỉ báo tin và mở app: không có lệnh
// hay endpoint nào đổi bot, lệnh, tiền hay cài đặt giao dịch.

export interface TelegramDeps {
  db: Db;
  now: () => Date;
  botUsername: string;
  /** Gốc URL web app cho nút "Open DeskLabs" (không chứa token đăng nhập, mục 5). */
  appUrl: string;
  botApi: BotApi;
  rateLimiter: RateLimiter;
  /** Log không có secret: chỉ tên method và kết quả. */
  warn: (msg: string, data: Record<string, unknown>) => void;
}

const T = messages.telegram;
/** `POST /telegram/link`: 5 lần mỗi phút mỗi user (mục 9). */
export const LINK_RATE_LIMIT = { max: 5, windowMs: 60_000 } as const;

function message(chatId: number, text: string, appUrl?: string): SendMessage {
  return {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(appUrl === undefined
      ? {}
      : { reply_markup: { inline_keyboard: [[{ text: T.openApp, url: appUrl }]] } }),
  };
}

export async function createLink(deps: TelegramDeps, userId: string): Promise<TelegramLinkCreated> {
  const now = deps.now();
  const window = Math.floor(now.getTime() / LINK_RATE_LIMIT.windowMs);
  const hit = await deps.rateLimiter.hit(
    `rl:tg-link:${userId}:${String(window)}`,
    LINK_RATE_LIMIT.windowMs,
  );
  if (hit.count > LINK_RATE_LIMIT.max)
    throw new AppError(ErrorCode.rateLimited, "Too many requests.", { retryAfterMs: hit.resetMs });

  const token = randomToken();
  const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_TTL_MS);
  await deps.db.transaction(async (tx) => {
    // Mỗi user chỉ có 1 token còn hiệu lực: token mới thay token cũ.
    await tx
      .delete(telegramLinkTokens)
      .where(and(eq(telegramLinkTokens.userId, userId), isNull(telegramLinkTokens.usedAt)));
    await tx.insert(telegramLinkTokens).values({ userId, tokenHash: sha256(token), expiresAt });
  });
  return {
    deepLink: `https://t.me/${deps.botUsername}?start=${token}`,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function linkStatus(deps: TelegramDeps, userId: string): Promise<TelegramLinkStatus> {
  const [link] = await deps.db
    .select()
    .from(telegramLinks)
    .where(eq(telegramLinks.userId, userId))
    .limit(1);
  if (link !== undefined) {
    return {
      status: link.status,
      username: link.username,
      connectedAt: link.connectedAt.toISOString(),
      ...(link.blockedAt === null ? {} : { blockedAt: link.blockedAt.toISOString() }),
    };
  }
  const [pending] = await deps.db
    .select({ expiresAt: telegramLinkTokens.expiresAt })
    .from(telegramLinkTokens)
    .where(
      and(
        eq(telegramLinkTokens.userId, userId),
        isNull(telegramLinkTokens.usedAt),
        gt(telegramLinkTokens.expiresAt, deps.now()),
      ),
    )
    .limit(1);
  return pending === undefined
    ? { status: "not_connected" }
    : { status: "pending", expiresAt: pending.expiresAt.toISOString() };
}

/**
 * Ngắt kết nối từ web (mục 3): xoá chat và token chưa dùng, rồi gửi tin cuối "Disconnected from DeskLabs."
 * (best-effort: Telegram lỗi thì vẫn ngắt). Chưa kết nối thì không làm gì.
 */
export async function unlink(deps: TelegramDeps, userId: string, ip: string | null): Promise<void> {
  const removed = await deps.db.transaction(async (tx) => {
    await tx
      .delete(telegramLinkTokens)
      .where(and(eq(telegramLinkTokens.userId, userId), isNull(telegramLinkTokens.usedAt)));
    return tx
      .delete(telegramLinks)
      .where(eq(telegramLinks.userId, userId))
      .returning({ chatId: telegramLinks.chatId, status: telegramLinks.status });
  });
  const link = removed[0];
  if (link === undefined) return;
  await audit(deps.db, {
    userId,
    action: AuditAction.telegramDisconnected,
    target: userId,
    metadata: { source: "web" },
    ip,
  });
  // Bot đã bị chặn thì không gửi (sẽ 403).
  if (link.status !== "active") return;
  const res = await deps.botApi.sendMessage(message(link.chatId, T.disconnected));
  if (!res.ok)
    deps.warn("telegram send failed", {
      method: "sendMessage",
      status: res.status,
      description: res.description,
    });
}

export interface UpdateOutcome {
  /** Tin trả lời, gửi lại Telegram trong chính response của webhook. null: không trả lời. */
  reply: SendMessage | null;
  /** User vừa mất kết nối vì chat này chuyển sang user khác (mục 3 "Quy tắc"). */
  movedFromUserId: string | null;
}

/**
 * Xử lý một update từ webhook. Chỉ nhận chat riêng 1-1; group / channel bỏ qua, không trả lời. Tin nhắn tự
 * do không được lưu và không đưa vào LLM (mục 5).
 */
export async function handleUpdate(
  deps: TelegramDeps,
  update: TelegramUpdate,
): Promise<UpdateOutcome> {
  const none: UpdateOutcome = { reply: null, movedFromUserId: null };
  const msg = update.message;
  if (msg?.chat.type !== "private") return none;
  const chatId = msg.chat.id;
  const cmd = parseCommand(msg.text, deps.botUsername);
  const reply = (text: string, withButton = false): UpdateOutcome => ({
    reply: message(chatId, text, withButton ? deps.appUrl : undefined),
    movedFromUserId: null,
  });

  switch (cmd.kind) {
    case "start": {
      if (cmd.token === null) return reply(T.howToConnect, true);
      if (!isWellFormedToken(cmd.token)) return reply(T.expired, true);
      const outcome = await connect(deps, cmd.token, chatId, msg.chat.username ?? null);
      if (outcome === null) return reply(T.expired, true);
      return { ...reply(T.welcome, true), movedFromUserId: outcome.movedFromUserId };
    }
    case "stop": {
      const removed = await deps.db
        .delete(telegramLinks)
        .where(eq(telegramLinks.chatId, chatId))
        .returning({ userId: telegramLinks.userId });
      const userId = removed[0]?.userId;
      if (userId === undefined) return reply(T.howToConnect, true);
      await audit(deps.db, {
        userId,
        action: AuditAction.telegramDisconnected,
        target: userId,
        metadata: { source: "telegram" },
        ip: null,
      });
      return reply(T.disconnected);
    }
    case "help":
      return reply(T.help, true);
    case "status":
      // `/status` (bot + trạng thái + PnL hôm nay từ fact backend) có ở N3 (PR4). Tới lúc đó: danh sách lệnh.
      return (await isLinked(deps, chatId)) ? reply(T.help, true) : reply(T.howToConnect, true);
    case "text":
      return reply(T.freeText, true);
  }
}

async function isLinked(deps: TelegramDeps, chatId: number): Promise<boolean> {
  const [row] = await deps.db
    .select({ userId: telegramLinks.userId })
    .from(telegramLinks)
    .where(eq(telegramLinks.chatId, chatId))
    .limit(1);
  return row !== undefined;
}

/**
 * `/start <token>`: chỉ nhận token đúng hash, chưa hết hạn, chưa dùng (mục 3 bước 5). Dùng token, gắn chat với
 * user (kết nối lại thì chat mới thay chat cũ; chat đang gắn user khác thì gỡ khỏi user đó), ghi audit.
 * Token không hợp lệ: trả null, không gắn gì.
 */
async function connect(
  deps: TelegramDeps,
  token: string,
  chatId: number,
  username: string | null,
): Promise<{ userId: string; movedFromUserId: string | null } | null> {
  const now = deps.now();
  const result = await deps.db.transaction(async (tx) => {
    // Đánh dấu đã dùng ngay trong điều kiện: hai `/start` cùng token chỉ một cái thắng.
    const [used] = await tx
      .update(telegramLinkTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(telegramLinkTokens.tokenHash, sha256(token)),
          isNull(telegramLinkTokens.usedAt),
          gt(telegramLinkTokens.expiresAt, now),
        ),
      )
      .returning({ userId: telegramLinkTokens.userId });
    if (used === undefined) return null;
    const userId = used.userId;
    const moved = await tx
      .delete(telegramLinks)
      .where(and(eq(telegramLinks.chatId, chatId), ne(telegramLinks.userId, userId)))
      .returning({ userId: telegramLinks.userId });
    await tx
      .insert(telegramLinks)
      .values({ userId, chatId, username, status: "active", connectedAt: now })
      .onConflictDoUpdate({
        target: telegramLinks.userId,
        set: { chatId, username, status: "active", connectedAt: now, blockedAt: null },
      });
    const movedFromUserId = moved[0]?.userId ?? null;
    // Thông báo in-app nhóm hệ thống `telegram` (DEC-TBD-telegram-notify-group): luôn bật, không email,
    // không Telegram. Payload chỉ có username, không có chat id.
    await tx.insert(notifications).values({
      userId,
      type: "telegram_connected",
      payload: { username },
      channel: "in_app",
    });
    if (movedFromUserId !== null)
      await tx.insert(notifications).values({
        userId: movedFromUserId,
        type: "telegram_moved",
        payload: {},
        channel: "in_app",
      });
    return { userId, movedFromUserId };
  });
  if (result === null) return null;
  await audit(deps.db, {
    userId: result.userId,
    action: AuditAction.telegramConnected,
    target: result.userId,
    metadata: { replacedOtherUser: result.movedFromUserId !== null },
    ip: null,
  });
  if (result.movedFromUserId !== null)
    await audit(deps.db, {
      userId: result.movedFromUserId,
      action: AuditAction.telegramDisconnected,
      target: result.movedFromUserId,
      metadata: { source: "moved_to_other_user" },
      ip: null,
    });
  return result;
}
