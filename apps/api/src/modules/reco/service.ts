import { accountAnalyses, aiSuggestions, goals, sodexAccounts, users, type Db } from "@drift/db";
import {
  accountMetricsSchema,
  AppError,
  assetOf,
  dec,
  ErrorCode,
  type AiParamsBody,
  type GoalsBody,
  type GoalsView,
  type PlanView,
  type Suggestion,
  type SuggestionView,
} from "@drift/shared";
import type { SodexRestClient } from "@drift/sodex";
import { and, desc, eq } from "drizzle-orm";
import { getAddress } from "viem";

import type { RecoClient, RecoCommon } from "../../lib/reco-client";
import { iso } from "../security/service";

// Mục tiêu (onboarding bước 5), kế hoạch (bước 6) và AI parameters. Engine nằm ở service `reco`; api
// gom đầu vào của user và lưu kết quả vào `ai_suggestions` (RECO_ENGINE.md mục 10.6).

export interface RecoDeps {
  db: Db;
  reco: RecoClient;
  rest: Pick<
    SodexRestClient,
    "getSpotSymbols" | "getPerpsSymbols" | "getSpotBalances" | "getPerpsAccountValue"
  >;
  now: () => Date;
}

/** Trần đòn bẩy của account: Risk Center (P10) chưa có thì null (engine dùng trần mặc định). */
const ACCOUNT_LEVERAGE_CAP: number | null = null;

async function connected(db: Db, userId: string) {
  const [a] = await db
    .select()
    .from(sodexAccounts)
    .where(and(eq(sodexAccounts.userId, userId), eq(sodexAccounts.status, "connected")))
    .orderBy(desc(sodexAccounts.createdAt))
    .limit(1);
  return a ?? null;
}

async function common(deps: RecoDeps, userId: string): Promise<RecoCommon> {
  const a = await connected(deps.db, userId);
  let account = null;
  if (a !== null) {
    const [row] = await deps.db
      .select({ metrics: accountAnalyses.metrics })
      .from(accountAnalyses)
      .where(eq(accountAnalyses.sodexAccountId, a.id))
      .orderBy(desc(accountAnalyses.computedAt))
      .limit(1);
    const parsed = row === undefined ? null : accountMetricsSchema.safeParse(row.metrics);
    account = parsed?.success === true ? parsed.data : null;
  }
  const [u] = await deps.db
    .select({ tz: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return {
    account,
    accountLeverageCap: ACCOUNT_LEVERAGE_CAP,
    timeZone: u?.tz ?? "UTC",
    now: deps.now().getTime(),
  };
}

export async function saveGoals(
  deps: RecoDeps,
  userId: string,
  body: GoalsBody,
): Promise<GoalsView> {
  if (!dec(body.capital).gt(0))
    throw new AppError(ErrorCode.validationFailed, "Capital must be above 0.", {
      fieldErrors: { capital: ["Must be above 0."] },
    });
  const values = {
    goal: body.goal,
    capital: body.capital,
    maxDrop: body.maxDrop,
    markets: [...new Set(body.assets)],
  };
  const [row] = await deps.db
    .insert(goals)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: goals.userId, set: { ...values, updatedAt: new Date() } })
    .returning();
  if (row === undefined) throw new AppError(ErrorCode.internal, "Could not save goals.");
  return view(row);
}

function view(row: typeof goals.$inferSelect): GoalsView {
  return {
    goal: row.goal,
    capital: dec(row.capital).toString(),
    maxDrop: row.maxDrop,
    assets: row.markets,
    updatedAt: iso(row.updatedAt),
  };
}

export async function getGoals(deps: RecoDeps, userId: string): Promise<GoalsView | null> {
  const [row] = await deps.db.select().from(goals).where(eq(goals.userId, userId)).limit(1);
  return row === undefined ? null : view(row);
}

async function store(
  deps: RecoDeps,
  userId: string,
  s: Suggestion,
  context: "onboarding" | "create" | "retune",
  role: "best" | "add_on" | "single",
): Promise<SuggestionView> {
  const [row] = await deps.db
    .insert(aiSuggestions)
    .values({
      userId,
      context,
      engineId: s.id,
      role,
      strategy: s.strategy,
      market: s.market,
      capital: s.capital,
      values: s.values,
      reasons: s.reasons,
      basis: s.basis,
      inputsVersion: s.inputsVersion,
      computedAt: new Date(s.computedAt),
    })
    .returning({ id: aiSuggestions.id });
  if (row === undefined) throw new AppError(ErrorCode.internal, "Could not store suggestion.");
  return {
    id: row.id,
    strategy: s.strategy,
    market: s.market,
    capital: s.capital,
    values: s.values,
    reasons: s.reasons,
    basis: s.basis,
    computedAt: s.computedAt,
  };
}

export async function plan(deps: RecoDeps, userId: string): Promise<PlanView> {
  const g = await getGoals(deps, userId);
  if (g === null) throw new AppError(ErrorCode.notFound, "Set your goals first.");
  const result = await deps.reco.plan({ ...(await common(deps, userId)), goals: g });
  return {
    best:
      result.best === null ? null : await store(deps, userId, result.best, "onboarding", "best"),
    addOns: await Promise.all(
      result.addOns.map((s) => store(deps, userId, s, "onboarding", "add_on")),
    ),
    notSuggested: result.notSuggested,
    notes: result.notes,
    capital: result.capital,
    empty: result.empty,
  };
}

/** AI parameters cho màn tạo / sửa bot. null khi engine không tính được (UI mở form trống). */
export async function aiParams(
  deps: RecoDeps,
  userId: string,
  body: AiParamsBody,
): Promise<SuggestionView | null> {
  const g = await getGoals(deps, userId);
  const capital = body.capital ?? g?.capital;
  if (capital === undefined) return null;
  const s = await deps.reco.params({
    ...(await common(deps, userId)),
    strategy: body.strategy,
    market: body.market,
    capital,
    maxDrop: g?.maxDrop ?? "10",
  });
  return s === null ? null : store(deps, userId, s, body.context, "single");
}

/** Bước 5: tài sản có thể chọn (từ market SoDEX), kèm ghi chú lịch sử và số dư khả dụng. */
export async function assetOptions(deps: RecoDeps, userId: string) {
  const [spot, perps] = await Promise.all([
    deps.rest.getSpotSymbols(),
    deps.rest.getPerpsSymbols(),
  ]);
  const assets = [
    ...new Set(
      [...spot, ...perps].filter((m) => m.status === "TRADING").map((m) => assetOf(m.name)),
    ),
  ].sort();
  const c = await common(deps, userId);
  const byAsset = new Map<string, string>();
  for (const m of c.account?.byMarket ?? []) {
    const a = assetOf(m.market);
    byAsset.set(
      a,
      dec(byAsset.get(a) ?? "0")
        .add(m.netPnl)
        .toString(),
    );
  }
  let available: string | null = null;
  const acct = await connected(deps.db, userId);
  if (acct !== null) {
    try {
      const address = getAddress(acct.address);
      const [bal, av] = await Promise.all([
        deps.rest.getSpotBalances(address, acct.sodexAccountId),
        deps.rest.getPerpsAccountValue(address),
      ]);
      const usdc = bal.find((b) => b.coin === "vUSDC");
      available = dec(usdc === undefined ? "0" : dec(usdc.total).sub(usdc.locked))
        .add(av)
        .toString();
    } catch {
      available = null;
    }
  }
  const dd = c.account?.maxDrawdownPct ?? null;
  return {
    items: assets.map((asset) => ({
      asset,
      netPnl: byAsset.get(asset) ?? null,
      hasHistory: byAsset.has(asset),
    })),
    available,
    worstDrawdownPct: dd === null ? null : dec(dd).mul(100).toDecimalPlaces(1).toString(),
  };
}

export async function getSuggestion(
  deps: RecoDeps,
  userId: string,
  id: string,
): Promise<SuggestionView> {
  const [row] = await deps.db
    .select()
    .from(aiSuggestions)
    .where(and(eq(aiSuggestions.id, id), eq(aiSuggestions.userId, userId)))
    .limit(1);
  if (row === undefined) throw new AppError(ErrorCode.notFound, "Suggestion not found.");
  return {
    id: row.id,
    strategy: row.strategy as SuggestionView["strategy"],
    market: row.market,
    capital: dec(row.capital).toString(),
    values: row.values as Record<string, unknown>,
    reasons: row.reasons as string[],
    basis: row.basis,
    computedAt: iso(row.computedAt),
  };
}
