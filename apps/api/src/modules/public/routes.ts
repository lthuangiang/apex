import { bots, fills, orders } from "@drift/db";
import type { Db } from "@drift/db";
import { BotState, type PublicStats } from "@drift/shared";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

// Số liệu công khai cho Landing (DEC-148): tổng volume bot đã khớp trên SoDEX và số bot tiền thật đã từng chạy, từ
// trước đến nay. Không cần đăng nhập; cache 5 phút trong tiến trình để mỗi lượt mở trang không chạm database. Bot paper
// không được tính (quy tắc 1.2: dữ liệu paper không tính vào số liệu tiền thật); fill của bot paper không vào bảng
// `fills` nên volume vốn đã chỉ là tiền thật.

const TTL_MS = 5 * 60_000;

export function registerPublicRoutes(
  app: FastifyInstance,
  deps: { db: Db; now: () => Date },
): void {
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
        .where(and(ne(bots.state, BotState.draft), eq(bots.mode, "live")));
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
