import {
  SIGNAL_RANGE_MS,
  signalAllQuerySchema,
  type SignalAllView,
  type SignalCostGroup,
  type SignalDriver,
} from "@drift/shared";
import { sql } from "drizzle-orm";

import { parseOrThrow } from "../../lib/http";

import {
  D0,
  inList,
  isThin,
  liveBots,
  r2,
  readOnly,
  rowsOf,
  str,
  tailOf,
  team,
  type BotInfo,
  type Exec,
  type SignalDeps,
  type Window,
} from "./common";
import {
  addSums,
  baseCte,
  carriedOf,
  costOf,
  costStrings,
  deltaOf,
  emptySums,
  marksFor,
  previousNet,
  sumsOf,
  SUMS_SQL,
  type CostResult,
  type Marks,
  type Sums,
  type SumsRow,
} from "./data";
import { extraSet, previousSet, snapshotOf } from "./sets";

// Tab All: Net cost / $1M của mọi bot Market Making + Volume Builder tiền thật, chia phí / markout 1 phút / tồn kho &
// cắt lỗ, theo strategy, market, bot, account, ngày, giờ. Cộng trong SQL theo (bot, ngày, giờ địa phương) trong MỘT truy
// vấn cho cả hai chiến lược (cùng cửa sổ của ảnh chụp, review #246 điểm 4 và 10); Node chỉ gộp vài nghìn dòng.

const DAY_MS = 86_400_000;
const STRATEGIES = ["volume_maker", "volume_farm"] as const;

interface Cell {
  bot: string;
  day: string;
  hour: number;
  sums: Sums;
}

/** Bot MM / VB tiền thật có lệnh đã khớp tạo trong kỳ (cho bộ chọn; theo orders_bot_filled_idx, không quét fill). */
export async function activeBots(q: Exec, w: Window, strategies: readonly BotInfo["strategy"][]) {
  const r = await q.execute(sql`
    select b.id::text as id from bots b
      where b.mode = 'live' and b.strategy in (${inList(strategies)})
        and exists (select 1 from orders o
          where o.bot_id = b.id and o.filled_size > 0 and o.created_at >= ${w.from} and o.created_at < ${w.to})`);
  return new Set(rowsOf<{ id: string }>(r).map((x) => x.id));
}

async function loadCells(
  q: Exec,
  w: Window,
  tz: string,
): Promise<{ cells: Cell[]; bots: BotInfo[]; active: Set<string>; marks: Marks }> {
  const bots = await liveBots(q, STRATEGIES);
  const active = await activeBots(q, w, STRATEGIES);
  const r = await q.execute(sql`
    with ${baseCte({ w, strategies: STRATEGIES, mm: false, tz })}
    select bot_id::text as bot, local_day as day, local_hour as hour, ${SUMS_SQL}
      from base
      group by 1, 2, 3`);
  const cells = rowsOf<SumsRow & { bot: string; day: string; hour: number }>(r).map((x) => ({
    bot: x.bot,
    day: x.day,
    hour: x.hour,
    sums: sumsOf(x),
  }));
  const byId = new Map(bots.map((b) => [b.id, b]));
  const ids = [...new Set(cells.map((c) => c.bot))];
  const markets = [...new Set(ids.map((id) => byId.get(id)?.market ?? ""))].filter((m) => m !== "");
  const marks = await marksFor(q, w, markets, ids);
  return { cells, bots, active, marks };
}

export async function signalAll(
  deps: SignalDeps,
  userId: string,
  query: unknown,
): Promise<SignalAllView> {
  await team(deps, userId);
  const q = parseOrThrow(signalAllQuerySchema, query);
  const now = deps.now();
  const snap = snapshotOf(deps, q.range, now);
  // Một tổng hợp mỗi (kỳ, múi giờ); bộ lọc strategy / market / account / bot áp trong Node (ô đã theo bot).
  const [data, prev] = await Promise.all([
    extraSet(snap, `all|${q.tz}`, () => readOnly(deps, (x) => loadCells(x, snap.window, q.tz))),
    previousSet(deps, snap),
  ]);
  const bots = new Map(data.bots.map((b) => [b.id, b]));
  const marketOf = (id: string) => bots.get(id)?.market;
  const keep = (id: string) => {
    const b = bots.get(id);
    return (
      b !== undefined &&
      (q.strategy === undefined || b.strategy === q.strategy) &&
      (q.market === undefined || b.market === q.market) &&
      (q.account === undefined || b.userId === q.account) &&
      (q.botId === undefined || b.id === q.botId)
    );
  };

  interface Acc {
    sums: Sums;
    bots: Set<string>;
  }
  const maps = {
    total: new Map<string, Acc>(),
    strategy: new Map<string, Acc>(),
    market: new Map<string, Acc>(),
    bot: new Map<string, Acc>(),
    account: new Map<string, Acc>(),
    daily: new Map<string, Acc>(),
    hourly: new Map<string, Acc>(),
    hour: new Map<string, Acc>(),
    block: new Map<string, Acc>(),
  };
  const add = (m: Map<string, Acc>, k: string, c: Cell) => {
    const a = m.get(k) ?? { sums: emptySums(), bots: new Set<string>() };
    a.sums = addSums(a.sums, c.sums);
    a.bots.add(c.bot);
    m.set(k, a);
  };
  for (const c of data.cells) {
    const b = bots.get(c.bot);
    if (b === undefined || !keep(c.bot)) continue;
    add(maps.total, "all", c);
    add(maps.strategy, b.strategy, c);
    add(maps.market, b.market, c);
    add(maps.bot, b.id, c);
    add(maps.account, b.userId, c);
    add(maps.daily, c.day, c);
    add(maps.hourly, `${c.day}T${String(c.hour).padStart(2, "0")}`, c);
    add(maps.hour, String(c.hour), c);
    add(maps.block, `${b.strategy}|${b.market}|${String(Math.floor(c.hour / 4) * 4)}`, c);
  }

  const prevOf = (pred: (b: BotInfo) => boolean) =>
    previousNet(
      prev,
      [...prev.legs.keys()].filter((id) => {
        const b = bots.get(id);
        return b !== undefined && keep(id) && pred(b);
      }),
    );
  const group = (
    key: string,
    label: string,
    acc: Acc | undefined,
    carried: boolean,
    extra: {
      strategy?: BotInfo["strategy"] | null;
      market?: string | null;
      prev?: (b: BotInfo) => boolean;
    },
  ): { g: SignalCostGroup; r: CostResult } => {
    const a = acc ?? { sums: emptySums(), bots: new Set<string>() };
    // Nhóm theo thời gian không cộng vị thế mang sang (carried = 0).
    const res = costOf(a.sums, carried ? carriedOf(data.marks, a.bots, marketOf) : D0);
    const owners = new Set([...a.bots].map((id) => bots.get(id)?.userId ?? ""));
    const prevNet = extra.prev === undefined ? null : prevOf(extra.prev);
    return {
      r: res,
      g: {
        key,
        label,
        strategy: extra.strategy ?? null,
        market: extra.market ?? null,
        bots: a.bots.size,
        accounts: owners.size,
        ...costStrings(res),
        prevNet: str(prevNet),
        vsPrev: deltaOf(res.net, prevNet),
        priced: res.priced,
        thin: isThin(a.sums.n),
      },
    };
  };

  const totalG = group("all", "all", maps.total.get("all"), true, { prev: () => true });
  const strategies = [...maps.strategy].map(([s, a]) =>
    group(s, s, a, true, {
      strategy: s as BotInfo["strategy"],
      prev: (b) => b.strategy === s,
    }),
  );
  const markets = [...maps.market].map(([m, a]) =>
    group(m, m, a, true, { market: m, prev: (b) => b.market === m }),
  );
  const botGroups = [...maps.bot].map(([id, a]) => {
    const b = bots.get(id);
    return group(id, b?.name ?? "", a, true, {
      strategy: b?.strategy ?? null,
      market: b?.market ?? null,
      prev: (x) => x.id === id,
    });
  });
  const accounts = [...maps.account].map(([uid, a]) => {
    const kinds = new Set([...a.bots].map((id) => bots.get(id)?.strategy));
    return group(uid, tailOf(uid), a, true, {
      strategy: kinds.size === 1 ? ([...kinds][0] ?? null) : null,
      prev: (b) => b.userId === uid,
    });
  });
  const byCost = (a: { r: CostResult }, b: { r: CostResult }) =>
    (b.r.netUsd?.toNumber() ?? -Infinity) - (a.r.netUsd?.toNumber() ?? -Infinity);
  const blockGroups = [...maps.block].map(([k, a]) => {
    const [s, m, h] = k.split("|");
    return {
      ...group(k, k, a, false, { strategy: s as BotInfo["strategy"], market: m ?? null }),
      hour: Number(h),
    };
  });
  const drivers = driversOf(totalG, strategies, accounts, botGroups, blockGroups);
  const facetIds = [...data.active].filter((id) => bots.has(id));
  const w = snap.window;
  return {
    computedAt: new Date(snap.at).toISOString(),
    range: q.range,
    tz: q.tz,
    from: w.from.toISOString(),
    to: w.to.toISOString(),
    bots: totalG.g.bots,
    accounts: totalG.g.accounts,
    markets: [...new Set(facetIds.map((id) => bots.get(id)?.market ?? ""))].sort(),
    botList: botFacets(facetIds, bots),
    accountList: [...new Set(facetIds.map((id) => bots.get(id)?.userId ?? ""))]
      .filter((x) => x !== "")
      .sort()
      .map((id) => ({ id, tail: tailOf(id) })),
    total: totalG.g,
    byStrategy: strategies.sort(byCost).map((x) => x.g),
    byMarket: markets.sort(byCost).map((x) => x.g),
    byBot: botGroups.sort(byCost).map((x) => x.g),
    byAccount: accounts.sort(byCost).map((x) => x.g),
    daily: [...maps.daily]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, a]) => group(k, k, a, false, {}).g),
    hourly:
      SIGNAL_RANGE_MS[q.range] <= 7 * DAY_MS
        ? [...maps.hourly]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([k, a]) => group(k, k, a, false, {}).g)
        : null,
    byHour: Array.from(
      { length: 24 },
      (_, h) => group(String(h), String(h), maps.hour.get(String(h)), false, {}).g,
    ),
    drivers,
  };
}

/**
 * Lựa chọn của bộ chọn bot: tên, ngày tạo và đuôi account (DEC-288: chỉ account, không bao giờ email) để phân biệt
 * nhiều bot cùng tên. Thứ tự: theo đuôi account, rồi bot mới nhất trước.
 */
export function botFacets(ids: Iterable<string>, bots: Map<string, BotInfo>) {
  return [...new Set(ids)]
    .flatMap((id) => {
      const b = bots.get(id);
      return b === undefined
        ? []
        : [
            {
              id: b.id,
              name: b.name,
              market: b.market,
              strategy: b.strategy,
              createdAt: new Date(b.createdAt).toISOString(),
              tail: tailOf(b.userId),
            },
          ];
    })
    .sort(
      (a, b) =>
        a.tail.localeCompare(b.tail) ||
        b.createdAt.localeCompare(a.createdAt) ||
        a.id.localeCompare(b.id),
    );
}

interface G {
  g: SignalCostGroup;
  r: CostResult;
}

/**
 * Top cost drivers: account, bot, strategy × market × khối 4 giờ có ≥ 30 fill; chi phí thêm = (net nhóm − net trung bình)
 * × volume nhóm. Chỉ nhóm tốn hơn trung bình, tối đa 4.
 */
export function driversOf(
  total: G,
  strategies: readonly G[],
  accounts: readonly G[],
  bots: readonly G[],
  blocks: readonly (G & { hour: number })[],
): SignalDriver[] {
  const avg = total.r.net;
  if (avg === null) return [];
  const totalUsd = total.r.netUsd;
  const totalPositive = totalUsd === null || totalUsd.lte(0) ? null : totalUsd;
  const partOf = (r: CostResult): SignalDriver["part"] => {
    const parts: [SignalDriver["part"], number][] = [
      ["fees", r.fees?.toNumber() ?? -Infinity],
      ["markout", r.markout?.toNumber() ?? -Infinity],
      ["inventory", r.inventory?.toNumber() ?? -Infinity],
    ];
    return parts.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  };
  const partValue = (r: CostResult | undefined, p: SignalDriver["part"]) =>
    r === undefined ? null : p === "fees" ? r.fees : p === "markout" ? r.markout : r.inventory;
  const cands = [
    ...accounts.map((x) => ({ kind: "account" as const, x, hour: null })),
    ...bots.map((x) => ({ kind: "bot" as const, x, hour: null })),
    ...blocks.map((x) => ({ kind: "strategyMarketHours" as const, x, hour: x.hour })),
  ].flatMap(({ kind, x, hour }) => {
    if (isThin(x.r.fills) || x.r.net === null) return [];
    const extra = x.r.net.sub(avg).mul(x.r.volume).div(1_000_000);
    if (!extra.gt(0)) return [];
    const part = partOf(x.r);
    const scope = kind === "account" ? total : strategies.find((s) => s.g.key === x.g.strategy);
    return [
      {
        extra,
        d: {
          kind,
          group: x.g,
          extraUsd: str(extra) ?? "0",
          part,
          partOverall: str(partValue(scope?.r, part)),
          sharePct:
            totalPositive === null ? null : r2(extra.div(totalPositive).mul(100).toNumber()),
          hourFrom: hour,
        } satisfies SignalDriver,
      },
    ];
  });
  return cands
    .sort((a, b) => b.extra.cmp(a.extra))
    .slice(0, 4)
    .map((c) => c.d);
}
