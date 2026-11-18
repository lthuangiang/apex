import {
  SIGNAL_RANGE_MS,
  signalAllQuerySchema,
  type SignalAllQuery,
  type SignalAllView,
  type SignalCostGroup,
  type SignalDriver,
} from "@drift/shared";

import { parseOrThrow } from "../../lib/http";

import { isThin, localClock, r2, str, tailOf, team, type BotInfo, type SignalDeps } from "./common";
import { CostAcc, costStrings, previousNet, type CostResult, type FillRow } from "./data";
import { fillSet, previousSet } from "./sets";

// Tab All: Net cost / $1M của mọi bot Market Making + Volume Builder tiền thật, chia phí / markout 1 phút / tồn kho &
// cắt lỗ, theo strategy, market, bot, account, ngày, giờ. Cùng tập fill (cache 60 s) với tab VB / MM.

const DAY_MS = 86_400_000;

interface Ctx {
  bots: Map<string, BotInfo>;
  botMarket: Map<string, string>;
}

export async function signalAll(
  deps: SignalDeps,
  userId: string,
  query: unknown,
): Promise<SignalAllView> {
  await team(deps, userId);
  const q = parseOrThrow(signalAllQuerySchema, query);
  const now = deps.now();
  const [mm, vb, prev] = await Promise.all([
    fillSet(deps, "volume_maker", q.range, now),
    fillSet(deps, "volume_farm", q.range, now),
    previousSet(deps, q.range, now),
  ]);
  const bots = new Map([...mm.bots, ...vb.bots].map((b) => [b.id, b]));
  const ctx: Ctx = { bots, botMarket: new Map([...bots.values()].map((b) => [b.id, b.market])) };
  // Mỗi tập có giá đánh dấu riêng; ghép để nhóm có cả hai chiến lược tính được.
  const set = {
    markEnd: new Map([...mm.markEnd, ...vb.markEnd]),
    markStart: new Map([...mm.markStart, ...vb.markStart]),
    posStart: new Map([...mm.posStart, ...vb.posStart]),
  };
  const allFills = [...mm.fills, ...vb.fills];
  const keep = matcher(q, ctx);
  const fills = allFills.filter((f) => keep(f.botId));
  const clock = localClock(q.tz);
  const w = mm.window;

  const total = new CostAcc();
  const byStrategy = new Map<string, CostAcc>();
  const byMarket = new Map<string, CostAcc>();
  const byBot = new Map<string, CostAcc>();
  const byAccount = new Map<string, CostAcc>();
  const daily = new Map<string, CostAcc>();
  const hourly = new Map<string, CostAcc>();
  const byHour = new Map<string, CostAcc>();
  const blocks = new Map<string, CostAcc>();
  const add = (m: Map<string, CostAcc>, k: string, f: FillRow) => {
    let a = m.get(k);
    if (a === undefined) {
      a = new CostAcc();
      m.set(k, a);
    }
    a.add(f);
  };
  for (const f of fills) {
    const b = bots.get(f.botId);
    if (b === undefined) continue;
    const t = clock(f.at);
    total.add(f);
    add(byStrategy, b.strategy, f);
    add(byMarket, f.market, f);
    add(byBot, b.id, f);
    add(byAccount, b.userId, f);
    add(daily, t.day, f);
    add(hourly, t.hourKey, f);
    add(byHour, String(t.hour), f);
    add(blocks, `${b.strategy}|${f.market}|${String(Math.floor(t.hour / 4) * 4)}`, f);
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
    acc: CostAcc,
    carried: boolean,
    extra: {
      strategy?: BotInfo["strategy"] | null;
      market?: string | null;
      prev?: (b: BotInfo) => boolean;
    },
  ): { g: SignalCostGroup; r: CostResult } => {
    const r = acc.result(set, ctx.botMarket, carried);
    const owners = new Set([...acc.bots].map((id) => bots.get(id)?.userId ?? ""));
    return {
      r,
      g: {
        key,
        label,
        strategy: extra.strategy ?? null,
        market: extra.market ?? null,
        bots: acc.bots.size,
        accounts: owners.size,
        ...costStrings(r),
        prevNet: extra.prev === undefined ? null : str(prevOf(extra.prev)),
        thin: isThin(acc.fills),
      },
    };
  };

  const totalG = group("all", "all", total, true, { prev: () => true });
  const strategies = [...byStrategy].map(([s, a]) =>
    group(s, s, a, true, { strategy: s as BotInfo["strategy"], prev: (b) => b.strategy === s }),
  );
  const markets = [...byMarket].map(([m, a]) =>
    group(m, m, a, true, { market: m, prev: (b) => b.market === m }),
  );
  const botGroups = [...byBot].map(([id, a]) => {
    const b = bots.get(id);
    return group(id, b?.name ?? "", a, true, {
      strategy: b?.strategy ?? null,
      market: b?.market ?? null,
      prev: (x) => x.id === id,
    });
  });
  const accounts = [...byAccount].map(([uid, a]) => {
    const kinds = new Set([...a.bots].map((id) => bots.get(id)?.strategy));
    return group(uid, tailOf(uid), a, true, {
      strategy: kinds.size === 1 ? ([...kinds][0] ?? null) : null,
      prev: (b) => b.userId === uid,
    });
  });
  const byCost = (a: { r: CostResult }, b: { r: CostResult }) =>
    (b.r.netUsd?.toNumber() ?? -Infinity) - (a.r.netUsd?.toNumber() ?? -Infinity);

  const blockGroups = [...blocks].map(([k, a]) => {
    const [s, m, h] = k.split("|");
    return {
      ...group(k, k, a, false, { strategy: s as BotInfo["strategy"], market: m ?? null }),
      hour: Number(h),
    };
  });
  const drivers = driversOf(totalG, strategies, accounts, botGroups, blockGroups);

  const days = [...daily].sort((a, b) => a[0].localeCompare(b[0]));
  const hours = [...hourly].sort((a, b) => a[0].localeCompare(b[0]));
  return {
    computedAt: now.toISOString(),
    range: q.range,
    tz: q.tz,
    from: w.from.toISOString(),
    to: w.to.toISOString(),
    bots: total.bots.size,
    accounts: new Set([...total.bots].map((id) => bots.get(id)?.userId)).size,
    markets: [...new Set(allFills.map((f) => f.market))].sort(),
    botList: botFacets(allFills, bots),
    accountList: [...new Set(allFills.map((f) => bots.get(f.botId)?.userId ?? ""))]
      .filter((x) => x !== "")
      .sort()
      .map((id) => ({ id, tail: tailOf(id) })),
    total: totalG.g,
    byStrategy: strategies.sort(byCost).map((x) => x.g),
    byMarket: markets.sort(byCost).map((x) => x.g),
    byBot: botGroups.sort(byCost).map((x) => x.g),
    byAccount: accounts.sort(byCost).map((x) => x.g),
    daily: days.map(([k, a]) => group(k, k, a, false, {}).g),
    hourly:
      SIGNAL_RANGE_MS[q.range] <= 7 * DAY_MS
        ? hours.map(([k, a]) => group(k, k, a, false, {}).g)
        : null,
    byHour: Array.from({ length: 24 }, (_, h) => {
      const a = byHour.get(String(h)) ?? new CostAcc();
      return group(String(h), String(h), a, false, {}).g;
    }),
    drivers,
  };
}

function matcher(q: SignalAllQuery, ctx: Ctx): (botId: string) => boolean {
  return (id) => {
    const b = ctx.bots.get(id);
    if (b === undefined) return false;
    if (q.strategy !== undefined && b.strategy !== q.strategy) return false;
    if (q.market !== undefined && b.market !== q.market) return false;
    if (q.account !== undefined && b.userId !== q.account) return false;
    if (q.botId !== undefined && b.id !== q.botId) return false;
    return true;
  };
}

export function botFacets(fills: readonly FillRow[], bots: Map<string, BotInfo>) {
  return [...new Set(fills.map((f) => f.botId))]
    .flatMap((id) => {
      const b = bots.get(id);
      return b === undefined
        ? []
        : [{ id: b.id, name: b.name, market: b.market, strategy: b.strategy }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface G {
  g: SignalCostGroup;
  r: CostResult;
}

/**
 * Top cost drivers: account, bot, strategy × market × khối 4 giờ có ≥ 30 fill; chi phí thêm = (net nhóm − net trung bình)
 * × volume nhóm. Chỉ nhóm tốn hơn trung bình, tối đa 4.
 */
function driversOf(
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
