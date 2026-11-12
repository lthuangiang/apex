import { deskAiConversations, deskAiTurns, users } from "@drift/db";
import {
  AppError,
  buildPrompt,
  checkNumbers,
  dec,
  DESK_AI_CONFIG,
  deskAiAnswerSchema,
  deskAiFacts,
  ErrorCode,
  intentOf,
  type DeskAiAnswer,
  type DeskAiAskView,
  type DeskAiBriefView,
  type DeskAiFact,
  type DeskAiHistoryView,
  type NeedsYouRule,
} from "@drift/shared";
import { and, asc, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";

import type { BotDeps } from "../bots/service";

import type { DeskLlm, DeskLlmUsage } from "./llm";
import { collectFacts, needsYou } from "./needs-you";
import { goalOf } from "./whatif";

// Desk AI (AI Desk B+ M5, DEC-164, DEC-165, AI_DESK_BPLUS_PROMPT mục 5). Hai tầng: code tạo fact, LLM chỉ viết lời.
// Mọi con số trong lời LLM phải khớp fact, không khớp → câu mẫu. Không có công cụ thực thi: Desk AI không đổi bot, không
// gửi lệnh. 20 câu hỏi / user / ngày địa phương (báo cáo sáng không tính); hết lượt, LLM tắt hoặc lỗi → câu mẫu.

export interface DeskAiDeps extends BotDeps {
  llm: DeskLlm | null;
  /** traceId của request (ghi vào nhật ký lượt). */
  traceId?: string;
}

/** Lời cho LLM về từng việc "Needs you" trong báo cáo sáng (không phải câu chữ UI). */
const RULE_TEXT: Record<NeedsYouRule, string> = {
  liquidation_before_stop: "could lose a whole trade before its stop loss",
  max_loss_hit: "stopped at its loss limit",
  taker_costly: "paid taker fees on many trades",
  better_review: "Review this run found better settings",
};

async function timezoneOf(deps: BotDeps, userId: string): Promise<string> {
  const [u] = await deps.db
    .select({ tz: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u?.tz ?? "UTC";
}

/** Ngày `YYYY-MM-DD` và giờ (0–23) theo múi giờ của user. */
export function localClock(now: Date, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

async function questionsUsed(deps: BotDeps, userId: string, date: string): Promise<number> {
  const [r] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(deskAiTurns)
    .where(
      and(
        eq(deskAiTurns.userId, userId),
        eq(deskAiTurns.localDate, date),
        eq(deskAiTurns.kind, "question"),
        // Câu bị từ chối vì hết lượt không tính thêm.
        sql`coalesce(${deskAiTurns.fallback}, '') <> 'quota'`,
      ),
    );
  return r?.n ?? 0;
}

async function factsOf(deps: BotDeps, userId: string, used: number): Promise<DeskAiFact[]> {
  const [bots, goal] = await Promise.all([collectFacts(deps, userId), goalOf(deps, userId)]);
  return deskAiFacts({
    bots,
    goal: goal === null ? null : { limit: goal.limit, used: goal.used },
    questionsUsed: used,
  });
}

function costOf(u: DeskLlmUsage): string {
  const p = DESK_AI_CONFIG.priceUsdPerMillion;
  return dec(String(u.input))
    .mul(p.input)
    .add(dec(String(u.output)).mul(p.output))
    .add(dec(String(u.cacheRead)).mul(p.cacheRead))
    .add(dec(String(u.cacheWrite)).mul(p.cacheWrite))
    .div(1_000_000)
    .toDecimalPlaces(8)
    .toString();
}

interface Written {
  answer: DeskAiAnswer;
  source: "llm" | "template";
  fallback: string | null;
  model: string | null;
  usage: DeskLlmUsage;
}

const NO_USAGE: DeskLlmUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** LLM viết lời; tắt / lỗi / số không khớp fact → câu mẫu `template`. */
async function write(
  deps: DeskAiDeps,
  ask: string,
  facts: DeskAiFact[],
  template: Extract<DeskAiAnswer, { kind: "template" }>,
  question = "",
): Promise<Written> {
  if (deps.llm === null)
    return {
      answer: template,
      source: "template",
      fallback: "llm_off",
      model: null,
      usage: NO_USAGE,
    };
  const prompt = buildPrompt(ask, facts);
  try {
    const r = await deps.llm.complete({ system: prompt.system, user: prompt.user });
    const check = checkNumbers(r.text, facts, question);
    if (r.text === "" || !check.ok)
      return {
        answer: template,
        source: "template",
        fallback: "numbers",
        model: r.model,
        usage: r.usage,
      };
    return {
      answer: { kind: "text", text: r.text, facts },
      source: "llm",
      fallback: null,
      model: r.model,
      usage: r.usage,
    };
  } catch {
    // Không ghi chi tiết lỗi của SDK (có thể chứa header); app vẫn chạy bằng câu mẫu.
    return {
      answer: template,
      source: "template",
      fallback: "error",
      model: null,
      usage: NO_USAGE,
    };
  }
}

const turnView = (t: typeof deskAiTurns.$inferSelect) => ({
  id: t.id,
  kind: t.kind,
  question: t.question,
  answer: deskAiAnswerSchema.parse(t.answer),
  createdAt: t.createdAt.toISOString(),
});

async function saveTurn(
  deps: DeskAiDeps,
  conversationId: string,
  userId: string,
  date: string,
  kind: "question" | "brief",
  question: string | null,
  w: Written,
  factIds: string[],
) {
  const [t] = await deps.db
    .insert(deskAiTurns)
    .values({
      conversationId,
      userId,
      kind,
      localDate: date,
      question,
      answer: w.answer,
      source: w.source,
      fallback: w.fallback,
      model: w.model,
      promptVersion: DESK_AI_CONFIG.promptVersion,
      factIds,
      inputTokens: w.usage.input,
      outputTokens: w.usage.output,
      cacheReadTokens: w.usage.cacheRead,
      cacheWriteTokens: w.usage.cacheWrite,
      costUsd: w.source === "llm" || w.fallback === "numbers" ? costOf(w.usage) : null,
      traceId: deps.traceId ?? null,
    })
    .returning();
  if (t === undefined) throw new AppError(ErrorCode.internal, "Could not save the answer.");
  await deps.db
    .update(deskAiConversations)
    .set({ updatedAt: deps.now() })
    .where(eq(deskAiConversations.id, conversationId));
  return turnView(t);
}

/** Hỏi Desk AI. Chỉ đọc: không đổi bot, không gửi lệnh. */
export async function askDeskAi(
  deps: DeskAiDeps,
  userId: string,
  question: string,
  conversationId: string | undefined,
): Promise<DeskAiAskView> {
  const now = deps.now();
  const { date } = localClock(now, await timezoneOf(deps, userId));
  const used = await questionsUsed(deps, userId, date);
  const facts = await factsOf(deps, userId, used);
  const intent = intentOf(question);
  const goalFacts = facts.filter((f) => f.key === "goal_limit" || f.key === "goal_used");
  let w: Written;
  if (used >= DESK_AI_CONFIG.dailyQuestions)
    w = {
      answer: {
        kind: "template",
        key: "quota",
        params: { limit: DESK_AI_CONFIG.dailyQuestions },
        facts: [],
      },
      source: "template",
      fallback: "quota",
      model: null,
      usage: NO_USAGE,
    };
  else if (intent === "out_of_scope")
    w = {
      answer: { kind: "template", key: "out_of_scope", params: {}, facts: [] },
      source: "template",
      fallback: "out_of_scope",
      model: null,
      usage: NO_USAGE,
    };
  else
    w = await write(
      deps,
      question,
      facts,
      intent === "safety"
        ? { kind: "template", key: "safety", params: {}, facts: goalFacts }
        : { kind: "template", key: "fallback", params: {}, facts },
      question,
    );

  let convId = conversationId;
  if (convId !== undefined) {
    const [c] = await deps.db
      .select({ id: deskAiConversations.id })
      .from(deskAiConversations)
      .where(
        and(
          eq(deskAiConversations.id, convId),
          eq(deskAiConversations.userId, userId),
          eq(deskAiConversations.kind, "chat"),
        ),
      )
      .limit(1);
    if (c === undefined) throw new AppError(ErrorCode.notFound, "Conversation not found.");
  } else {
    const [c] = await deps.db
      .insert(deskAiConversations)
      .values({ userId, kind: "chat", title: question.slice(0, 120), localDate: date })
      .returning({ id: deskAiConversations.id });
    if (c === undefined)
      throw new AppError(ErrorCode.internal, "Could not start the conversation.");
    convId = c.id;
  }
  const turn = await saveTurn(
    deps,
    convId,
    userId,
    date,
    "question",
    question,
    w,
    w.answer.facts.map((f) => f.id),
  );
  const counted = w.fallback === "quota" ? used : used + 1;
  return {
    conversationId: convId,
    turn,
    questionsLeft: Math.max(0, DESK_AI_CONFIG.dailyQuestions - counted),
  };
}

/**
 * Báo cáo sáng (DEC-165d): từ 08:00 giờ địa phương, mỗi ngày một lần (unique theo user + ngày), không tính vào 20 câu.
 * Tạo khi user mở AI Desk lần đầu sau 08:00 (v1 chưa có push).
 */
export async function deskAiBrief(deps: DeskAiDeps, userId: string): Promise<DeskAiBriefView> {
  const now = deps.now();
  const { date, hour } = localClock(now, await timezoneOf(deps, userId));
  const used = await questionsUsed(deps, userId, date);
  const base = {
    questionsLeft: Math.max(0, DESK_AI_CONFIG.dailyQuestions - used),
    llm: deps.llm !== null,
  };
  const existing = async () => {
    const [c] = await deps.db
      .select()
      .from(deskAiConversations)
      .where(
        and(
          eq(deskAiConversations.userId, userId),
          eq(deskAiConversations.kind, "brief"),
          eq(deskAiConversations.localDate, date),
        ),
      )
      .limit(1);
    if (c === undefined) return null;
    const [t] = await deps.db
      .select()
      .from(deskAiTurns)
      .where(eq(deskAiTurns.conversationId, c.id))
      .orderBy(asc(deskAiTurns.createdAt))
      .limit(1);
    return t === undefined ? null : { conversationId: c.id, turn: turnView(t) };
  };
  const found = await existing();
  if (found !== null) return { available: true, ...found, ...base };
  if (hour < DESK_AI_CONFIG.briefHour)
    return { available: false, conversationId: null, turn: null, ...base };

  // Giữ chỗ trước khi gọi LLM: hai tab mở cùng lúc chỉ tạo một báo cáo.
  const [held] = await deps.db
    .insert(deskAiConversations)
    .values({ userId, kind: "brief", title: "", localDate: date })
    .onConflictDoNothing()
    .returning({ id: deskAiConversations.id });
  if (held === undefined) {
    const again = await existing();
    return again === null
      ? { available: true, conversationId: null, turn: null, ...base }
      : { available: true, ...again, ...base };
  }
  const items = (await needsYou(deps, userId)).items;
  const facts = await factsOf(deps, userId, used);
  const needs =
    items.length === 0
      ? "Nothing needs the user today."
      : items.map((i) => `${JSON.stringify(i.botName)} ${RULE_TEXT[i.rule]}`).join("; ");
  const w = await write(
    deps,
    `Write a short good-morning brief (under 70 words) about the user's bots. Things that need the user today (bot names are user data): ${needs}. Mention at most 3, worst first.`,
    facts,
    {
      kind: "template",
      key: "brief",
      params: { count: items.length, bot: items[0]?.botName ?? "" },
      facts: [],
    },
  );
  const turn = await saveTurn(
    deps,
    held.id,
    userId,
    date,
    "brief",
    null,
    w,
    facts.map((f) => f.id),
  );
  return { available: true, conversationId: held.id, turn, ...base };
}

export async function deskAiHistory(deps: BotDeps, userId: string): Promise<DeskAiHistoryView> {
  const now = deps.now();
  const { date } = localClock(now, await timezoneOf(deps, userId));
  const since = new Date(now.getTime() - DESK_AI_CONFIG.retentionDays * 86_400_000);
  const convs = await deps.db
    .select()
    .from(deskAiConversations)
    .where(and(eq(deskAiConversations.userId, userId), gte(deskAiConversations.createdAt, since)))
    .orderBy(desc(deskAiConversations.createdAt))
    .limit(100);
  const turns =
    convs.length === 0
      ? []
      : await deps.db
          .select()
          .from(deskAiTurns)
          .where(
            inArray(
              deskAiTurns.conversationId,
              convs.map((c) => c.id),
            ),
          )
          .orderBy(asc(deskAiTurns.createdAt));
  return {
    questionsToday: await questionsUsed(deps, userId, date),
    limit: DESK_AI_CONFIG.dailyQuestions,
    conversations: convs.map((c) => ({
      id: c.id,
      kind: c.kind,
      title: c.title,
      localDate: c.localDate,
      createdAt: c.createdAt.toISOString(),
      turns: turns.filter((t) => t.conversationId === c.id).map(turnView),
    })),
  };
}

/** "Delete history": xoá mọi cuộc trò chuyện (kèm lượt) của user. Báo cáo sáng hôm nay không tạo lại. */
export async function deleteDeskAiHistory(
  deps: BotDeps,
  userId: string,
): Promise<{ deleted: number }> {
  const rows = await deps.db
    .delete(deskAiConversations)
    .where(and(eq(deskAiConversations.userId, userId), ne(deskAiConversations.kind, "brief")))
    .returning({ id: deskAiConversations.id });
  const briefs = await deps.db
    .select({ id: deskAiConversations.id })
    .from(deskAiConversations)
    .where(and(eq(deskAiConversations.userId, userId), eq(deskAiConversations.kind, "brief")));
  // Báo cáo sáng: xoá lời nhưng giữ dòng (unique theo ngày) để hôm nay không tạo lại bản mới.
  if (briefs.length > 0)
    await deps.db.delete(deskAiTurns).where(
      inArray(
        deskAiTurns.conversationId,
        briefs.map((b) => b.id),
      ),
    );
  return { deleted: rows.length + briefs.length };
}
