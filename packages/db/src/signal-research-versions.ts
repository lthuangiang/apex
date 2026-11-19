import {
  AppError,
  botVersionConfigSchema,
  SignalBotVersionStatus,
  ErrorCode,
  MAX_RUNNING_VERSIONS,
  type BotVersionConfig,
} from "@drift/shared";
import { and, asc, eq, max, ne, sql } from "drizzle-orm";

import type { Db } from "./client";
import { auditLog, signalBotVersions, signalClassifierVersions } from "./schema";

// News bot versions (#303, DEC-328): đọc version đang chạy cho scheduler, và service lưu / đổi trạng thái cho API (#305).
// Config bất biến: lưu = dòng mới. Tối đa 3 version `running`: khoá advisory trong transaction ở đây + trigger DB
// `signal_bot_versions_guard` (migration 0046). Mọi lần lưu / đổi trạng thái ghi `audit_log`.

type Exec = Pick<Db, "insert" | "select" | "update" | "execute">;

export const SignalBotVersionAudit = {
  created: "signal_research.version_created",
  statusChanged: "signal_research.version_status",
} as const;

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
    ip?: string | null;
    now?: Date;
  },
): Promise<SignalBotVersion> {
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
      metadata: { number, name, status, savedFromVersionId: input.savedFromVersionId },
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

/** Pause / Resume / Stop / Retire một version; ghi audit. Resume khi đã có 3 version chạy → `MAX_RUNNING_VERSIONS`. */
export async function setSignalBotVersionStatus(
  db: Db,
  input: {
    id: string;
    status: SignalBotVersionStatus;
    userId: string | null;
    ip?: string | null;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    await tx.execute(RUNNING_LOCK);
    const [row] = await tx
      .select({ status: signalBotVersions.status, number: signalBotVersions.number })
      .from(signalBotVersions)
      .where(eq(signalBotVersions.id, input.id))
      .for("update");
    if (row === undefined) throw new AppError(ErrorCode.notFound, "Version not found.");
    const from = statusOf(row.status);
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
      .set({ status: input.status, statusChangedAt: now, updatedAt: now })
      .where(eq(signalBotVersions.id, input.id));
    await tx.insert(auditLog).values({
      userId: input.userId,
      action: SignalBotVersionAudit.statusChanged,
      target: input.id,
      metadata: { number: row.number, from, to: input.status },
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
  if (c === undefined || c.at <= input.versionCreatedAt) return input.versionCreatedAt;
  return c.at;
}
