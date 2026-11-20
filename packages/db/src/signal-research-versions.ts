import {
  AppError,
  botVersionConfigSchema,
  hypothesisSchema,
  nextRunPeriods,
  runPeriodsJson,
  runPeriodsOf,
  SignalBotVersionStatus,
  ErrorCode,
  MAX_RUNNING_VERSIONS,
  segmentStart,
  type BotVersionConfig,
  type ExperimentResult,
} from "@drift/shared";
import { and, asc, eq, inArray, isNull, max, ne, or, sql, type SQL } from "drizzle-orm";

import type { Db } from "./client";
import type { DbTx } from "./read-only";
import {
  auditLog,
  signalBotVersions,
  signalClassifierVersions,
  signalEvents,
  signalPaperTrades,
  signalStories,
} from "./schema";

// News bot versions (#303, DEC-328): đọc version đang chạy cho scheduler, và service lưu / đổi trạng thái cho API (#305).
// Config bất biến: lưu = dòng mới. Tối đa 3 version `running`: khoá advisory trong transaction ở đây + trigger DB
// `signal_bot_versions_guard` (migration 0047). Mọi lần lưu / đổi trạng thái ghi `audit_log`.

type Exec = Pick<Db, "insert" | "select" | "update" | "execute">;

export const SignalBotVersionAudit = {
  created: "signal_research.version_created",
  statusChanged: "signal_research.version_status",
} as const;

/** Lý do trong metadata audit khi version tự dừng vì thí nghiệm đủ cặp (#377). */
export const EXPERIMENT_FINISHED_REASON = "experiment_finished";

export interface SignalBotVersion {
  id: string;
  number: number;
  name: string;
  config: BotVersionConfig;
  status: SignalBotVersionStatus;
  isBaseline: boolean;
  createdAt: Date;
}

const RUNNING_LOCK = sql`select pg_advisory_xact_lock(hashtext('signal_bot_versions_running'))`;

const statusOf = (s: string): SignalBotVersionStatus =>
  s === "running" || s === "paused" || s === "stopped" || s === "retired" ? s : "retired";

/**
 * Version đang chạy (cũ nhất trước). Config không parse được (không nên xảy ra: API kiểm trước khi lưu) thì bỏ version đó
 * và trả id trong `invalid` để log, không bao giờ đoán config.
 */
export async function runningSignalBotVersions(
  db: Exec,
): Promise<{ versions: SignalBotVersion[]; invalid: string[] }> {
  const rows = await db
    .select()
    .from(signalBotVersions)
    .where(eq(signalBotVersions.status, SignalBotVersionStatus.running))
    .orderBy(asc(signalBotVersions.number));
  const versions: SignalBotVersion[] = [];
  const invalid: string[] = [];
  for (const r of rows) {
    const p = botVersionConfigSchema.safeParse(r.config);
    if (!p.success) {
      invalid.push(r.id);
      continue;
    }
    versions.push({
      id: r.id,
      number: r.number,
      name: r.name,
      config: p.data,
      status: statusOf(r.status),
      isBaseline: r.isBaseline,
      createdAt: r.createdAt,
    });
  }
  return { versions, invalid };
}

async function runningCount(db: Exec, exceptId?: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(signalBotVersions)
    .where(
      exceptId === undefined
        ? eq(signalBotVersions.status, SignalBotVersionStatus.running)
        : and(
            eq(signalBotVersions.status, SignalBotVersionStatus.running),
            ne(signalBotVersions.id, exceptId),
          ),
    );
  return r?.n ?? 0;
}

const tooMany = () =>
  new AppError(ErrorCode.stateConflict, "Pause or stop a version first.", {
    reason: "MAX_RUNNING_VERSIONS",
    max: MAX_RUNNING_VERSIONS,
  });

/**
 * Lưu một version mới (bất biến). `start` = chạy ngay (nút "Save and start"); đủ 3 version đang chạy thì từ chối
 * (`STATE_CONFLICT`, `MAX_RUNNING_VERSIONS`). Config được parse lại bằng zod ở đây.
 */
export async function createSignalBotVersion(
  db: Db,
  input: {
    name: string;
    config: unknown;
    createdBy: string | null;
    savedFromVersionId: string | null;
    start: boolean;
    /** #377: giả thuyết (một câu), bắt buộc với version mới. */
    hypothesis: string;
    ip?: string | null;
    now?: Date;
  },
): Promise<SignalBotVersion> {
  const hyp = hypothesisSchema.safeParse(input.hypothesis);
  if (!hyp.success)
    throw new AppError(ErrorCode.validationFailed, "Invalid input.", { fields: ["hypothesis"] });
  const parsed = botVersionConfigSchema.safeParse(input.config);
  if (!parsed.success)
    throw new AppError(ErrorCode.validationFailed, "Invalid input.", {
      fields: parsed.error.issues.map((i) => i.path.join(".")),
    });
  const name = input.name.trim();
  if (name.length === 0 || name.length > 60)
    throw new AppError(ErrorCode.validationFailed, "Invalid input.", { fields: ["name"] });
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx.execute(RUNNING_LOCK);
    if (input.start && (await runningCount(tx)) >= MAX_RUNNING_VERSIONS) throw tooMany();
    const [last] = await tx.select({ n: max(signalBotVersions.number) }).from(signalBotVersions);
    const number = (last?.n ?? 0) + 1;
    const status = input.start ? SignalBotVersionStatus.running : SignalBotVersionStatus.paused;
    const [row] = await tx
      .insert(signalBotVersions)
      .values({
        number,
        name,
        config: parsed.data,
        status,
        createdBy: input.createdBy,
        savedFromVersionId: input.savedFromVersionId,
        isBaseline: false,
        hypothesis: hyp.data,
        runningPeriods: runPeriodsJson(input.start ? [{ from: now, to: null }] : []),
        statusChangedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (row === undefined) throw new AppError(ErrorCode.internal, "Version not saved.");
    await tx.insert(auditLog).values({
      userId: input.createdBy,
      action: SignalBotVersionAudit.created,
      target: row.id,
      metadata: {
        number,
        name,
        status,
        savedFromVersionId: input.savedFromVersionId,
        hypothesis: hyp.data,
      },
      ip: input.ip ?? null,
    });
    return {
      id: row.id,
      number,
      name,
      config: parsed.data,
      status,
      isBaseline: false,
      createdAt: row.createdAt,
    };
  });
}

/** Chuyển trạng thái được phép: running ↔ paused; running / paused → stopped; stopped → retired. */
const NEXT: Readonly<Record<SignalBotVersionStatus, readonly SignalBotVersionStatus[]>> = {
  running: ["paused", "stopped"],
  paused: ["running", "stopped"],
  stopped: ["retired"],
  retired: [],
};

/**
 * Pause / Resume / Stop / Retire một version; ghi audit. Resume khi đã có 3 version chạy → `MAX_RUNNING_VERSIONS`.
 * `finish` (#377): version tự dừng vì thí nghiệm đủ cặp — chỉ đi running / paused → stopped qua đúng state machine này, ghi
 * kết quả đóng băng cùng transaction, audit lý do `experiment_finished`. Baseline không bao giờ được dừng theo cách này.
 */
export async function setSignalBotVersionStatus(
  db: Db,
  input: {
    id: string;
    status: SignalBotVersionStatus;
    userId: string | null;
    ip?: string | null;
    now?: Date;
    finish?: ExperimentResult;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    await tx.execute(RUNNING_LOCK);
    const [row] = await tx
      .select({
        status: signalBotVersions.status,
        number: signalBotVersions.number,
        isBaseline: signalBotVersions.isBaseline,
        finishedAt: signalBotVersions.experimentFinishedAt,
        runningPeriods: signalBotVersions.runningPeriods,
        createdAt: signalBotVersions.createdAt,
        statusChangedAt: signalBotVersions.statusChangedAt,
      })
      .from(signalBotVersions)
      .where(eq(signalBotVersions.id, input.id))
      .for("update");
    if (row === undefined) throw new AppError(ErrorCode.notFound, "Version not found.");
    const from = statusOf(row.status);
    const finish = input.finish;
    if (finish !== undefined) {
      if (row.isBaseline)
        throw new AppError(ErrorCode.stateConflict, "Baseline is never an experiment.", {
          reason: "BASELINE",
        });
      if (input.status !== SignalBotVersionStatus.stopped)
        throw new AppError(ErrorCode.internal, "An experiment finishes by stopping.");
      if (row.finishedAt !== null) return;
    }
    if (from === input.status) return;
    if (!NEXT[from].includes(input.status))
      throw new AppError(ErrorCode.stateConflict, "This change is not allowed.", {
        from,
        to: input.status,
      });
    if (
      input.status === SignalBotVersionStatus.running &&
      (await runningCount(tx, input.id)) >= MAX_RUNNING_VERSIONS
    )
      throw tooMany();
    await tx
      .update(signalBotVersions)
      .set({
        status: input.status,
        statusChangedAt: now,
        updatedAt: now,
        runningPeriods: runPeriodsJson(
          nextRunPeriods(
            runPeriodsOf({
              runningPeriods: row.runningPeriods,
              status: from,
              createdAt: row.createdAt,
              statusChangedAt: row.statusChangedAt,
            }),
            input.status,
            now,
          ),
        ),
        ...(finish === undefined ? {} : { experimentFinishedAt: now, experimentResult: finish }),
      })
      .where(eq(signalBotVersions.id, input.id));
    await tx.insert(auditLog).values({
      userId: input.userId,
      action: SignalBotVersionAudit.statusChanged,
      target: input.id,
      metadata:
        finish === undefined
          ? { number: row.number, from, to: input.status }
          : {
              number: row.number,
              from,
              to: input.status,
              reason: EXPERIMENT_FINISHED_REASON,
              result: finish,
            },
      ip: input.ip ?? null,
    });
  });
}

/**
 * Ghi version prompt classifier lần đầu thấy (mốc bắt đầu đoạn đếm mới của mọi version đang chạy, DEC-328 mục 2). Đã có thì
 * giữ mốc cũ.
 */
export async function noteClassifierVersion(
  db: Exec,
  input: { promptVersion: string; model: string; at: Date },
): Promise<void> {
  await db
    .insert(signalClassifierVersions)
    .values({ promptVersion: input.promptVersion, model: input.model, startedAt: input.at })
    .onConflictDoNothing();
}

/**
 * Mốc bắt đầu đoạn đếm hiện tại của một version: lệnh tính cho version khi mở sau lúc lưu version VÀ sau lúc classifier
 * hiện tại bắt đầu (lấy mốc sau). Classifier chưa ghi → lúc lưu version.
 */
export async function versionSegmentStart(
  db: Exec,
  input: { versionCreatedAt: Date; promptVersion: string },
): Promise<Date> {
  const [c] = await db
    .select({ at: signalClassifierVersions.startedAt })
    .from(signalClassifierVersions)
    .where(eq(signalClassifierVersions.promptVersion, input.promptVersion));
  return segmentStart(input.versionCreatedAt, c?.at ?? null);
}

// ── Lọc theo version cho tổng kết / feed / trace / danh sách lệnh (#305) ────────────────────────────────────────────

/** Version được chọn của một request đọc (mặc định Baseline). */
export interface SignalVersionScope {
  id: string;
  number: number;
  name: string;
  isBaseline: boolean;
  /** null khi config trong DB không parse được (không bao giờ đoán). */
  config: BotVersionConfig | null;
  createdAt: Date;
}

/**
 * `versionId` của query → version; không có → Baseline. Id không tồn tại → 404. Không có Baseline (DB chưa migrate 0047)
 * → null: nơi gọi giữ cách lọc cũ (không theo version).
 */
export async function resolveSignalVersion(
  q: Db | DbTx,
  versionId: string | undefined,
): Promise<SignalVersionScope | null> {
  const [row] = await q
    .select()
    .from(signalBotVersions)
    .where(
      versionId === undefined
        ? eq(signalBotVersions.isBaseline, true)
        : eq(signalBotVersions.id, versionId),
    );
  if (row === undefined) {
    if (versionId === undefined) return null;
    throw new AppError(ErrorCode.notFound, "Version not found.");
  }
  const p = botVersionConfigSchema.safeParse(row.config);
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    isBaseline: row.isBaseline,
    config: p.success ? p.data : null,
    createdAt: row.createdAt,
  };
}

/**
 * Lệnh / story của version. Baseline gồm cả dòng `version_id` null (trước migration 0047: lịch sử news-v2, và dòng ghi
 * trước khi có version); tổng kết vẫn lọc `rule_version` riêng nên news-v2 không trộn vào số của Baseline (DEC-331).
 */
export function versionTradeWhere(v: SignalVersionScope | null): SQL | undefined {
  if (v === null) return undefined;
  return v.isBaseline
    ? or(eq(signalPaperTrades.versionId, v.id), isNull(signalPaperTrades.versionId))
    : eq(signalPaperTrades.versionId, v.id);
}

export function versionStoryWhere(v: SignalVersionScope | null): SQL | undefined {
  if (v === null) return undefined;
  return v.isBaseline
    ? or(eq(signalStories.versionId, v.id), isNull(signalStories.versionId))
    : eq(signalStories.versionId, v.id);
}

/** Bước dùng chung cho mọi version (classifier): event không có `version_id`. */
export const SHARED_STAGES = ["collect", "normalize", "understand"] as const;

/** Event của version: bước dùng chung + Filter / Decide / Watch của chính version đó. */
export function versionEventWhere(v: SignalVersionScope | null): SQL | undefined {
  if (v === null) return undefined;
  return v.isBaseline
    ? or(eq(signalEvents.versionId, v.id), isNull(signalEvents.versionId))
    : or(
        eq(signalEvents.versionId, v.id),
        and(isNull(signalEvents.versionId), inArray(signalEvents.stage, [...SHARED_STAGES])),
      );
}

/** Như `versionEventWhere` cho SQL thô với alias bảng event (`e`). */
export function versionEventSql(v: SignalVersionScope | null, alias: string): SQL {
  if (v === null) return sql`true`;
  const col = sql.raw(`${alias}.version_id`);
  const stage = sql.raw(`${alias}.stage`);
  return v.isBaseline
    ? sql`(${col} = ${v.id} or ${col} is null)`
    : sql`(${col} = ${v.id} or (${col} is null and ${stage} in ('collect', 'normalize', 'understand')))`;
}
