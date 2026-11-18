import type { SignalTimelineItem } from "@drift/shared";
import { sql } from "drizzle-orm";

import { rowsOf, type Exec } from "./common";

// Order timeline của hộp chi tiết: quyết định của bot (câu Decisions, không có payload), lệnh đã gửi và fill trong một
// khoảng thời gian, theo bot_events_bot_idx / orders_bot_idx / fills_order_idx. Có giới hạn số dòng.

const iso = (ms: number) => new Date(ms).toISOString();

export async function timelineOf(
  q: Exec,
  botId: string,
  fromMs: number,
  toMs: number,
  tagLike: string,
  opts: { orderId?: string; filledOnly?: boolean } = {},
): Promise<SignalTimelineItem[]> {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const own = opts.orderId ?? null;
  const filled = opts.filledOnly === true;
  const ev = await q.execute(sql`
      select (extract(epoch from occurred_at) * 1000)::float8 as at, decision, why
        from bot_events
        where bot_id = ${botId} and occurred_at >= ${from} and occurred_at <= ${to}
          and decision is not null and decision <> 'Order requests'
        order by occurred_at
        limit 12`);
  const ord = await q.execute(sql`
      select o.id::text as id, (extract(epoch from coalesce(o.submitted_at, o.created_at)) * 1000)::float8 as at,
             o.side, o.type, o.time_in_force as tif, o.reduce_only as "reduceOnly", o.price::text as price, o.status
        from orders o
        where o.bot_id = ${botId} and o.created_at >= ${from} and o.created_at <= ${to} and o.tag like ${tagLike}
          and (${!filled} or o.filled_size > 0 or o.id::text = ${own ?? ""})
        order by o.created_at
        limit 16`);
  const orders = rowsOf<{
    id: string;
    at: number;
    side: "buy" | "sell";
    type: "limit" | "market";
    tif: string;
    reduceOnly: boolean;
    price: string | null;
    status: string;
  }>(ord);
  const ids = orders.map((o) => o.id);
  const fl =
    ids.length === 0
      ? { rows: [] }
      : await q.execute(sql`
          select (extract(epoch from f.filled_at) * 1000)::float8 as at, o.side, f.size::text as size,
                 f.price::text as price, f.fee::text as fee, f.is_maker as maker
            from fills f join orders o on o.id = f.order_id
            where f.order_id in (${sql.join(
              ids.map((x) => sql`${x}::uuid`),
              sql`, `,
            )})
            order by f.filled_at
            limit 24`);
  const items: SignalTimelineItem[] = [
    ...rowsOf<{ at: number; decision: string; why: string | null }>(ev).map((e) => ({
      kind: "decision" as const,
      at: iso(e.at),
      decision: e.decision,
      why: e.why,
    })),
    ...orders.map((o) => ({
      kind: "order" as const,
      at: iso(o.at),
      side: o.side,
      type: o.type,
      postOnly: o.tif === "GTX",
      reduceOnly: o.reduceOnly,
      price: o.price,
      status: o.status,
    })),
    ...rowsOf<{
      at: number;
      side: "buy" | "sell";
      size: string;
      price: string;
      fee: string;
      maker: boolean | null;
    }>(fl).map((f) => ({ kind: "fill" as const, ...f, at: iso(f.at) })),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at));
}
