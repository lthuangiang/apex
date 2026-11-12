import { bots, botVersions, deskApplies, deskWhatifs } from "@drift/db";
import {
  AppError,
  changesOf,
  deskRecordResultSchema,
  ErrorCode,
  RECORD_CONFIG,
  type DeskRecordView,
  type WhatIfOptionResult,
} from "@drift/shared";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

import { newVersion, type BotDeps } from "../bots/service";

// AI Desk B+ M4 (DEC-166): thành tích đề xuất. Mỗi lần Apply một dòng; worker `backtest` đo sau 7 ngày (scheduler xếp
// job). Hiện cả lần làm xấu đi. Switch back = version mới từ cấu hình trước khi Apply, user bấm.

type ApplyRow = typeof deskApplies.$inferSelect;

/** Thời điểm version AI thật sự được áp (bot đang chạy: engine áp sau); chưa áp thì lấy lúc bấm Apply. */
async function activeSince(deps: BotDeps, a: ApplyRow): Promise<Date> {
  if (a.toVersion === null) return a.appliedAt;
  const [v] = await deps.db
    .select({ at: botVersions.appliedAt })
    .from(botVersions)
    .where(and(eq(botVersions.botId, a.botId), eq(botVersions.version, a.toVersion)))
    .limit(1);
  return v?.at ?? a.appliedAt;
}

export async function recordView(deps: BotDeps, userId: string): Promise<DeskRecordView> {
  const rows = await deps.db
    .select({
      a: deskApplies,
      botName: bots.name,
      options: deskWhatifs.options,
      activeVersion: botVersions.version,
    })
    .from(deskApplies)
    .innerJoin(bots, eq(bots.id, deskApplies.botId))
    .innerJoin(deskWhatifs, eq(deskWhatifs.id, deskApplies.whatifId))
    .leftJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
    .where(and(eq(deskApplies.userId, userId), isNotNull(deskApplies.toVersion)))
    .orderBy(desc(deskApplies.appliedAt));
  const counts = { helped: 0, madeWorse: 0, noClearEffect: 0, measuring: 0 };
  const out = await Promise.all(
    rows.map(async ({ a, botName, options, activeVersion }) => {
      const since = await activeSince(deps, a);
      const patch = (options as WhatIfOptionResult[]).find((o) => o.key === a.option)?.patch ?? {};
      const parsed = deskRecordResultSchema.safeParse(a.record);
      const result = parsed.success ? parsed.data : null;
      const status =
        a.recordStatus === "done" && result !== null
          ? ("done" as const)
          : a.recordStatus === "unavailable"
            ? ("unavailable" as const)
            : ("measuring" as const);
      const verdict = status === "done" ? a.verdict : null;
      if (status === "measuring") counts.measuring += 1;
      else if (verdict === "helped") counts.helped += 1;
      else if (verdict === "made_worse") counts.madeWorse += 1;
      else if (verdict === "no_clear_effect") counts.noClearEffect += 1;
      return {
        id: a.id,
        botId: a.botId,
        botName,
        rule: a.rule as DeskRecordView["rows"][number]["rule"],
        option: a.option as DeskRecordView["rows"][number]["option"],
        changes: changesOf(a.baselineConfig as Record<string, unknown>, patch),
        appliedAt: a.appliedAt.toISOString(),
        dueAt: new Date(since.getTime() + RECORD_CONFIG.measureMs).toISOString(),
        checkedAt: a.checkedAt?.toISOString() ?? null,
        status,
        verdict,
        after: status === "done" ? (result?.after ?? null) : null,
        old: status === "done" ? (result?.old ?? null) : null,
        source: result?.source ?? null,
        error: a.recordError,
        canSwitchBack:
          verdict === "made_worse" &&
          a.switchedBackVersion === null &&
          activeVersion === a.toVersion,
        // −1 = đang tạo version (giữ chỗ), chưa có số version.
        switchedBackVersion:
          a.switchedBackVersion !== null && a.switchedBackVersion > 0
            ? a.switchedBackVersion
            : null,
      };
    }),
  );
  return { counts, rows: out };
}

/** Switch back: version mới từ cấu hình trước khi Apply. Chỉ khi "Made it worse" và bot vẫn ở version AI đã tạo. */
export async function switchBack(deps: BotDeps, userId: string, id: string) {
  const [row] = await deps.db
    .select({ a: deskApplies, activeVersion: botVersions.version })
    .from(deskApplies)
    .innerJoin(bots, eq(bots.id, deskApplies.botId))
    .leftJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
    .where(and(eq(deskApplies.id, id), eq(deskApplies.userId, userId)))
    .limit(1);
  if (row === undefined) throw new AppError(ErrorCode.notFound, "Fix not found.");
  const { a } = row;
  if (a.switchedBackVersion !== null)
    throw new AppError(ErrorCode.stateConflict, "Already switched back.", {
      reason: "switched_back",
    });
  if (a.recordStatus !== "done" || a.verdict !== "made_worse")
    throw new AppError(ErrorCode.stateConflict, "Only fixes that made it worse can be undone.", {
      reason: "not_worse",
    });
  if (row.activeVersion !== a.toVersion)
    throw new AppError(ErrorCode.stateConflict, "Settings changed since this fix.", {
      reason: "version_changed",
    });
  // Giữ chỗ như Apply (−1 = đang tạo version): hai lần bấm cùng lúc chỉ một lần tạo version.
  const [held] = await deps.db
    .update(deskApplies)
    .set({ switchedBackVersion: -1, updatedAt: deps.now() })
    .where(and(eq(deskApplies.id, a.id), isNull(deskApplies.switchedBackVersion)))
    .returning({ id: deskApplies.id });
  if (held === undefined)
    throw new AppError(ErrorCode.stateConflict, "Already switched back.", {
      reason: "switched_back",
    });
  try {
    const v = await newVersion(deps, userId, a.botId, {
      config: a.baselineConfig,
      paramSource: "manual",
    });
    await deps.db
      .update(deskApplies)
      .set({ switchedBackVersion: v.version, updatedAt: deps.now() })
      .where(eq(deskApplies.id, a.id));
    return {
      botId: a.botId,
      version: v.version,
      status: v.status === "active" ? "active" : "pending",
    } as const;
  } catch (err) {
    await deps.db
      .update(deskApplies)
      .set({ switchedBackVersion: null, updatedAt: deps.now() })
      .where(eq(deskApplies.id, a.id));
    throw err;
  }
}
