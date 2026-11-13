import { botDrafts, bots, botVersions, mcpTokens, type Db } from "@drift/db";
import {
  AppError,
  BOT_STRATEGIES,
  ErrorCode,
  MCP_DRAFT_CONFIG,
  MCP_DRAFT_NOTE,
  MCP_DRAFTS_FULL,
  Strategy,
  type BotDraftView,
  type McpDraftResult,
} from "@drift/shared";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";

import { checkNewBotConfig, checkVersionConfig, type BotDeps } from "../bots/service";

import { ownBotOr404, type McpCaller } from "./auth";

// Bản nháp từ Claude (docs/MCP.md mục 5B, DEC-167, DEC-TBD-mcp-drafts). Chỉ ghi bảng `bot_drafts`: không tạo bot, không
// thêm version, không Start. Config được kiểm tra bằng đúng hàm của màn Create / Edit (schema zod S1–S12, field khoá,
// trần đòn bẩy), nên bản nháp nào mở ra cũng lưu được nếu người dùng không sửa. Hết hạn 24 giờ; tối đa 20 bản đang chờ.

export interface DraftDeps {
  bots: BotDeps;
  /** Gốc web, ví dụ `https://desklabs.xyz`, để dựng link mở bản nháp. */
  appUrl: string;
}

/** Câu chung cho bản nháp hết hạn / không tồn tại / của người khác (không lộ là có tồn tại). */
const GONE = "This draft is no longer available.";

async function insertDraft(
  deps: DraftDeps,
  caller: McpCaller,
  row: {
    botId: string | null;
    strategy: string;
    name: string | null;
    config: Record<string, unknown>;
  },
) {
  const db = deps.bots.db;
  const now = deps.bots.now();
  return db.transaction(async (tx) => {
    // Khoá theo user để hai lần gọi song song không vượt giới hạn.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`bot_drafts:${caller.userId}`}))`);
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(botDrafts)
      .where(
        and(
          eq(botDrafts.userId, caller.userId),
          gt(botDrafts.expiresAt, now),
          isNull(botDrafts.openedAt),
        ),
      );
    if (n >= MCP_DRAFT_CONFIG.maxOpen)
      throw new AppError(ErrorCode.stateConflict, MCP_DRAFTS_FULL, { reason: "too_many_drafts" });
    const [d] = await tx
      .insert(botDrafts)
      .values({
        userId: caller.userId,
        botId: row.botId,
        strategy: row.strategy,
        name: row.name,
        config: row.config,
        clientId: caller.clientId,
        expiresAt: new Date(now.getTime() + MCP_DRAFT_CONFIG.ttlMs),
      })
      .returning();
    if (d === undefined) throw new AppError(ErrorCode.internal, "Could not save the draft.");
    return d;
  });
}

const result = (
  deps: DraftDeps,
  d: typeof botDrafts.$inferSelect,
  kind: McpDraftResult["kind"],
): McpDraftResult => {
  const base = deps.appUrl.replace(/\/+$/, "");
  const url =
    d.botId === null
      ? `${base}/bots/new/${encodeURIComponent(d.strategy)}?draft=${d.id}`
      : `${base}/bots/${d.botId}/edit?draft=${d.id}`;
  return {
    asOf: deps.bots.now().toISOString(),
    source: "bot_drafts",
    draftId: d.id,
    kind,
    url,
    expiresAt: d.expiresAt.toISOString(),
    note: MCP_DRAFT_NOTE,
  };
};

export async function draftNewBot(
  deps: DraftDeps,
  caller: McpCaller,
  input: { strategy: string; name?: string | undefined; config: Record<string, unknown> },
): Promise<McpDraftResult> {
  if (!(BOT_STRATEGIES as readonly string[]).includes(input.strategy))
    throw new AppError(ErrorCode.validationFailed, "Unknown strategy.");
  // Copy Trading có luồng riêng (chọn trader ở Find traders, chỗ copy, kiểm tra thanh khoản).
  if (input.strategy === Strategy.copyTrade)
    throw new AppError(
      ErrorCode.validationFailed,
      "Copy Trading bots are set up in DeskLabs › Find traders.",
    );
  const config = await checkNewBotConfig(deps.bots, caller.userId, input.strategy, input.config);
  const d = await insertDraft(deps, caller, {
    botId: null,
    strategy: input.strategy,
    name: input.name ?? null,
    config,
  });
  return result(deps, d, "new_bot");
}

async function activeConfig(db: Db, b: typeof bots.$inferSelect) {
  const [v] = await db
    .select({ config: botVersions.config })
    .from(botVersions)
    .where(
      b.activeVersionId === null
        ? eq(botVersions.botId, b.id)
        : eq(botVersions.id, b.activeVersionId),
    )
    .orderBy(desc(botVersions.version))
    .limit(1);
  return (v?.config ?? {}) as Record<string, unknown>;
}

export async function draftBotChange(
  deps: DraftDeps,
  caller: McpCaller,
  input: { botId: string; changes: Record<string, unknown> },
): Promise<McpDraftResult> {
  const b = await ownBotOr404(deps.bots.db, caller.userId, input.botId);
  if (b.archivedAt !== null) throw new AppError(ErrorCode.botNotFound, "Bot not found.");
  const merged = { ...(await activeConfig(deps.bots.db, b)), ...input.changes };
  const config = await checkVersionConfig(deps.bots, caller.userId, b, merged);
  const d = await insertDraft(deps, caller, {
    botId: b.id,
    strategy: b.strategy,
    name: null,
    config,
  });
  return result(deps, d, "bot_change");
}

/**
 * Web mở link: chỉ bản nháp của chính người dùng, còn hạn, và (bản sửa) bot còn đó, chưa archive. Mọi trường hợp khác
 * cùng một lỗi 404. Lần mở đầu ghi `opened_at` (bản đã mở không còn tính vào giới hạn 20).
 */
export async function openDraft(
  deps: DraftDeps,
  userId: string,
  id: string,
): Promise<BotDraftView> {
  const db = deps.bots.db;
  const now = deps.bots.now();
  const [d] = await db
    .select()
    .from(botDrafts)
    .where(and(eq(botDrafts.id, id), eq(botDrafts.userId, userId), gt(botDrafts.expiresAt, now)))
    .limit(1);
  if (d === undefined) throw new AppError(ErrorCode.notFound, GONE);
  if (d.botId !== null) {
    const [b] = await db
      .select({ archivedAt: bots.archivedAt })
      .from(bots)
      .where(and(eq(bots.id, d.botId), eq(bots.userId, userId)))
      .limit(1);
    if (b?.archivedAt !== null) throw new AppError(ErrorCode.notFound, GONE);
  }
  if (d.openedAt === null)
    await db.update(botDrafts).set({ openedAt: now }).where(eq(botDrafts.id, d.id));
  return {
    id: d.id,
    strategy: d.strategy,
    botId: d.botId,
    name: d.name,
    config: d.config as Record<string, unknown>,
    expiresAt: d.expiresAt.toISOString(),
  };
}

/** Step-up: refresh token còn hiệu lực của family chứa token này hết hạn ngay (không thu hồi access token). */
export async function endRefresh(db: Db, tokenId: string, now: Date): Promise<void> {
  const [t] = await db
    .select({ familyId: mcpTokens.familyId })
    .from(mcpTokens)
    .where(eq(mcpTokens.id, tokenId))
    .limit(1);
  if (t === undefined) return;
  await db
    .update(mcpTokens)
    .set({ refreshExpiresAt: now })
    .where(
      and(
        eq(mcpTokens.familyId, t.familyId),
        isNull(mcpTokens.rotatedAt),
        isNull(mcpTokens.revokedAt),
        gt(mcpTokens.refreshExpiresAt, now),
      ),
    );
}
