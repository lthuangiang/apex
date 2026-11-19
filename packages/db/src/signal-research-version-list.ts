import {
  availableBalance,
  botVersionConfigSchema,
  classifierGate,
  dec,
  Decimal,
  diffVersionConfig,
  effectiveMaxOpenTrades,
  extraCheckOn,
  gateStatus,
  MAX_RUNNING_VERSIONS,
  NEWS_CLASSIFIER,
  NEWS_RULES,
  segmentStart,
  summarizeByDay,
  VERSION_REPEAT_TRADES,
  VERSION_START_BALANCE,
  versionGateStatus,
  type BotVersionConfig,
  type DayObs,
  type GateStatus,
  type ResearchVersion,
  type ResearchVersions,
  type SignalBotVersionStatus,
} from "@drift/shared";
import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm";

import type { Db } from "./client";
import type { DbTx } from "./read-only";
import { signalBotVersions, signalClassifierVersions, signalPaperTrades } from "./schema";
import { classifierStatusOf, loadClassifierGates } from "./signal-research-labels";

// Danh sách News bot version cho khối Paper bots (#305, DEC-328; thiết kế docs/mockups/signal-research/bot-versions.html).
// Chỉ đọc; nơi gọi bọc trong transaction chỉ đọc. Mọi số lấy từ lệnh đã lưu; thiếu thì null, không bao giờ đoán.
//
// - Lệnh của Baseline gồm cả lệnh news `version_id` null của version quy tắc hiện tại (dòng ghi trước khi có version), như
//   tổng kết; lịch sử news-v2 không tính (DEC-331).
// - Đoạn đếm hiện tại = lệnh thật đã đóng của classifier hiện tại, mở sau `segmentStart` (mốc sau của lúc lưu version và
//   lúc classifier bắt đầu). Cổng của version chỉ xét đoạn này, theo thứ tự đóng (`versionGateStatus`).

type Q = Db | DbTx;
const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString();
const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

const statusOf = (s: string): SignalBotVersionStatus =>
  s === "running" || s === "paused" || s === "stopped" || s === "retired" ? s : "retired";

interface TradeLite {
  id: string;
  versionId: string | null;
  status: string;
  classifierVersion: string | null;
  openedAt: Date;
  exitedAt: Date | null;
  sizeUsdc: string;
  resultUsdc: string | null;
  resultPct: string | null;
  randomPct: string | null;
  feePct: string;
  spreadAtEntryPct: string;
}

/** Cổng (`gateStatus`) trên một dãy lệnh đã đóng, cùng cách tính với dòng tổng kết (kết quả, ngẫu nhiên, chi phí). */
export function gateOfTrades(rows: readonly TradeLite[]): GateStatus {
  const obs = (v: (t: TradeLite) => string | null): DayObs[] =>
    rows.flatMap((t) => {
      const x = v(t);
      return x === null ? [] : [{ v: dec(x), at: t.openedAt.getTime() }];
    });
  const diff = summarizeByDay(
    obs((t) =>
      t.resultPct === null || t.randomPct === null
        ? null
        : dec(t.resultPct).sub(dec(t.randomPct)).toFixed(),
    ),
  );
  const avgCost =
    rows.length === 0
      ? null
      : rows
          .reduce(
            (s, t) => s.add(dec(t.feePct).mul(2).add(dec(t.spreadAtEntryPct))),
            new Decimal(0),
          )
          .div(rows.length);
  return gateStatus({
    results: obs((t) => t.resultPct),
    avgCostPct: avgCost,
    difference: diff.n === 0 ? null : diff,
  });
}

/** 4 ký tự cuối id người lưu (như "··a91f" của thiết kế). */
const tailOf = (id: string | null): string | null =>
  id === null ? null : id.replace(/-/g, "").slice(-4).toLowerCase();

/** Mọi News bot version, mới nhất trước, kèm số dư, giới hạn, lệnh bị chặn và trạng thái cổng. */
export async function loadSignalBotVersions(
  q: Q,
  now: Date,
  check: () => void = () => undefined,
): Promise<ResearchVersions> {
  const rows = await q.select().from(signalBotVersions).orderBy(desc(signalBotVersions.number));
  check();
  const baseline = rows.find((r) => r.isBaseline)?.id ?? null;
  const trades: TradeLite[] = await q
    .select({
      id: signalPaperTrades.id,
      versionId: signalPaperTrades.versionId,
      status: signalPaperTrades.status,
      classifierVersion: signalPaperTrades.classifierVersion,
      openedAt: signalPaperTrades.openedAt,
      exitedAt: signalPaperTrades.exitedAt,
      sizeUsdc: signalPaperTrades.sizeUsdc,
      resultUsdc: signalPaperTrades.resultUsdc,
      resultPct: signalPaperTrades.resultPct,
      randomPct: signalPaperTrades.randomPct,
      feePct: signalPaperTrades.feePct,
      spreadAtEntryPct: signalPaperTrades.spreadAtEntryPct,
    })
    .from(signalPaperTrades)
    .where(
      and(
        eq(signalPaperTrades.lane, NEWS_RULES.lane),
        eq(signalPaperTrades.label, "live"),
        or(
          isNotNull(signalPaperTrades.versionId),
          eq(signalPaperTrades.ruleVersion, NEWS_RULES.version),
        ),
      ),
    );
  check();
  const shadows = await q
    .select({ versionId: signalPaperTrades.versionId, n: sql<number>`count(*)::int` })
    .from(signalPaperTrades)
    .where(
      and(
        eq(signalPaperTrades.lane, NEWS_RULES.lane),
        eq(signalPaperTrades.label, "shadow"),
        isNotNull(signalPaperTrades.versionId),
      ),
    )
    .groupBy(signalPaperTrades.versionId);
  check();
  const gates = await loadClassifierGates(q);
  check();
  const started = new Map(
    (await q.select().from(signalClassifierVersions)).map((c) => [
      c.promptVersion,
      toDate(c.startedAt),
    ]),
  );
  check();

  const byVersion = new Map<string, TradeLite[]>();
  for (const t of trades) {
    const v = t.versionId ?? baseline;
    if (v === null) continue;
    byVersion.set(v, [...(byVersion.get(v) ?? []), t]);
  }
  const blocked = new Map(shadows.map((s) => [s.versionId, s.n]));
  const configs = new Map<string, BotVersionConfig | null>(
    rows.map((r) => {
      const p = botVersionConfigSchema.safeParse(r.config);
      return [r.id, p.success ? p.data : null];
    }),
  );
  const numbers = new Map(rows.map((r) => [r.id, r.number]));
  const current = NEWS_CLASSIFIER.promptVersion;
  const currentGate = gates.get(current) ?? classifierGate({ labeled: 0, right: 0 });
  const currentStatus = classifierStatusOf(gates, current);
  const versionsTried = rows.reduce((m, r) => Math.max(m, r.number), 0);
  const dayStart = Math.floor(now.getTime() / DAY_MS) * DAY_MS;

  const items: ResearchVersion[] = rows.map((r) => {
    const cfg = configs.get(r.id) ?? null;
    const mine = byVersion.get(r.id) ?? [];
    const closed = mine.filter((t) => t.status === "closed" && t.resultPct !== null);
    const open = mine.filter((t) => t.status !== "closed");
    const realized = mine.reduce(
      (s, t) => (t.status === "closed" && t.resultUsdc !== null ? s.add(dec(t.resultUsdc)) : s),
      new Decimal(0),
    );
    const openSize = open.reduce((s, t) => s.add(dec(t.sizeUsdc)), new Decimal(0));
    const segStart = segmentStart(toDate(r.createdAt), started.get(current) ?? null);
    const segment = closed
      .filter((t) => t.classifierVersion === current && t.openedAt >= segStart)
      .sort(
        (a, b) =>
          (a.exitedAt?.getTime() ?? 0) - (b.exitedAt?.getTime() ?? 0) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const counted = currentStatus === "passed" ? segment : [];
    const countedIds = new Set(counted.map((t) => t.id));
    const notCounted = new Map<string | null, number>();
    for (const t of closed)
      if (!countedIds.has(t.id))
        notCounted.set(t.classifierVersion, (notCounted.get(t.classifierVersion) ?? 0) + 1);
    const gate = versionGateStatus({
      classifier: currentStatus,
      closed: closed.length,
      segmentClosed: segment.length,
      versionsTried,
      gateOf: (from, to) => gateOfTrades(segment.slice(from, to)),
    });
    const used: string[] = [];
    for (const t of [...mine].sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime()))
      if (t.classifierVersion !== null && !used.includes(t.classifierVersion))
        used.push(t.classifierVersion);
    const parent = r.savedFromVersionId === null ? undefined : configs.get(r.savedFromVersionId);
    const parentNumber =
      r.savedFromVersionId === null ? undefined : numbers.get(r.savedFromVersionId);
    const avg =
      counted.length === 0
        ? null
        : counted
            .reduce((s, t) => s.add(dec(t.resultPct ?? "0")), new Decimal(0))
            .div(counted.length)
            .toDecimalPlaces(4)
            .toNumber();
    return {
      id: r.id,
      number: r.number,
      name: r.name,
      status: statusOf(r.status),
      isBaseline: r.isBaseline,
      createdAt: iso(toDate(r.createdAt)),
      statusChangedAt: iso(toDate(r.statusChangedAt)),
      createdBy: tailOf(r.createdBy),
      savedFrom:
        r.savedFromVersionId === null || parentNumber === undefined
          ? null
          : { id: r.savedFromVersionId, number: parentNumber },
      config: cfg,
      changedFromPrevious:
        cfg === null || parent === undefined || parent === null
          ? null
          : diffVersionConfig(parent, cfg),
      classifier: { current, segmentStart: iso(segStart), used },
      balance: realized.add(dec(VERSION_START_BALANCE)).toDecimalPlaces(6).toFixed(),
      available: availableBalance({ closedResultUsdc: realized, openSizeUsdc: openSize })
        .toDecimalPlaces(6)
        .toFixed(),
      openTrades: open.length,
      maxOpenTrades: cfg?.maxOpenTrades ?? null,
      effectiveMaxOpen: cfg === null ? null : effectiveMaxOpenTrades(cfg),
      todayTrades: mine.filter((t) => t.openedAt.getTime() >= dayStart).length,
      maxNewTradesPerDay: cfg?.maxNewTradesPerDay ?? null,
      blockedByLimit: blocked.get(r.id) ?? 0,
      closed: closed.length,
      counted: counted.length,
      avgPct: avg,
      gate: {
        status: gate.status,
        segmentClosed: segment.length,
        classifierStatus: currentStatus,
        labelsToGo: currentGate.labelsToGo,
        notCounted: [...notCounted].map(([version, n]) => {
          const g =
            version === null
              ? null
              : (gates.get(version) ?? classifierGate({ labeled: 0, right: 0 }));
          return {
            classifierVersion: version,
            closed: n,
            status: classifierStatusOf(gates, version),
            labelsToGo: g?.labelsToGo ?? null,
          };
        }),
        firstPassAt: gate.firstPassAt,
        repeat: gate.repeat,
      },
    };
  });

  const startedAt = started.get(current);
  return {
    items,
    running: rows.filter((r) => r.status === "running").length,
    maxRunning: MAX_RUNNING_VERSIONS,
    versionsTried,
    extraCheck: extraCheckOn(versionsTried),
    repeatTrades: VERSION_REPEAT_TRADES,
    classifier: {
      current,
      startedAt: startedAt === undefined ? null : iso(startedAt),
      labeled: currentGate.labeled,
      precisionPct: currentGate.precisionPct,
      passes: currentGate.passes,
      status: currentGate.status,
      labelsToGo: currentGate.labelsToGo,
    },
  };
}
