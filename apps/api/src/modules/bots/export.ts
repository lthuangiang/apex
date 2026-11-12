import { botEvents, botVersions, candles1m, fills, orders } from "@drift/db";
import { and, asc, eq, gte, lte, max, min } from "drizzle-orm";

import { zipFiles } from "../../lib/zip";

import { ownBot, type BotDeps } from "./service";

// Export dữ liệu của một bot để phân tích (DEC-138): file ZIP gồm 5 CSV cùng cột với
// `infra/deploy/export-volume-builder.sql` (configs, events, orders, fills, candles_1m), thêm README.txt.
// Chỉ dữ liệu của chính bot: không email, user id, account SoDEX hay khoá. Thời gian theo ISO 8601 UTC.

/** Nến 1 phút tối đa xuất kèm (90 ngày): đủ để phân tích, file không quá lớn. */
const MAX_CANDLE_MS = 90 * 86_400_000;

type Cell = string | number | boolean | Date | null | undefined;

function cell(v: Cell): string {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(header: readonly string[], rows: readonly (readonly Cell[])[]): Buffer {
  const lines = [header.join(","), ...rows.map((r) => r.map(cell).join(","))];
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

const README = `DeskLabs bot export

configs.csv     Every settings version of the bot (config as JSON).
events.csv      Decisions & actions: entries, exits with entry/exit price and net, stop moves, skips, pauses.
orders.csv      Every order the bot sent, with tag, status and SoDEX reject reason.
fills.csv       Every fill: price, size, fee (builder fee included), builder fee, maker or taker.
candles_1m.csv  1-minute candles of the bot's market around its trading period (up to 90 days).

Times are ISO 8601 UTC. No email, user id, SoDEX account or keys are included.
`;

export async function exportBot(
  deps: BotDeps,
  userId: string,
  botId: string,
): Promise<{ fileName: string; data: Buffer }> {
  const b = await ownBot(deps.db, userId, botId);
  const db = deps.db;

  const versions = await db
    .select()
    .from(botVersions)
    .where(eq(botVersions.botId, botId))
    .orderBy(asc(botVersions.version));
  const configs = csv(
    [
      "bot_id",
      "bot_name",
      "strategy",
      "market",
      "state",
      "reason_code",
      "bot_created_at",
      "version",
      "version_status",
      "param_source",
      "applied_at",
      "version_created_at",
      "config",
    ],
    versions.map((v) => [
      b.id,
      b.name,
      b.strategy,
      b.market,
      b.state,
      b.reasonCode,
      b.createdAt,
      v.version,
      v.status,
      v.paramSource,
      v.appliedAt,
      v.createdAt,
      JSON.stringify(v.config),
    ]),
  );

  const ev = await db
    .select()
    .from(botEvents)
    .where(eq(botEvents.botId, botId))
    .orderBy(asc(botEvents.occurredAt));
  const events = csv(
    ["bot_id", "occurred_at", "type", "decision", "why", "result"],
    ev.map((e) => [botId, e.occurredAt, e.type, e.decision, e.why, e.result]),
  );

  const od = await db
    .select()
    .from(orders)
    .where(eq(orders.botId, botId))
    .orderBy(asc(orders.createdAt));
  const ordersCsv = csv(
    [
      "bot_id",
      "order_id",
      "cl_ord_id",
      "tag",
      "market",
      "side",
      "type",
      "time_in_force",
      "price",
      "size",
      "filled_size",
      "avg_price",
      "status",
      "reduce_only",
      "reject_code",
      "reject_message",
      "submitted_at",
      "acked_at",
      "created_at",
    ],
    od.map((o) => [
      botId,
      o.id,
      o.clOrdId,
      o.tag,
      o.market,
      o.side,
      o.type,
      o.timeInForce,
      o.price,
      o.size,
      o.filledSize,
      o.avgPrice,
      o.status,
      o.reduceOnly,
      o.rejectCode,
      o.rejectMessage,
      o.submittedAt,
      o.ackedAt,
      o.createdAt,
    ]),
  );

  const fl = await db
    .select({
      orderId: fills.orderId,
      tag: orders.tag,
      side: orders.side,
      type: orders.type,
      price: fills.price,
      size: fills.size,
      fee: fills.fee,
      builderFee: fills.builderFee,
      isMaker: fills.isMaker,
      filledAt: fills.filledAt,
    })
    .from(fills)
    .innerJoin(orders, eq(orders.id, fills.orderId))
    .where(eq(orders.botId, botId))
    .orderBy(asc(fills.filledAt));
  const fillsCsv = csv(
    [
      "bot_id",
      "order_id",
      "tag",
      "side",
      "type",
      "price",
      "size",
      "fee",
      "builder_fee",
      "is_maker",
      "filled_at",
    ],
    fl.map((f) => [
      botId,
      f.orderId,
      f.tag,
      f.side,
      f.type,
      f.price,
      f.size,
      f.fee,
      f.builderFee,
      f.isMaker,
      f.filledAt,
    ]),
  );

  // Nến từ 1 giờ trước lệnh đầu tiên tới 1 giờ sau lần khớp / lệnh cuối (hoặc bây giờ), tối đa 90 ngày gần nhất.
  const [span] = await db
    .select({ first: min(orders.createdAt), last: max(orders.createdAt) })
    .from(orders)
    .where(eq(orders.botId, botId));
  const now = deps.now().getTime();
  const lastAt = Math.min(now, (span?.last?.getTime() ?? b.createdAt.getTime()) + 3_600_000);
  const firstAt = Math.max(
    (span?.first?.getTime() ?? b.createdAt.getTime()) - 3_600_000,
    lastAt - MAX_CANDLE_MS,
  );
  const cd = await db
    .select()
    .from(candles1m)
    .where(
      and(
        eq(candles1m.market, b.market),
        gte(candles1m.ts, new Date(firstAt)),
        lte(candles1m.ts, new Date(lastAt)),
      ),
    )
    .orderBy(asc(candles1m.ts));
  const candles = csv(
    ["market", "ts", "open", "high", "low", "close", "volume"],
    cd.map((k) => [k.market, k.ts, k.open, k.high, k.low, k.close, k.volume]),
  );

  const at = deps.now();
  const slug =
    b.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "bot";
  const day = at.toISOString().slice(0, 10);
  return {
    fileName: `drift-${slug}-${day}.zip`,
    data: zipFiles(
      [
        { name: "README.txt", data: Buffer.from(README, "utf8") },
        { name: "configs.csv", data: configs },
        { name: "events.csv", data: events },
        { name: "orders.csv", data: ordersCsv },
        { name: "fills.csv", data: fillsCsv },
        { name: "candles_1m.csv", data: candles },
      ],
      at,
    ),
  };
}
