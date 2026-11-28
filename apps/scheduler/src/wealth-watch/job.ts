import { outbox, sodexAccounts, users, wealthWatch, type Db } from "@drift/db";
import {
  UserRole,
  type WealthNotificationType,
  type WealthRecurringIssueData,
  type WealthRequestSettledData,
} from "@drift/shared";
import type { WealthReadClient, WealthReadResult } from "@drift/sodex";
import { and, asc, eq, lte } from "drizzle-orm";

import { backoffMs, nextCheckAt } from "../rewards-watch/classify";

import {
  classifyExecutions,
  classifyFundEntries,
  shouldReadPlans,
  type ExecutionNotice,
  type FundNotice,
  type UnknownValue,
} from "./classify";

// Job cảnh báo SoDEX Wealth (#594, DEC-402 mục 7, DEC-404). Chạy ở scheduler (một leader). Mỗi lượt lấy các dòng
// `wealth_watch` tới hạn; mỗi user đọc dữ liệu Wealth CÔNG KHAI theo master wallet (không token) qua client chỉ đọc dùng
// chung trần Wealth với `/wealth/me` (job chỉ lấy khi trần còn > 50%): `fund-details`, `recurring-buys` (chỉ khi user có
// plan), `executions` của từng plan ACTIVE. So với mốc ở DB rồi ghi thông báo vào outbox `jobs.notify` CÙNG transaction
// với mốc mới (crash giữa chừng thì lượt sau đọc lại, `dedupeKey` chặn bản trùng). Lượt đầu chỉ đặt mốc. Không log địa
// chỉ ví.

export interface WealthWatchJobDeps {
  db: Db;
  now: () => Date;
  reader: Pick<
    WealthReadClient,
    "getFundDetails" | "getRecurringBuys" | "getRecurringBuyExecutions" | "getFunds"
  >;
  /** `WEALTH_WATCH_ENABLED`. Tắt thì job chỉ đọc cho user role team (thử bằng ví thật trước khi bật cho mọi người). */
  enabled: boolean;
  /** Chu kỳ đọc mỗi user (`WEALTH_WATCH_INTERVAL_MIN`). */
  intervalMs: number;
  /** Số user tối đa mỗi lượt (trần weight vẫn do bucket của client quyết). */
  batch: number;
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

export interface WealthWatchTickResult {
  checked: number;
  baselined: number;
  notified: number;
  removed: number;
  errors: number;
  /** Lượt dừng sớm vì hết ngân sách weight (`budget`): dời sang lượt sau, không tính lỗi. */
  stopped: "budget" | null;
}

/** Tên quỹ (`GET /funds`) giữ trong bộ nhớ ngần này; chỉ đọc khi có tin cần gửi. */
export const FUND_NAMES_TTL_MS = 30 * 60_000;

type Row = typeof wealthWatch.$inferSelect;
type Failure = Extract<WealthReadResult<unknown>, { kind: "not_provided" }>;

interface Notice {
  type: WealthNotificationType;
  data: WealthRequestSettledData | WealthRecurringIssueData;
  dedupeKey: string;
}

const notifyRow = (userId: string, n: Notice) => ({
  topic: "jobs.notify",
  payload: { userId, type: n.type, data: n.data, dedupeKey: n.dedupeKey },
});

/** Cache tên quỹ dùng chung giữa các user trong process (dữ liệu công khai). */
export function createFundNames(ttlMs = FUND_NAMES_TTL_MS) {
  let cache: { at: number; names: Map<string, string> } | null = null;
  return async (
    reader: Pick<WealthReadClient, "getFunds">,
    nowMs: number,
  ): Promise<Map<string, string>> => {
    if (cache !== null && nowMs - cache.at < ttlMs) return cache.names;
    const r = await reader.getFunds();
    // Không đọc được: tin dùng `fundId` (không chặn tin, không lưu cache lỗi).
    if (r.kind !== "ok") return cache?.names ?? new Map();
    cache = { at: nowMs, names: new Map(r.data.map((f) => [f.fundId, f.name])) };
    return cache.names;
  };
}
const defaultFundNames = createFundNames();

async function backoffRow(db: Db, row: Row, code: string, now: Date, intervalMs: number) {
  const errors = row.consecutiveErrors + 1;
  await db
    .update(wealthWatch)
    .set({
      consecutiveErrors: errors,
      lastErrorCode: code.slice(0, 64),
      lastCheckedAt: now,
      nextCheckAt: new Date(now.getTime() + backoffMs(intervalMs, errors)),
    })
    .where(eq(wealthWatch.userId, row.userId));
}

const failCode = (where: string, f: Failure) =>
  `${where}_${f.reason}${f.status === undefined ? "" : `_${String(f.status)}`}`;

function fundNotice(n: FundNotice, names: Map<string, string>): Notice {
  const e = n.entry;
  return {
    type: "wealth_request_settled",
    data: {
      fundId: e.fundId,
      fundName: names.get(e.fundId) ?? null,
      what: n.what,
      status: n.status,
      cost: e.cost,
      proceeds: e.proceeds,
      shares: e.shares ?? e.requestedShares,
    },
    dedupeKey: `wf:${n.key}:${n.status}`,
  };
}

function executionNotice(
  n: ExecutionNotice,
  fundId: string | null,
  names: Map<string, string>,
): Notice {
  return {
    type: "wealth_recurring_issue",
    data: {
      fundId,
      fundName: fundId === null ? null : (names.get(fundId) ?? null),
      status: n.status,
      reasonCode: n.reasonCode,
      scheduledDate: n.execution.scheduledLocalDate,
      amount: n.execution.amount,
    },
    dedupeKey: `wx:${n.key}:${n.status}`,
  };
}

interface Due {
  row: Row;
  address: string | null;
  accountUserId: string | null;
  accountStatus: string | null;
}

/** Một user. `"budget"` = hết ngân sách, dừng cả lượt (không ghi gì, lượt sau đọc lại). */
async function processRow(
  deps: WealthWatchJobDeps,
  due: Due,
  result: WealthWatchTickResult,
  fundNames: ReturnType<typeof createFundNames>,
): Promise<"budget" | null> {
  const { db } = deps;
  const { row } = due;
  const now = deps.now();
  // Ngắt SoDEX / đổi ví mà dòng còn (api thường đã xoá; đây là lưới an toàn): xoá dòng, không đọc.
  if (
    due.address === null ||
    due.accountUserId !== row.userId ||
    due.accountStatus !== "connected"
  ) {
    await db.delete(wealthWatch).where(eq(wealthWatch.userId, row.userId));
    result.removed += 1;
    return null;
  }
  const address = due.address;
  const baseline = row.baselinePending;
  const unknown: UnknownValue[] = [];

  const details = await deps.reader.getFundDetails(address);
  if (details.kind !== "ok") {
    if (details.reason === "budget") return "budget";
    await backoffRow(db, row, failCode("fund_details", details), now, deps.intervalMs);
    result.errors += 1;
    return null;
  }
  const entries = details.data.entries;
  const funds = classifyFundEntries(entries, row.fundMarks, baseline);
  unknown.push(...funds.unknown);

  // Mua định kỳ. `code -1` (envelope lỗi, `business`) = không có kế hoạch, không tính lỗi (mục 3c).
  let hasPlans = row.hasPlans;
  let plansCheckedAt = row.plansCheckedAt;
  let execMarks: Record<string, string> = row.execMarks;
  const execNotices: { notice: ExecutionNotice; fundId: string | null }[] = [];
  let planError: string | null = null;
  if (shouldReadPlans(row.hasPlans, entries, row.plansCheckedAt, now.getTime())) {
    const plans = await deps.reader.getRecurringBuys(address, "active");
    if (plans.kind === "ok" || plans.reason === "business") {
      const list = plans.kind === "ok" ? plans.data.plans : [];
      hasPlans = list.length > 0;
      plansCheckedAt = now;
      const nextExec: Record<string, string> = {};
      for (const plan of list) {
        if (plan.status !== "ACTIVE") continue;
        const ex = await deps.reader.getRecurringBuyExecutions(
          address,
          plan.planIndex,
          plan.dcaAddress ?? undefined,
        );
        if (ex.kind !== "ok") {
          if (ex.reason === "budget") return "budget";
          planError = failCode("executions", ex);
          // Giữ mốc cũ của plan này để lượt sau so tiếp.
          for (const [k, v] of Object.entries(row.execMarks))
            if (k.startsWith(`${plan.planIndex}:`)) nextExec[k] = v;
          continue;
        }
        const c = classifyExecutions(
          plan.planIndex,
          plan.dcaAddress,
          ex.data.executions,
          row.execMarks,
          baseline,
        );
        Object.assign(nextExec, c.marks);
        unknown.push(...c.unknown);
        for (const notice of c.notices) execNotices.push({ notice, fundId: plan.fundId });
      }
      execMarks = nextExec;
    } else if (plans.reason === "budget") {
      return "budget";
    } else {
      planError = failCode("recurring_buys", plans);
    }
  }

  // Giá trị SoDEX lạ: không báo, chỉ log (mục 3b). Không địa chỉ ví; mỗi giá trị một lần mỗi user mỗi lượt.
  const seen = new Set<string>();
  for (const u of unknown) {
    const k = `${u.field}:${u.value}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deps.log?.warn(
      { userId: row.userId, field: u.field, value: u.value.slice(0, 32) },
      "wealth watch: unknown SoDEX value, not alerted",
    );
  }

  const count = funds.notices.length + execNotices.length;
  const names =
    count === 0 ? new Map<string, string>() : await fundNames(deps.reader, now.getTime());
  const notices: Notice[] = [
    ...funds.notices.map((n) => fundNotice(n, names)),
    ...execNotices.map((x) => executionNotice(x.notice, x.fundId, names)),
  ];

  const errors = planError === null ? 0 : row.consecutiveErrors + 1;
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(wealthWatch)
      .set({
        baselinePending: false,
        fundMarks: funds.marks,
        execMarks,
        hasPlans,
        plansCheckedAt,
        consecutiveErrors: errors,
        lastErrorCode: planError,
        lastCheckedAt: now,
        nextCheckAt:
          planError === null
            ? nextCheckAt(now, deps.intervalMs, row.userId)
            : new Date(now.getTime() + backoffMs(deps.intervalMs, errors)),
      })
      .where(eq(wealthWatch.userId, row.userId))
      .returning({ userId: wealthWatch.userId });
    // Dòng vừa bị tắt / xoá giữa lượt: không báo.
    if (updated.length === 0 || notices.length === 0) return;
    await tx.insert(outbox).values(notices.map((n) => notifyRow(row.userId, n)));
  });
  result.checked += 1;
  if (baseline) result.baselined += 1;
  if (planError !== null) result.errors += 1;
  result.notified += notices.length;
  return null;
}

/** Một lượt của job. Không ném lỗi theo từng user: lỗi một user thì lùi user đó, lượt tiếp tục. */
export async function runWealthWatchTick(
  deps: WealthWatchJobDeps,
  fundNames: ReturnType<typeof createFundNames> = defaultFundNames,
): Promise<WealthWatchTickResult> {
  const result: WealthWatchTickResult = {
    checked: 0,
    baselined: 0,
    notified: 0,
    removed: 0,
    errors: 0,
    stopped: null,
  };
  const now = deps.now();
  const rows = await deps.db
    .select({
      row: wealthWatch,
      address: sodexAccounts.address,
      accountUserId: sodexAccounts.userId,
      accountStatus: sodexAccounts.status,
    })
    .from(wealthWatch)
    .innerJoin(users, eq(users.id, wealthWatch.userId))
    .leftJoin(sodexAccounts, eq(sodexAccounts.id, wealthWatch.sodexAccountId))
    .where(
      and(
        lte(wealthWatch.nextCheckAt, now),
        // Công tắc hệ thống tắt: chỉ user role team (DEC-404 mục 1).
        deps.enabled ? undefined : eq(users.role, UserRole.team),
      ),
    )
    .orderBy(asc(wealthWatch.nextCheckAt))
    .limit(deps.batch);
  for (const due of rows) {
    let stop: "budget" | null;
    try {
      stop = await processRow(deps, due, result, fundNames);
    } catch (err) {
      // Lỗi DB / bất ngờ: lùi user này. Log chỉ tên / mã lỗi + userId, không message (có thể chứa địa chỉ trong URL).
      result.errors += 1;
      deps.log?.warn(
        {
          userId: due.row.userId,
          errorName: err instanceof Error ? err.name : typeof err,
          errorCode:
            typeof err === "object" && err !== null && "code" in err ? String(err.code) : undefined,
        },
        "wealth watch: user check failed",
      );
      await backoffRow(deps.db, due.row, "internal", deps.now(), deps.intervalMs).catch(
        () => undefined,
      );
      continue;
    }
    if (stop !== null) {
      result.stopped = stop;
      break;
    }
  }
  return result;
}
