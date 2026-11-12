import {
  bots,
  deskAiConversations,
  deskAiTurns,
  notifications,
  notificationSettings,
  outbox,
  telegramLinks,
  users,
} from "@drift/db";
import { DESK_AI_CONFIG, deskAiAnswerSchema, groupOf, NOTIFICATION_DEFAULTS } from "@drift/shared";
import { and, asc, eq, sql } from "drizzle-orm";

import { deskAiBrief, localClock, type DeskAiDeps } from "./ai";
import { needsYou } from "./needs-you";

// Morning brief qua Telegram (N4, DEC-TBD-telegram-brief). Vòng trong api, 5 phút một lần: user có AI Desk, Telegram
// `active`, nhóm `daily` bật trên Telegram và ít nhất một bot chưa archive nhận một tin mỗi ngày địa phương, từ 08:00
// (gửi bù tới trước 12:00, quá giờ thì bỏ ngày đó). Không gọi LLM chỉ vì Telegram (`llm = false`): dùng lại báo cáo
// sáng đã tạo trên web nếu có, không thì câu mẫu từ "Needs you". Ghi notification `queued` + outbox `jobs.telegram`
// trong một transaction có khoá theo user, nên nhiều replica chạy cùng lúc vẫn chỉ ra một tin.

export const BRIEF_EVERY_MS = 5 * 60_000;
/** Quá giờ này (địa phương) mà chưa gửi được thì bỏ ngày đó. */
export const BRIEF_LAST_HOUR = 12;
const TELEGRAM_SUBJECT = "jobs.telegram";
const TYPE = "daily_summary";

export interface TelegramBriefDeps extends DeskAiDeps {
  /** true: chưa có báo cáo hôm nay thì tạo bằng Desk AI (có thể gọi LLM). Mặc định false (PM chốt). */
  useLlm: boolean;
}

/** Dữ liệu của tin: lời Desk AI (đã qua kiểm tra số) hoặc tham số câu mẫu. */
export type BriefPayload =
  { localDate: string; text: string } | { localDate: string; count: number; bot: string };

async function savedBrief(deps: TelegramBriefDeps, userId: string, date: string) {
  const [t] = await deps.db
    .select({ answer: deskAiTurns.answer })
    .from(deskAiTurns)
    .innerJoin(deskAiConversations, eq(deskAiConversations.id, deskAiTurns.conversationId))
    .where(
      and(
        eq(deskAiConversations.userId, userId),
        eq(deskAiConversations.kind, "brief"),
        eq(deskAiConversations.localDate, date),
      ),
    )
    .orderBy(asc(deskAiTurns.createdAt))
    .limit(1);
  return t === undefined ? null : deskAiAnswerSchema.parse(t.answer);
}

async function payloadOf(
  deps: TelegramBriefDeps,
  userId: string,
  date: string,
): Promise<BriefPayload> {
  const answer =
    (await savedBrief(deps, userId, date)) ??
    (deps.useLlm ? (await deskAiBrief(deps, userId)).turn?.answer : undefined) ??
    null;
  if (answer?.kind === "text") return { localDate: date, text: answer.text };
  if (answer?.kind === "template" && answer.key === "brief")
    return {
      localDate: date,
      count: Number(answer.params.count ?? 0),
      bot: String(answer.params.bot ?? ""),
    };
  const items = (await needsYou(deps, userId)).items;
  return { localDate: date, count: items.length, bot: items[0]?.botName ?? "" };
}

/** Một lượt: số tin đã xếp hàng và số user lỗi (lỗi của một user không chặn user khác). */
export async function queueTelegramBriefs(
  deps: TelegramBriefDeps,
): Promise<{ queued: number; failed: number }> {
  const now = deps.now();
  const candidates = await deps.db
    .select({ id: users.id, tz: users.timezone })
    .from(users)
    .innerJoin(telegramLinks, eq(telegramLinks.userId, users.id))
    .where(
      and(
        eq(users.aiDesk, true),
        eq(telegramLinks.status, "active"),
        sql`exists (select 1 from ${bots} where ${bots.userId} = ${users.id} and ${bots.state} <> 'archived')`,
      ),
    );
  let queued = 0;
  let failed = 0;
  for (const u of candidates) {
    try {
      if (await queueOne(deps, u.id, u.tz, now)) queued += 1;
    } catch {
      failed += 1;
    }
  }
  return { queued, failed };
}

async function queueOne(
  deps: TelegramBriefDeps,
  userId: string,
  tz: string,
  now: Date,
): Promise<boolean> {
  const { date, hour } = localClock(now, tz);
  if (hour < DESK_AI_CONFIG.briefHour || hour >= BRIEF_LAST_HOUR) return false;
  const [off] = await deps.db
    .select({ enabled: notificationSettings.enabled })
    .from(notificationSettings)
    .where(
      and(
        eq(notificationSettings.userId, userId),
        eq(notificationSettings.type, groupOf(TYPE)),
        eq(notificationSettings.channel, "telegram"),
      ),
    )
    .limit(1);
  if (!(off?.enabled ?? NOTIFICATION_DEFAULTS.daily.telegram)) return false;
  if (await sentOn(deps, userId, date)) return false;
  const payload = await payloadOf(deps, userId, date);
  return deps.db.transaction(async (tx) => {
    // Khoá theo user tới hết transaction: replica khác chờ, rồi thấy tin đã ghi và bỏ qua.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`telegram-brief:${userId}`}))`);
    const [dup] = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.type, TYPE),
          eq(notifications.channel, "telegram"),
          sql`${notifications.payload}->>'localDate' = ${date}`,
        ),
      )
      .limit(1);
    const [link] = await tx
      .select({ status: telegramLinks.status })
      .from(telegramLinks)
      .where(eq(telegramLinks.userId, userId))
      .limit(1);
    if (dup !== undefined || link?.status !== "active") return false;
    const [row] = await tx
      .insert(notifications)
      .values({
        userId: userId,
        type: TYPE,
        payload,
        channel: "telegram",
        deliveryStatus: "queued",
        readAt: now,
      })
      .returning({ id: notifications.id });
    if (row === undefined) return false;
    await tx
      .insert(outbox)
      .values({ topic: TELEGRAM_SUBJECT, payload: { notificationId: row.id } });
    return true;
  });
}

async function sentOn(deps: TelegramBriefDeps, userId: string, date: string): Promise<boolean> {
  const [r] = await deps.db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.type, TYPE),
        eq(notifications.channel, "telegram"),
        sql`${notifications.payload}->>'localDate' = ${date}`,
      ),
    )
    .limit(1);
  return r !== undefined;
}

/**
 * Chạy vòng nền. Lỗi chỉ ghi log (không có secret), không bao giờ làm sập api hay chặn request. Trả hàm dừng.
 */
export function startTelegramBriefs(
  deps: TelegramBriefDeps,
  log: { warn: (o: object, msg: string) => void; info: (o: object, msg: string) => void },
  everyMs = BRIEF_EVERY_MS,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await queueTelegramBriefs(deps);
      if (r.queued > 0 || r.failed > 0) log.info(r, "telegram morning briefs queued");
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : "unknown" },
        "telegram morning brief failed",
      );
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  void tick();
  return () => {
    clearInterval(timer);
  };
}
