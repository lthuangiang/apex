import { bots, fills, orders } from "@drift/db";
import type { Db } from "@drift/db";
import { BotState, type OrderbookView, type PublicStats } from "@drift/shared";
import { isNotNull, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

// Số liệu công khai cho Landing (DEC-148): tổng volume bot đã khớp trên SoDEX và số bot đã từng chạy, từ trước đến
// nay. Không cần đăng nhập; cache 5 phút trong tiến trình để mỗi lượt mở trang không chạm database.

const TTL_MS = 5 * 60_000;

/** Market được hiện sổ lệnh công khai trên Landing (DEC-155). */
const PUBLIC_BOOK_MARKETS = new Set(["BTC-USD"]);

export function registerPublicRoutes(
  app: FastifyInstance,
  deps: { db: Db; now: () => Date; orderbook: (market: string) => Promise<OrderbookView> },
): void {
  // Sổ lệnh trực tiếp cho thẻ minh hoạ trên Landing (DEC-155): chỉ BTC-USD, chỉ đọc, dùng chung cache 1 s của chart.
  app.get("/api/v1/public/orderbook", async (request, reply) => {
    const market = (request.query as { market?: string }).market ?? "BTC-USD";
    if (!PUBLIC_BOOK_MARKETS.has(market)) {
      void reply.code(404);
      return { error: "not_found" };
    }
    void reply.header("Cache-Control", "public, max-age=1");
    return deps.orderbook(market);
  });

  let cached: { at: number; value: PublicStats } | null = null;

  app.get("/api/v1/public/stats", async (_request, reply) => {
    const now = deps.now().getTime();
    if (cached === null || now - cached.at > TTL_MS) {
      const [vol] = await deps.db
        .select({ v: sql<string>`coalesce(sum(${fills.price} * ${fills.size}), 0)::text` })
        .from(fills)
        .innerJoin(orders, sql`${orders.id} = ${fills.orderId}`)
        .where(isNotNull(orders.botId));
      const [launched] = await deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(bots)
        .where(ne(bots.state, BotState.draft));
      cached = {
        at: now,
        value: {
          totalVolume: Number(vol?.v ?? "0").toFixed(0),
          botsLaunched: launched?.n ?? 0,
          at: now,
        },
      };
    }
    void reply.header("Cache-Control", "public, max-age=300");
    return cached.value;
  });
}
