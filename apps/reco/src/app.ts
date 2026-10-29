import {
  accountMetricsSchema,
  assetOf,
  aiParameters,
  MAX_DROP_OPTIONS,
  RECO_GOALS,
  RECO_STRATEGIES,
  recommend,
  type RecoMarket,
} from "@drift/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

// reco: HTTP nội bộ, stateless (ARCHITECTURE.md mục 3). Chỉ api gọi; không có cookie hay dữ liệu bí mật.
// Kết quả không lưu ở đây: api lưu vào `ai_suggestions`.

const common = {
  account: accountMetricsSchema.nullable(),
  accountLeverageCap: z.number().int().positive().nullable(),
  timeZone: z.string().min(1),
  now: z.number().int().positive(),
};
const planBody = z.object({
  ...common,
  goals: z.object({
    goal: z.enum(RECO_GOALS),
    capital: z.string(),
    maxDrop: z.enum(MAX_DROP_OPTIONS),
    assets: z.array(z.string()),
  }),
});
const paramsBody = z.object({
  ...common,
  strategy: z.enum(RECO_STRATEGIES),
  market: z.string(),
  capital: z.string(),
  maxDrop: z.enum(MAX_DROP_OPTIONS),
});

export function buildRecoApp(deps: {
  markets: (assets: readonly string[]) => Promise<RecoMarket[]>;
  logLevel: string;
}): FastifyInstance {
  const app = Fastify({
    logger: { level: deps.logLevel, base: { service: "reco" } },
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 256 * 1024,
  });
  app.get("/healthz", () => ({ ok: true }));

  app.post("/v1/plan", async (request, reply) => {
    const parsed = planBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid body" });
    const b = parsed.data;
    return recommend(
      {
        account: b.account,
        goals: b.goals,
        markets: await deps.markets(b.goals.assets),
        accountLeverageCap: b.accountLeverageCap,
        now: b.now,
      },
      b.timeZone,
    );
  });

  app.post("/v1/params", async (request, reply) => {
    const parsed = paramsBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid body" });
    const b = parsed.data;
    const markets = await deps.markets([assetOf(b.market)]);
    const market = markets.find((m) => m.market === b.market);
    if (market === undefined) return reply.status(404).send({ error: "market not available" });
    const s = aiParameters(
      b.strategy,
      market,
      {
        account: b.account,
        accountLeverageCap: b.accountLeverageCap,
        now: b.now,
        capital: b.capital,
        maxDrop: b.maxDrop,
        markets,
      },
      b.timeZone,
    );
    if (s === null) return reply.status(422).send({ error: "no parameters" });
    return s;
  });
  return app;
}
