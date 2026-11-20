import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";

import type { Db } from "./client";
import {
  leaderboardRuns,
  leaderStatsDaily,
  researchWalletSetMembers,
  researchWalletSets,
} from "./schema";

// Tập ví nghiên cứu cho H1 của Signal research (#353, context-v2): top-K ví tab "Top" của lần xếp hạng `ok` gần nhất, chụp
// theo phiên bản. scheduler tạo version (sau mỗi lượt leaderboard, kiểm lại mỗi vòng tick), marketdata poll ví của version
// mới nhất, bước 4 · Context đọc version có hiệu lực trước thời điểm quyết định. Không hiện cho người dùng.

/** Trần K: bằng trần poll T1 của marketdata (`HL_TRACKER.maxPolled`), vì ví nghiên cứu dùng chung trần đó. */
export const RESEARCH_WALLETS_MAX_K = 40;

const LOCK = sql`select pg_advisory_xact_lock(hashtext('research_wallet_sets'))`;

export interface ResearchWalletSetRef {
  version: number;
  runDate: string;
  k: number;
  size: number;
  created: boolean;
}

/**
 * Đảm bảo có version cho lần xếp hạng `ok` gần nhất với K hiện tại. Version mới nhất đã cùng ngày xếp hạng và cùng K → giữ
 * nguyên (`created: false`); khác → tạo version mới (= cũ + 1) với top-K ví tab "Top" của ngày đó, xếp theo lợi nhuận 30 ngày
 * giảm dần (như tab Top của Leaders), hoà thì theo địa chỉ. K = 0 tạo version rỗng (tắt poll ví nghiên cứu). Chưa có lần
 * xếp hạng `ok` nào → null. Khoá advisory trong transaction: hai tiến trình không tạo trùng version.
 */
export async function ensureResearchWalletSet(
  db: Db,
  k: number,
  now: number,
): Promise<ResearchWalletSetRef | null> {
  const kk = Math.max(0, Math.min(RESEARCH_WALLETS_MAX_K, Math.floor(k)));
  return db.transaction(async (tx) => {
    await tx.execute(LOCK);
    const [run] = await tx
      .select({ date: leaderboardRuns.date })
      .from(leaderboardRuns)
      .where(and(eq(leaderboardRuns.status, "ok"), isNotNull(leaderboardRuns.finishedAt)))
      .orderBy(desc(leaderboardRuns.finishedAt))
      .limit(1);
    if (run === undefined) return null;
    const [last] = await tx
      .select()
      .from(researchWalletSets)
      .orderBy(desc(researchWalletSets.version))
      .limit(1);
    if (last?.runDate === run.date && last.k === kk)
      return {
        version: last.version,
        runDate: last.runDate,
        k: last.k,
        size: last.size,
        created: false,
      };
    const top =
      kk === 0
        ? []
        : await tx
            .select({ address: leaderStatsDaily.address })
            .from(leaderStatsDaily)
            .where(
              and(
                eq(leaderStatsDaily.source, "hyperliquid"),
                eq(leaderStatsDaily.date, run.date),
                sql`'top' = any(${leaderStatsDaily.tabs})`,
              ),
            )
            .orderBy(desc(leaderStatsDaily.profit), asc(leaderStatsDaily.address))
            .limit(kk);
    const version = (last?.version ?? 0) + 1;
    await tx.insert(researchWalletSets).values({
      version,
      runDate: run.date,
      k: kk,
      size: top.length,
      createdAt: new Date(now),
    });
    if (top.length > 0)
      await tx.insert(researchWalletSetMembers).values(
        top.map((w, i) => ({
          setVersion: version,
          address: w.address.toLowerCase(),
          rank: i + 1,
        })),
      );
    return { version, runDate: run.date, k: kk, size: top.length, created: true };
  });
}

/** Ví của version mới nhất (chữ thường), theo hạng; chưa có version → rỗng. marketdata poll các ví này. */
export async function latestResearchWallets(db: Db): Promise<string[]> {
  const [last] = await db
    .select({ version: researchWalletSets.version })
    .from(researchWalletSets)
    .orderBy(desc(researchWalletSets.version))
    .limit(1);
  if (last === undefined) return [];
  const rows = await db
    .select({ address: researchWalletSetMembers.address })
    .from(researchWalletSetMembers)
    .where(eq(researchWalletSetMembers.setVersion, last.version))
    .orderBy(asc(researchWalletSetMembers.rank));
  return rows.map((r) => r.address.toLowerCase());
}

/** Version mới nhất (kèm số ví) cho câu "top {K} of the leaderboard"; chưa có → null. */
export async function latestResearchWalletSet(
  db: Pick<Db, "select">,
): Promise<{ version: number; size: number } | null> {
  const [last] = await db
    .select({ version: researchWalletSets.version, size: researchWalletSets.size })
    .from(researchWalletSets)
    .orderBy(desc(researchWalletSets.version))
    .limit(1);
  return last ?? null;
}
