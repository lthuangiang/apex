import {
  botVersionConfigSchema,
  changedThings,
  diffVersionConfig,
  experimentResult,
  experimentResultSchema,
  NEWS_RULES,
  pairWithBaseline,
  runPeriodsOf,
  SignalBotVersionStatus,
  type BotVersionConfig,
  type ExperimentResult,
  type PairTrade,
  type ResearchExperiment,
} from "@drift/shared";
import { and, eq, inArray, isNull, or } from "drizzle-orm";

import type { Db } from "./client";
import { signalBotVersions, signalPaperTrades } from "./schema";
import { setSignalBotVersionStatus } from "./signal-research-versions";

// Sổ thí nghiệm (#377, DEC-348 / DEC-351): mỗi version (trừ Baseline) so ghép cặp với Baseline
// CỐ ĐỊNH trên HỢP các tín hiệu (câu chuyện + market) mà ít nhất một bên đã vào lệnh; bên không vào lệnh tính 0. Đủ 100 cặp lệnh đã đóng thì version (có giả thuyết) tự dừng qua state machine của
// version (`setSignalBotVersionStatus`, có audit) và kết quả được đóng băng. Không đổi logic giao dịch; Baseline không bao
// giờ bị dừng ở đây.

/** Lệnh news thật (label live) để ghép cặp; `versionId` null = lệnh news-v3 trước khi có version (thuộc Baseline). */
export interface ExperimentTrade extends PairTrade {
  versionId: string | null;
}

interface VersionRow {
  id: string;
  config: unknown;
  status: string;
  createdAt: Date;
  statusChangedAt: Date;
  isBaseline: boolean;
  experimentFinishedAt: Date | null;
  experimentResult: unknown;
  runningPeriods: unknown;
}

/** Lệnh của version và các khoảng nó chạy, cho `pairWithBaseline`. */
const sideOf = (v: VersionRow, trades: ReadonlyMap<string, readonly ExperimentTrade[]>) => ({
  trades: trades.get(v.id) ?? [],
  running: runPeriodsOf(v),
});

/**
 * Thí nghiệm của một version so với Baseline. Đã Finished → kết quả đóng băng; chưa → tính từ lệnh hiện có. Baseline → null.
 */
export function experimentOf(input: {
  version: VersionRow;
  baseline: (VersionRow & { number: number; parsed: BotVersionConfig | null }) | null;
  trades: ReadonlyMap<string, readonly ExperimentTrade[]>;
}): ResearchExperiment | null {
  const { version: v, baseline } = input;
  if (v.isBaseline || baseline === null) return null;
  const cfg = botVersionConfigSchema.safeParse(v.config);
  const changes =
    cfg.success && baseline.parsed !== null ? diffVersionConfig(baseline.parsed, cfg.data) : null;
  const things = changes === null ? null : changedThings(changes).length;
  const frozen =
    v.experimentFinishedAt === null ? null : experimentResultSchema.safeParse(v.experimentResult);
  const result: ExperimentResult =
    frozen?.success === true
      ? frozen.data
      : experimentResult(pairWithBaseline(sideOf(v, input.trades), sideOf(baseline, input.trades)));
  return {
    control: { id: baseline.id, number: baseline.number },
    changes,
    changedThings: things,
    clean: things === null ? null : things === 1,
    ...result,
    finishedAt: v.experimentFinishedAt === null ? null : v.experimentFinishedAt.toISOString(),
  };
}

/** Gom lệnh theo version; lệnh `version_id` null (news-v3 trước version) thuộc Baseline. */
export function tradesByVersion(
  trades: readonly ExperimentTrade[],
  baselineId: string | null,
): Map<string, ExperimentTrade[]> {
  const out = new Map<string, ExperimentTrade[]>();
  for (const t of trades) {
    const v = t.versionId ?? baselineId;
    if (v === null) continue;
    const list = out.get(v);
    if (list === undefined) out.set(v, [t]);
    else list.push(t);
  }
  return out;
}

/**
 * Dừng mọi thí nghiệm đã đủ cặp: version không phải Baseline, có giả thuyết (version từ #377), đang chạy / tạm dừng, chưa
 * Finished. Trả các version vừa dừng. Mỗi version dừng trong transaction riêng (khoá + audit của state machine).
 */
export async function finishSignalExperiments(
  db: Db,
  now: Date,
): Promise<{ id: string; number: number; result: ExperimentResult }[]> {
  const rows = await db.select().from(signalBotVersions);
  const baseline = rows.find((r) => r.isBaseline) ?? null;
  if (baseline === null) return [];
  const due = rows.filter(
    (r) =>
      !r.isBaseline &&
      r.hypothesis !== null &&
      r.experimentFinishedAt === null &&
      (r.status === SignalBotVersionStatus.running || r.status === SignalBotVersionStatus.paused),
  );
  if (due.length === 0) return [];
  const ids = [baseline.id, ...due.map((r) => r.id)];
  const trades: ExperimentTrade[] = await db
    .select({
      versionId: signalPaperTrades.versionId,
      market: signalPaperTrades.market,
      catalyst: signalPaperTrades.catalyst,
      eventAt: signalPaperTrades.eventAt,
      status: signalPaperTrades.status,
      resultPct: signalPaperTrades.resultPct,
      openedAt: signalPaperTrades.openedAt,
      exitedAt: signalPaperTrades.exitedAt,
    })
    .from(signalPaperTrades)
    .where(
      and(
        eq(signalPaperTrades.lane, NEWS_RULES.lane),
        // Cả lệnh đang mở: cặp có lệnh chưa đóng thì chưa đếm (không coi là "không vào lệnh").
        eq(signalPaperTrades.label, "live"),
        or(
          inArray(signalPaperTrades.versionId, ids),
          and(
            isNull(signalPaperTrades.versionId),
            eq(signalPaperTrades.ruleVersion, NEWS_RULES.version),
          ),
        ),
      ),
    );
  const byVersion = tradesByVersion(trades, baseline.id);
  const baseSide = sideOf(baseline, byVersion);
  const finished: { id: string; number: number; result: ExperimentResult }[] = [];
  for (const r of due) {
    const result = experimentResult(pairWithBaseline(sideOf(r, byVersion), baseSide));
    if (result.verdict === "collecting") continue;
    await setSignalBotVersionStatus(db, {
      id: r.id,
      status: SignalBotVersionStatus.stopped,
      userId: null,
      now,
      finish: result,
    });
    finished.push({ id: r.id, number: r.number, result });
  }
  return finished;
}
