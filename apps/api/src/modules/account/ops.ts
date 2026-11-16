import { botRuntime, bots, botVersions, outbox, type Db } from "@drift/db";
import {
  costPerMillionOfSums,
  dec,
  Decimal,
  opsCostMedian,
  opsHealth,
  OPS_RULES,
  sortOpsRows,
  Strategy,
  teamOpsQuerySchema,
  TEAM_OPS_STRATEGIES,
  type CostSums,
  type TeamOpsBot,
  type TeamOpsView,
} from "@drift/shared";
import { and, asc, desc, eq, gte, inArray, ne, or, sql, type SQL } from "drizzle-orm";

import { parseOrThrow } from "../../lib/http";
import { botCostPerMillion } from "../bots/service";

import { requireTeam } from "./team";

// Trang Bot Monitor của team (tên cũ "Ops"; docs/mockups/ops, DEC-288, thay bố cục DEC-276). Chỉ role
// team, chỉ đọc. Mọi truy vấn chặn theo thời gian và đi qua index: orders_bot_idx (bot_id, created_at),
// fills_order_idx, bot_events_bot_idx, outbox_topic_created_idx và outbox_bot_state_idx (#163). Gom theo bot trong SQL
// (không N+1). Số không tính được → null ("Not available"), không bao giờ 0.
//   Active (mặc định): running / paused / stopping, cộng stopped / archived có mốc dừng (outbox `user.<account>.bot`)
//   trong 7 ngày. All bots: mọi bot thật trừ draft, phân trang 50 trong SQL theo từng chiến lược, tìm theo tên / market /
//   user id. Không bao giờ có bot paper.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Dòng "Order requests" cũ hơn mức này thì không dùng cho Requests / min. */
const REQUESTS_FRESH_MS = 5 * MIN;
/**
 * Fill trong 24 giờ đi qua `orders_bot_idx`: lệnh tạo trước mức này coi như không còn khớp trong kỳ. Biên rộng (lệnh
 * Market Making nằm trên sổ vài phút; lệnh Volume Builder giữ tối đa 1 giờ).
 */
const ORDER_AGE_BOUND_MS = 2 * DAY;
/** Outbox / bot dừng / Decisions của phần chi tiết: chỉ đọc chừng này về trước. */
const LOOKBACK_MS = OPS_RULES.activeStopDays * DAY;
/** Chặn số dòng cảnh báo đọc một lượt (cảnh báo đang sai gửi lại mỗi 30 phút). */
const ALERT_ROWS_LIMIT = 5000;

const ACTIVE_STATES = ["running", "paused", "stopping"] as const;
const RESTING_STATES = ["stopped", "archived"] as const;

// Biểu thức chính quy truyền dạng tham số (không viết trong template SQL để khỏi lệ thuộc cách escape).
const NET_RE = "net (-?[0-9.]+) USDC";
const PRICE_RE = "price PnL (-?[0-9.]+)";
const ENTRY_RE = "entry ([0-9.]+) →";
const EXIT_RE = "→ exit ([0-9.]+)";
const GAP_RE = "Longest gap between quotes: ([0-9]+(?:\\.[0-9]+)?) s\\.";
const UNTRACKED_RE = "^Cancelled ([0-9]+) untracked order";

/** "Last 61 s: 40 requests to SoDEX (…). Longest gap between quotes: 3.0 s." → số đọc được. */
export function parseOrderRequests(why: string | null): {
  perMinute: string | null;
  gapSec: string | null;
} {
  if (why === null) return { perMinute: null, gapSec: null };
  const m = /^Last (\d+) s: (\d+) requests/.exec(why);
  const g = /Longest gap between quotes: (\d+(?:\.\d+)?) s\./.exec(why);
  const secs = m?.[1] === undefined ? 0 : Number(m[1]);
  return {
    perMinute:
      m?.[2] === undefined || secs <= 0
        ? null
        : dec(m[2]).mul(60).div(secs).toDecimalPlaces(1).toString(),
    gapSec: g?.[1] ?? null,
  };
}

/** "Cancelled 3 untracked orders" → 3. */
export function untrackedCount(decision: string | null): number {
  const m = /^Cancelled (\d+) untracked order/.exec(decision ?? "");
  return m?.[1] === undefined ? 0 : Number(m[1]);
}

/** Một dòng cảnh báo bất biến của outbox `jobs.team_ops` (DEC-274). */
interface AlertRow {
  botId: string;
  invariant: string;
  status: "failing" | "resolved";
  detail: string;
  at: Date;
}

export interface AlertState {
  active: { invariant: string; since: string; detail: string; latest: number }[];
  /** Hết sai trong 24 giờ (mới nhất). */
  resolvedDay: { invariant: string; failedAt: string | null; resolvedAt: string } | null;
  /** Hết sai trong 7 ngày (mới nhất), cho cột Latest alert khi không có cái nào đang sai. */
  resolvedWeek: { invariant: string; resolvedAt: string; detail: string } | null;
  /** Dòng cho phần chi tiết: lúc bắt đầu mỗi đợt sai và lúc hết sai (không lặp lại các lần gửi lại 30 phút). */
  log: TeamOpsBot["log"];
}

/**
 * Trạng thái cảnh báo của một bot từ các dòng outbox (mới nhất trước). Đang sai = dòng mới nhất của (bot, bất biến) là
 * failing; mốc bắt đầu = dòng failing cũ nhất của đợt đó (sau dòng resolved gần nhất).
 */
export function alertStateOf(rows: readonly AlertRow[], now: number): AlertState {
  const byInv = new Map<string, AlertRow[]>();
  for (const r of rows) {
    const xs = byInv.get(r.invariant);
    if (xs === undefined) byInv.set(r.invariant, [r]);
    else xs.push(r);
  }
  const out: AlertState = { active: [], resolvedDay: null, resolvedWeek: null, log: [] };
  for (const [invariant, xs] of byInv) {
    // Gom thành các đợt liên tiếp cùng trạng thái (xs mới nhất trước).
    const runs: { status: AlertRow["status"]; rows: AlertRow[] }[] = [];
    for (const r of xs) {
      const last = runs[runs.length - 1];
      if (last?.status === r.status) last.rows.push(r);
      else runs.push({ status: r.status, rows: [r] });
    }
    for (const run of runs) {
      const oldest = run.rows[run.rows.length - 1];
      const newest = run.rows[0];
      if (oldest === undefined || newest === undefined) continue;
      if (run.status === "failing")
        out.log.push({
          at: oldest.at.toISOString(),
          name: invariant,
          why: newest.detail === "" ? null : newest.detail,
          alert: "failing",
        });
      else
        for (const r of run.rows)
          out.log.push({
            at: r.at.toISOString(),
            name: invariant,
            why: r.detail === "" ? null : r.detail,
            alert: "resolved",
          });
    }
    const [first, second] = runs;
    const head = first?.rows[0];
    if (first === undefined || head === undefined) continue;
    if (first.status === "failing") {
      const since = first.rows[first.rows.length - 1] ?? head;
      out.active.push({
        invariant,
        since: since.at.toISOString(),
        detail: head.detail,
        latest: head.at.getTime(),
      });
      continue;
    }
    const failedAt = second?.rows[second.rows.length - 1]?.at.toISOString() ?? null;
    const resolvedAt = head.at.toISOString();
    if (out.resolvedWeek === null || resolvedAt > out.resolvedWeek.resolvedAt)
      out.resolvedWeek = {
        invariant,
        resolvedAt,
        detail: second?.rows[0]?.detail ?? head.detail,
      };
    if (
      now - head.at.getTime() <= DAY &&
      (out.resolvedDay === null || resolvedAt > out.resolvedDay.resolvedAt)
    )
      out.resolvedDay = { invariant, failedAt, resolvedAt };
  }
  out.active.sort((a, b) => b.latest - a.latest);
  return out;
}

const rowsOf = <T>(r: { rows: unknown[] }): T[] => r.rows as T[];
const idList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
const iso = (v: Date | string | null): string | null =>
  v === null ? null : new Date(v).toISOString();
const str = (v: Decimal | null, dp = 2): string | null =>
  v === null ? null : v.toDecimalPlaces(dp).toString();
/** Tổng 0 nghĩa là không có fill trong kỳ: hiện "Not available", không phải 0. */
const nonZero = (v: Decimal | null): string | null =>
  v === null || v.isZero() ? null : v.toDecimalPlaces(2).toString();
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

interface FillAgg {
  bot_id: string;
  vol_day: string;
  vol_hour: string;
  known: string;
  maker: string;
  priced: string;
  priced_fees: string;
  pnl: string;
}

interface EventAgg {
  bot_id: string;
  cuts_day: number;
  cuts_hour: number;
  untracked: number;
  untracked_at: Date | string | null;
  max_gap: string | null;
  req_why: string | null;
  req_at: Date | string | null;
  rounds: number;
  wins: number;
  avg_net: string | null;
  post_only: number;
  market_entries: number;
  take_profit: number;
  early_profit: number;
  hold_ended: number;
  max_hold: number;
  bot_stop: number;
  sodex_stop: number;
  counter_trend: number;
  spread: number;
  sideways: number;
  stale: number;
  stale_at: Date | string | null;
  below_min: number;
  blocked: number;
  rejected_at: Date | string | null;
}

interface Deps {
  db: Db;
  now: () => Date;
  log?: { info: (o: object, m: string) => void };
}

export async function teamOps(deps: Deps, userId: string, query: unknown): Promise<TeamOpsView> {
  // Kiểm quyền trước, parse sau: người không thuộc team nhận 403, không phải 400.
  await requireTeam(deps.db, userId, "Bot Monitor is for the DeskLabs team only.");
  const q = parseOrThrow(teamOpsQuerySchema, query);
  const started = Date.now();
  const now = deps.now().getTime();
  const db = deps.db;
  const strategies = [Strategy.volumeMaker, Strategy.volumeFarm];

  // 1 · Nhóm Active. Lọc trước bằng updated_at (mốc dừng luôn ≤ updated_at), rồi lấy mốc dừng thật từ outbox.
  const candidates = await db
    .select({ b: bots, state: botRuntime.state })
    .from(bots)
    .leftJoin(botRuntime, eq(botRuntime.botId, bots.id))
    .where(
      and(
        eq(bots.mode, "live"),
        inArray(bots.strategy, strategies),
        or(
          inArray(bots.state, [...ACTIVE_STATES]),
          and(
            inArray(bots.state, [...RESTING_STATES]),
            gte(bots.updatedAt, new Date(now - LOOKBACK_MS)),
          ),
        ),
      ),
    );
  const stopIds = candidates.filter((r) => r.b.state !== "running" && r.b.state !== "paused");
  const stops = await stopTimes(
    db,
    stopIds.map((r) => r.b.id),
    now,
  );
  const active = candidates.filter(
    (r) =>
      (ACTIVE_STATES as readonly string[]).includes(r.b.state) ||
      (stops.get(r.b.id) ?? 0) >= now - LOOKBACK_MS,
  );
  const activeIds = new Set(active.map((r) => r.b.id));

  // 2 · All bots: một trang của chiến lược đang xem, phân trang trong SQL.
  let page: typeof candidates = [];
  let counts = { volume_maker: 0, volume_farm: 0 };
  if (q.show === "all") {
    const term = q.q === undefined || q.q === "" ? null : `%${escapeLike(q.q)}%`;
    const search =
      term === null
        ? undefined
        : or(
            sql`${bots.name} ilike ${term}`,
            sql`${bots.market} ilike ${term}`,
            sql`${bots.userId}::text ilike ${term}`,
          );
    const base = and(eq(bots.mode, "live"), ne(bots.state, "draft"), search);
    page = await db
      .select({ b: bots, state: botRuntime.state })
      .from(bots)
      .leftJoin(botRuntime, eq(botRuntime.botId, bots.id))
      .where(and(base, eq(bots.strategy, q.strategy)))
      .orderBy(
        sql`case ${bots.state} when 'stopped' then 1 when 'archived' then 2 else 0 end`,
        desc(bots.createdAt),
        asc(bots.id),
      )
      .limit(OPS_RULES.pageSize)
      .offset((q.page - 1) * OPS_RULES.pageSize);
    const totals = await db
      .select({ strategy: bots.strategy, n: sql<number>`count(*)::int` })
      .from(bots)
      .where(and(base, inArray(bots.strategy, strategies)))
      .groupBy(bots.strategy);
    for (const t of totals)
      if (t.strategy === "volume_maker" || t.strategy === "volume_farm") counts[t.strategy] = t.n;
  }

  const all = new Map([...active, ...page].map((r) => [r.b.id, r]));
  const ids = [...all.keys()];
  const versionIds = [...all.values()]
    .map((r) => r.b.activeVersionId)
    .filter((v): v is string => v !== null);

  const [configs, fillAgg, eventAgg, rejects, alertRows, logRows] =
    ids.length === 0
      ? [[], [], [], [], [], []]
      : await Promise.all([
          versionIds.length === 0
            ? Promise.resolve([])
            : db
                .select({ id: botVersions.id, config: botVersions.config })
                .from(botVersions)
                .where(inArray(botVersions.id, versionIds)),
          fillsOf(db, ids, now),
          eventsOf(db, ids, now),
          rejectsOf(db, ids, now),
          alertsOf(db, ids, now),
          logsOf(db, ids, now),
        ]);

  const configOf = new Map(configs.map((c) => [c.id, c.config as Record<string, unknown>]));
  const fillOf = new Map(fillAgg.map((f) => [f.bot_id, f]));
  const eventOf = new Map(eventAgg.map((e) => [e.bot_id, e]));
  const rejectOf = new Map(rejects.map((r) => [r.bot_id, r]));
  const alertsByBot = new Map<string, AlertRow[]>();
  for (const a of alertRows) {
    const xs = alertsByBot.get(a.botId);
    if (xs === undefined) alertsByBot.set(a.botId, [a]);
    else xs.push(a);
  }
  const logOf = new Map<string, TeamOpsBot["log"]>();
  for (const l of logRows) {
    const xs = logOf.get(l.bot_id) ?? [];
    xs.push({
      at: new Date(l.occurred_at).toISOString(),
      name: l.decision,
      why: l.why,
      alert: null,
    });
    logOf.set(l.bot_id, xs);
  }

  // Số chưa gắn nhãn của từng bot (nhãn cần trung vị Cost / $1M của cả nhóm Active).
  const base = ids.map((id) => {
    const r = all.get(id);
    if (r === undefined) throw new Error("unreachable");
    const b = r.b;
    const f = fillOf.get(id);
    const e = eventOf.get(id);
    const cfg = b.activeVersionId === null ? undefined : configOf.get(b.activeVersionId);
    const sums: CostSums | null =
      f === undefined
        ? null
        : {
            volume: dec(f.vol_day),
            priced: dec(f.priced),
            pricedFees: dec(f.priced_fees),
            pnl: dec(f.pnl),
          };
    const resting = b.state === "stopped" || b.state === "archived";
    const lifetime = q.show === "all" && resting;
    const known = f === undefined ? null : dec(f.known);
    const alerts = alertStateOf(alertsByBot.get(id) ?? [], now);
    const latestActive = alerts.active[0];
    const mm = b.strategy === Strategy.volumeMaker;
    const reqFresh =
      e?.req_at !== undefined &&
      e.req_at !== null &&
      now - Date.parse(String(iso(e.req_at))) <= REQUESTS_FRESH_MS;
    const reject = rejectOf.get(id);
    const row = {
      botId: b.id,
      userId: b.userId,
      name: b.name,
      strategy: b.strategy as TeamOpsBot["strategy"],
      market: b.market,
      state: b.state,
      reasonCode: b.reasonCode,
      createdAt: b.createdAt.toISOString(),
      stopAt: iso(stops.has(id) ? new Date(stops.get(id) ?? 0) : null),
      costPerMillion: lifetime
        ? botCostPerMillion(b.strategy, r.state)
        : str(sums === null ? null : costPerMillionOfSums(sums)),
      costScope: lifetime ? ("lifetime" as const) : ("day" as const),
      volumeHour: f === undefined ? null : nonZero(dec(f.vol_hour)),
      volumeDay: f === undefined ? null : nonZero(dec(f.vol_day)),
      makerSharePct:
        f === undefined || known === null || known.isZero()
          ? null
          : str(dec(f.maker).div(known).mul(100), 1),
      smartQuoting: mm && cfg !== undefined ? cfg.smartQuoting === true : null,
      requestsPerMinute: reqFresh ? parseOrderRequests(e.req_why).perMinute : null,
      maxQuoteGapSec:
        e?.max_gap === undefined || e.max_gap === null ? null : dec(e.max_gap).toString(),
      positionCutsDay: e?.cuts_day ?? 0,
      positionCutsHour: e?.cuts_hour ?? 0,
      untrackedCancels: e?.untracked ?? 0,
      positionPct: mm ? positionPctOf(r.state) : null,
      alert:
        latestActive !== undefined
          ? {
              invariant: latestActive.invariant,
              status: "active" as const,
              at: latestActive.since,
              detail: latestActive.detail,
            }
          : alerts.resolvedWeek === null
            ? null
            : {
                invariant: alerts.resolvedWeek.invariant,
                status: "resolved" as const,
                at: alerts.resolvedWeek.resolvedAt,
                detail: alerts.resolvedWeek.detail,
              },
      vb: mm
        ? null
        : {
            rounds: e?.rounds ?? 0,
            roundsWon: e?.wins ?? 0,
            avgNet: e?.avg_net === undefined || e.avg_net === null ? null : str(dec(e.avg_net), 2),
            entriesPostOnly: e?.post_only ?? 0,
            entriesMarket: e?.market_entries ?? 0,
            takerAfter:
              cfg?.allowTaker !== true
                ? null
                : typeof cfg.takerAfter === "number"
                  ? cfg.takerAfter
                  : null,
            exits: {
              takeProfit: e?.take_profit ?? 0,
              earlyProfit: e?.early_profit ?? 0,
              holdEnded: e?.hold_ended ?? 0,
              maxHold: e?.max_hold ?? 0,
              botStop: e?.bot_stop ?? 0,
              sodexStop: e?.sodex_stop ?? 0,
            },
            waits: {
              counterTrend: e?.counter_trend ?? 0,
              spread: e?.spread ?? 0,
              sideways: e?.sideways ?? 0,
              stale: e?.stale ?? 0,
              belowMinimum: e?.below_min ?? 0,
              blockedHour: e?.blocked ?? 0,
            },
            marketRejects: reject?.n ?? 0,
          },
      log: [...(logOf.get(id) ?? []), ...alerts.log]
        .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0))
        .slice(0, 5),
    };
    return { row, sums, known, maker: f === undefined ? null : dec(f.maker), alerts, e, reject };
  });

  // Trung vị Cost / $1M (24h) theo chiến lược, trên các bot Active có số.
  const median = Object.fromEntries(
    TEAM_OPS_STRATEGIES.map((s) => [
      s,
      opsCostMedian(
        base
          .filter(
            (x) => activeIds.has(x.row.botId) && x.row.strategy === s && x.row.costScope === "day",
          )
          .map((x) => x.row.costPerMillion),
      ),
    ]),
  ) as Record<(typeof TEAM_OPS_STRATEGIES)[number], string | null>;

  const labelled = new Map<string, TeamOpsBot>();
  for (const x of base) {
    const { row, alerts, e, reject } = x;
    const { health, reasons } = opsHealth({
      strategy: row.strategy,
      state: row.state,
      reasonCode: row.reasonCode,
      activeAlerts: alerts.active,
      resolvedAlert: alerts.resolvedDay,
      requestsPerMinute: row.requestsPerMinute,
      maxQuoteGapSec: row.maxQuoteGapSec,
      positionCutsHour: row.positionCutsHour,
      untracked: { count: row.untrackedCancels, at: iso(e?.untracked_at ?? null) },
      marketRejects: { count: reject?.n ?? 0, at: iso(reject?.at ?? null) },
      rejectedPauseAt: iso(e?.rejected_at ?? null),
      costPerMillion: row.costScope === "day" ? row.costPerMillion : null,
      costMedian: median[row.strategy],
      staleCandlesAt: iso(e?.stale_at ?? null),
    });
    labelled.set(row.botId, { ...row, health, reasons });
  }

  const activeRows = sortOpsRows(
    [...activeIds].map((id) => labelled.get(id)).filter((r): r is TeamOpsBot => r !== undefined),
  );
  const summaryOf = (pick: (r: { strategy: string }) => boolean) => {
    const xs = base.filter((x) => activeIds.has(x.row.botId) && pick(x.row));
    const rows = xs.map((x) => x.row);
    const sum = (vals: (Decimal | null)[]) =>
      vals.reduce<Decimal>((a, v) => (v === null ? a : a.add(v)), new Decimal(0));
    const sums: CostSums = {
      volume: sum(xs.map((x) => x.sums?.volume ?? null)),
      priced: sum(xs.map((x) => x.sums?.priced ?? null)),
      pricedFees: sum(xs.map((x) => x.sums?.pricedFees ?? null)),
      pnl: sum(xs.map((x) => x.sums?.pnl ?? null)),
    };
    const known = sum(xs.map((x) => x.known));
    const rounds = rows.reduce((n, r) => n + (r.vb?.rounds ?? 0), 0);
    const won = rows.reduce((n, r) => n + (r.vb?.roundsWon ?? 0), 0);
    return {
      running: rows.filter((r) => r.state === "running").length,
      paused: rows.filter((r) => r.state === "paused").length,
      stopping: rows.filter((r) => r.state === "stopping").length,
      stoppedDay: rows.filter(
        (r) =>
          (r.state === "stopped" || r.state === "archived") &&
          r.stopAt !== null &&
          now - Date.parse(r.stopAt) <= DAY,
      ).length,
      volumeHour: nonZero(sum(rows.map((r) => (r.volumeHour === null ? null : dec(r.volumeHour))))),
      volumeDay: nonZero(sums.volume),
      costPerMillion: str(costPerMillionOfSums(sums)),
      makerSharePct: known.isZero()
        ? null
        : str(
            sum(xs.map((x) => x.maker))
              .div(known)
              .mul(100),
            1,
          ),
      rounds,
      roundsWonPct: rounds === 0 ? null : str(new Decimal(won).div(rounds).mul(100), 0),
    };
  };
  const alertList = activeRows.flatMap((r) =>
    r.alert?.status === "active"
      ? [{ botId: r.botId, name: r.name, invariant: r.alert.invariant }]
      : [],
  );

  let rows: TeamOpsBot[];
  if (q.show === "all") {
    rows = sortOpsRows(
      page.map((r) => labelled.get(r.b.id)).filter((r): r is TeamOpsBot => r !== undefined),
    );
  } else {
    rows = activeRows;
    counts = {
      volume_maker: rows.filter((r) => r.strategy === "volume_maker").length,
      volume_farm: rows.filter((r) => r.strategy === "volume_farm").length,
    };
  }

  const view: TeamOpsView = {
    checkedAt: new Date(now).toISOString(),
    show: q.show,
    summary: {
      total: summaryOf(() => true),
      volume_maker: summaryOf((r) => r.strategy === "volume_maker"),
      volume_farm: summaryOf((r) => r.strategy === "volume_farm"),
      alerts: alertList,
      alertBots: alertList.length,
      problem: activeRows.filter((r) => r.health === "problem").length,
      check: activeRows.filter((r) => r.health === "check").length,
    },
    attention: activeRows.filter((r) => r.health === "problem" || r.health === "check"),
    bots: rows,
    counts,
    page:
      q.show === "all"
        ? {
            strategy: q.strategy,
            page: q.page,
            pageSize: OPS_RULES.pageSize,
            total: counts[q.strategy],
          }
        : null,
  };
  deps.log?.info(
    { show: q.show, bots: rows.length, computed: ids.length, ms: Date.now() - started },
    "bot monitor computed",
  );
  return view;
}

/** |vị thế| × mid ÷ max inventory × 100 từ state runtime Market Making; thiếu số → null. */
function positionPctOf(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const st = state as { ledger?: { position?: unknown }; mid?: unknown; maxInventory?: unknown };
  const num = (v: unknown) =>
    typeof v === "string" && v !== "" ? dec(v) : typeof v === "number" ? dec(String(v)) : null;
  const pos = num(st.ledger?.position);
  const mid = num(st.mid);
  const max = num(st.maxInventory);
  if (pos === null || mid === null || !max?.gt(0)) return null;
  return str(pos.abs().mul(mid).div(max).mul(100), 1);
}

/** Mốc stopping / stopped gần nhất của mỗi bot trong 7 ngày (outbox `user.<account>.bot`, outbox_bot_state_idx). */
async function stopTimes(
  db: Db,
  ids: readonly string[],
  now: number,
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([sql`${outbox.payload}->>'botId'`], {
      botId: sql<string>`${outbox.payload}->>'botId'`,
      at: outbox.createdAt,
    })
    .from(outbox)
    .where(
      and(
        sql`${outbox.topic} like 'user.%.bot'`,
        sql`${outbox.payload}->>'state' in ('stopping', 'stopped')`,
        inArray(sql<string>`${outbox.payload}->>'botId'`, [...ids]),
        gte(outbox.createdAt, new Date(now - LOOKBACK_MS)),
      ),
    )
    .orderBy(sql`${outbox.payload}->>'botId'`, sql`${outbox.createdAt} desc`);
  return new Map(rows.map((r) => [r.botId, r.at.getTime()]));
}

/**
 * Fill 24 giờ của các bot, cộng trong SQL theo bot: volume 1 h / 24 h, maker / đã biết, và các tổng cho Cost / $1M
 * (công thức Market hours, DEC-283: giá tham chiếu = close nến 1 phút chứa fill + 60 s).
 */
async function fillsOf(db: Db, ids: readonly string[], now: number): Promise<FillAgg[]> {
  const r = await db.execute(sql`
    select o.bot_id,
           coalesce(sum(f.price * f.size), 0)::text as vol_day,
           coalesce(sum(f.price * f.size) filter (where f.filled_at >= ${new Date(now - HOUR)}), 0)::text as vol_hour,
           coalesce(sum(f.price * f.size) filter (where f.is_maker is not null), 0)::text as known,
           coalesce(sum(f.price * f.size) filter (where f.is_maker), 0)::text as maker,
           coalesce(sum(f.price * f.size) filter (where c.close is not null), 0)::text as priced,
           coalesce(sum(f.fee) filter (where c.close is not null), 0)::text as priced_fees,
           coalesce(sum(case when o.side = 'buy' then (c.close - f.price) * f.size
                             else (f.price - c.close) * f.size end)
                    filter (where c.close is not null), 0)::text as pnl
      from orders o
      join bots b on b.id = o.bot_id
      join fills f on f.order_id = o.id and f.filled_at >= ${new Date(now - DAY)}
      left join candles_1m c
        on c.market = b.market and c.ts = date_trunc('minute', f.filled_at + interval '60 seconds')
      where o.bot_id in (${idList(ids)}) and o.created_at >= ${new Date(now - ORDER_AGE_BOUND_MS)}
      group by o.bot_id`);
  return rowsOf<FillAgg>(r);
}

/** Decisions 24 giờ cộng theo bot (Market Making và Volume Builder); "Order requests" chỉ 1 giờ gần nhất. */
async function eventsOf(db: Db, ids: readonly string[], now: number): Promise<EventAgg[]> {
  const hour = new Date(now - HOUR);
  const closed = sql`decision like 'Closed %' and why ~ ${NET_RE}`;
  const skip = sql`decision = 'Skipped entry'`;
  const r = await db.execute(sql`
    select bot_id,
      count(*) filter (where decision = 'Position cut')::int as cuts_day,
      count(*) filter (where decision = 'Position cut' and occurred_at >= ${hour})::int as cuts_hour,
      coalesce(sum(substring(decision from ${UNTRACKED_RE})::int), 0)::int as untracked,
      max(occurred_at) filter (where decision ~ ${UNTRACKED_RE}) as untracked_at,
      max(substring(why from ${GAP_RE})::numeric) filter (where decision = 'Order requests')::text as max_gap,
      (array_agg(why order by occurred_at desc) filter (where decision = 'Order requests'))[1] as req_why,
      max(occurred_at) filter (where decision = 'Order requests') as req_at,
      count(*) filter (where ${closed})::int as rounds,
      count(*) filter (where ${closed} and coalesce(
        substring(why from ${PRICE_RE})::numeric,
        case decision
          when 'Closed long' then substring(why from ${EXIT_RE})::numeric - substring(why from ${ENTRY_RE})::numeric
          when 'Closed short' then substring(why from ${ENTRY_RE})::numeric - substring(why from ${EXIT_RE})::numeric
        end,
        substring(why from ${NET_RE})::numeric) > 0)::int as wins,
      avg(substring(why from ${NET_RE})::numeric) filter (where ${closed})::text as avg_net,
      count(*) filter (where decision in ('Enter long', 'Enter short') and why like '%Post-only at%')::int as post_only,
      count(*) filter (where decision in ('Enter long', 'Enter short') and why like '%Market order,%')::int as market_entries,
      count(*) filter (where ${closed} and why like 'Take profit%')::int as take_profit,
      count(*) filter (where ${closed} and why like 'Early profit%')::int as early_profit,
      count(*) filter (where ${closed} and why like 'Hold time%')::int as hold_ended,
      count(*) filter (where ${closed} and why like 'Max hold%')::int as max_hold,
      count(*) filter (where ${closed} and why like 'Stop loss %' and why not like 'Stop loss on SoDEX at%')::int as bot_stop,
      count(*) filter (where ${closed} and why like 'Stop loss on SoDEX at%')::int as sodex_stop,
      count(*) filter (where ${skip} and (why like 'The signal pointed % against %' or why like '"Reverse the signal" would trade%'))::int as counter_trend,
      count(*) filter (where ${skip} and why like 'The spread is %')::int as spread,
      count(*) filter (where ${skip} and why like '%only trades sideways markets%')::int as sideways,
      count(*) filter (where ${skip} and why like 'STALE_CANDLES:%')::int as stale,
      max(occurred_at) filter (where ${skip} and why like 'STALE_CANDLES:%' and occurred_at >= ${hour}) as stale_at,
      count(*) filter (where ${skip} and why like '%below the SoDEX minimum%')::int as below_min,
      count(*) filter (where decision = 'Waiting')::int as blocked,
      max(occurred_at) filter (where decision = 'Market entries rejected') as rejected_at
    from bot_events
    where bot_id in (${idList(ids)}) and occurred_at >= ${new Date(now - DAY)}
      and (decision in ('Position cut', 'Enter long', 'Enter short', 'Skipped entry', 'Waiting', 'Market entries rejected')
           or decision like 'Closed %'
           or decision ~ ${UNTRACKED_RE}
           or (decision = 'Order requests' and occurred_at >= ${hour}))
    group by bot_id`);
  return rowsOf<EventAgg>(r);
}

/** Lệnh vào thị trường của Volume Builder bị SoDEX từ chối trong 24 giờ (tag `vf:N:in:K`). */
async function rejectsOf(db: Db, ids: readonly string[], now: number) {
  const r = await db.execute(sql`
    select bot_id, count(*)::int as n, max(created_at) as at
      from orders
      where bot_id in (${idList(ids)}) and created_at >= ${new Date(now - DAY)}
        and type = 'market' and status = 'rejected' and tag like 'vf:%:in:%'
      group by bot_id`);
  return rowsOf<{ bot_id: string; n: number; at: Date | string }>(r);
}

/** Dòng cảnh báo bất biến 7 ngày của các bot (outbox `jobs.team_ops`, type team_invariant), mới nhất trước. */
async function alertsOf(db: Db, ids: readonly string[], now: number): Promise<AlertRow[]> {
  const rows = await db
    .select({ payload: outbox.payload, at: outbox.createdAt })
    .from(outbox)
    .where(
      and(
        eq(outbox.topic, "jobs.team_ops"),
        gte(outbox.createdAt, new Date(now - LOOKBACK_MS)),
        sql`${outbox.payload}->>'type' = 'team_invariant'`,
        inArray(sql<string>`${outbox.payload}->>'botId'`, [...ids]),
      ),
    )
    .orderBy(desc(outbox.createdAt))
    .limit(ALERT_ROWS_LIMIT);
  return rows.flatMap((r) => {
    const p = r.payload as {
      botId?: unknown;
      invariant?: unknown;
      status?: unknown;
      detail?: unknown;
    };
    if (typeof p.botId !== "string" || typeof p.invariant !== "string") return [];
    if (p.status !== "failing" && p.status !== "resolved") return [];
    return [
      {
        botId: p.botId,
        invariant: p.invariant,
        status: p.status,
        detail: typeof p.detail === "string" ? p.detail : "",
        at: r.at,
      },
    ];
  });
}

/** 5 dòng Decisions gần nhất của mỗi bot trong 7 ngày, bỏ "Order requests" (một truy vấn, lateral theo bot_events_bot_idx). */
async function logsOf(db: Db, ids: readonly string[], now: number) {
  const r = await db.execute(sql`
    select b.id as bot_id, e.decision, e.why, e.occurred_at
      from unnest(array[${idList(ids)}]) as b(id)
      cross join lateral (
        select decision, why, occurred_at from bot_events
          where bot_id = b.id and occurred_at >= ${new Date(now - LOOKBACK_MS)}
            and decision is not null and decision <> 'Order requests'
          order by occurred_at desc
          limit 5) e`);
  return rowsOf<{
    bot_id: string;
    decision: string;
    why: string | null;
    occurred_at: Date | string;
  }>(r);
}
