import { CHART_INTERVALS } from "@drift/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { parseOrThrow } from "../../lib/http";
import { requireAuth } from "../../plugins/session";

import type { ChartService } from "./service";

const marketParams = z.object({ market: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) });

// Chart ở màn tạo bot (IMP-05): chỉ đọc, không đổi trạng thái nên không cần Idempotency-Key.
export function registerChartRoutes(app: FastifyInstance, chart: ChartService): void {
  app.get("/api/v1/markets/:market/candles", async (request) => {
    requireAuth(request);
    const { market } = parseOrThrow(marketParams, request.params);
    const q = parseOrThrow(
      z.object({ engine: z.enum(["spot", "perps"]), interval: z.enum(CHART_INTERVALS) }),
      request.query,
    );
    return chart.candles(q.engine, market, q.interval);
  });

  app.get("/api/v1/markets/:market/liquidations", async (request) => {
    requireAuth(request);
    const { market } = parseOrThrow(marketParams, request.params);
    const q = parseOrThrow(z.object({ interval: z.enum(CHART_INTERVALS) }), request.query);
    return chart.liquidations(market, q.interval);
  });

  app.get("/api/v1/markets/:market/orderbook", async (request) => {
    requireAuth(request);
    const { market } = parseOrThrow(marketParams, request.params);
    return chart.orderbook(market);
  });
}
