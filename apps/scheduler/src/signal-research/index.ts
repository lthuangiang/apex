import { randomUUID } from "node:crypto";

import type { Db } from "@drift/db";
import { NEWS_LIMIT_DEFAULTS, NEWS_RULES } from "@drift/shared";
import { z } from "zod";

import { anthropicClassifier, type NewsClassifier } from "./classifier";
import { runNewsCycle, type MarketInfo, type PipelineConfig } from "./pipeline";
import { LiveBooks, QuoteSource } from "./prices";
import { sosoClient, type SosoClient } from "./soso";
import { recentPerpsMarkets, spreadHists } from "./store";
import { PaperWatcher } from "./watcher";

// Lắp ráp lane tin tức của Signal research (#271) trong scheduler (leader). Không import gì của @drift/sodex: lane này
// không có client SoDEX, signer hay gateway; giá chỉ đến từ dữ liệu marketdata đã lưu (Redis / NATS / DB).

/** Env của lane tin tức (scheduler). Bật khi `SIGNAL_RESEARCH_ENABLED=true` và có đủ hai key. */
export const signalResearchEnvSchema = z.object({
  SIGNAL_RESEARCH_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SOSO_API_KEY: z.string().default(""),
  DESK_AI_API_KEY: z.string().default(""),
  /** Token đầu vào quy đổi mỗi ngày UTC (đọc cache tính 1/10); hết thì ngừng phân loại tới hôm sau. */
  SIGNAL_CLAUDE_DAILY_INPUT_TOKENS: z.coerce
    .number()
    .int()
    .positive()
    .default(NEWS_LIMIT_DEFAULTS.claudeDailyInputBudget),
  SIGNAL_CLAUDE_MAX_CALLS_PER_CYCLE: z.coerce
    .number()
    .int()
    .positive()
    .default(NEWS_LIMIT_DEFAULTS.claudeMaxCallsPerCycle),
  SIGNAL_SOSO_MAX_PAGES: z.coerce
    .number()
    .int()
    .min(1)
    .max(5)
    .default(NEWS_LIMIT_DEFAULTS.sosoMaxPages),
  /** Gói free của SoSoValue: 10 000 request / tháng; chừa phần dư. */
  SIGNAL_SOSO_MONTHLY_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(NEWS_LIMIT_DEFAULTS.sosoMonthlyLimit),
  SIGNAL_NEWS_START_LOOKBACK_MIN: z.coerce
    .number()
    .int()
    .positive()
    .default(NEWS_RULES.startLookbackMinutes),
  SIGNAL_NEWS_MAX_CATCHUP_MIN: z.coerce
    .number()
    .int()
    .positive()
    .default(NEWS_RULES.maxCatchUpMinutes),
});
export type SignalResearchEnv = z.infer<typeof signalResearchEnvSchema>;

export function pipelineConfig(env: SignalResearchEnv): PipelineConfig {
  return {
    claudeDailyInputBudget: env.SIGNAL_CLAUDE_DAILY_INPUT_TOKENS,
    claudeMaxCallsPerCycle: env.SIGNAL_CLAUDE_MAX_CALLS_PER_CYCLE,
    sosoMaxPages: env.SIGNAL_SOSO_MAX_PAGES,
    sosoMonthlyLimit: env.SIGNAL_SOSO_MONTHLY_LIMIT,
    startLookbackMinutes: env.SIGNAL_NEWS_START_LOOKBACK_MIN,
    maxCatchUpMinutes: env.SIGNAL_NEWS_MAX_CATCHUP_MIN,
  };
}

/** Lý do không chạy (để log), hoặc null khi đủ điều kiện. Không bao giờ in giá trị key. */
export function disabledReason(env: SignalResearchEnv): string | null {
  if (!env.SIGNAL_RESEARCH_ENABLED) return "SIGNAL_RESEARCH_ENABLED is not true";
  if (env.SOSO_API_KEY.trim() === "") return "SOSO_API_KEY is not set";
  if (env.DESK_AI_API_KEY.trim() === "") return "DESK_AI_API_KEY is not set";
  return null;
}

export interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
  child: (bindings: Record<string, unknown>) => Logger;
}

export interface RedisLike {
  mget: (...keys: string[]) => Promise<(string | null)[]>;
}

export interface PerpsSymbolInfo {
  name: string;
  status: string;
  tickSize: string;
  takerFee?: string | undefined;
}

const lastSchema = z.object({ price: z.string(), at: z.number() });
const MARKETS_CACHE_MS = 10 * 60_000;

/** Redis `md:last:<market>` (marketdata ghi mỗi ~2 s, hết hạn 60 s). */
export async function readLastPrices(
  redis: RedisLike,
  markets: readonly string[],
): Promise<Map<string, { price: string; at: number }>> {
  const out = new Map<string, { price: string; at: number }>();
  if (markets.length === 0) return out;
  const raw = await redis.mget(...markets.map((m) => `md:last:${m}`));
  markets.forEach((m, i) => {
    const v = raw[i];
    if (v == null) return;
    try {
      const p = lastSchema.safeParse(JSON.parse(v));
      if (p.success) out.set(m, p.data);
    } catch {
      // bỏ giá trị hỏng
    }
  });
  return out;
}

export function createSignalResearch(input: {
  db: Db;
  redis: RedisLike;
  log: Logger;
  env: SignalResearchEnv;
  /** Danh sách perps SoDEX scheduler đã đọc cho việc khác (không gọi thêm REST); null = chưa có. */
  perps: () => readonly PerpsSymbolInfo[] | null;
  now?: () => number;
  soso?: SosoClient;
  classifier?: NewsClassifier;
}) {
  const now = input.now ?? Date.now;
  const books = new LiveBooks();
  let fallback: { at: number; markets: string[] } | null = null;
  const markets = async (): Promise<MarketInfo[]> => {
    const perps = input.perps();
    if (perps !== null && perps.length > 0)
      return perps
        .filter((p) => p.status === "TRADING")
        .map((p) => ({ name: p.name, tickSize: p.tickSize, takerFee: p.takerFee ?? null }));
    if (fallback === null || now() - fallback.at > MARKETS_CACHE_MS)
      fallback = { at: now(), markets: await recentPerpsMarkets(input.db, now()) };
    return fallback.markets.map((name) => ({ name, tickSize: null, takerFee: null }));
  };
  const tickSizes = () => new Map((input.perps() ?? []).map((p) => [p.name, p.tickSize] as const));
  const quotes = new QuoteSource({
    now,
    books,
    lastPrices: (m) => readLastPrices(input.redis, m),
    spreadHists: (m, since) => spreadHists(input.db, m, since),
    tickSize: (m) => tickSizes().get(m) ?? null,
  });
  const watcher = new PaperWatcher({ db: input.db, quotes, now, log: input.log });
  const soso = input.soso ?? sosoClient(input.env.SOSO_API_KEY);
  const classifier = input.classifier ?? anthropicClassifier(input.env.DESK_AI_API_KEY);
  let cycleBusy = false;

  return {
    books,
    watcher,
    /** Một chu kỳ 5 phút; chu kỳ trước chưa xong thì bỏ qua. */
    async runCycle(): Promise<void> {
      if (cycleBusy) return;
      cycleBusy = true;
      const log = input.log.child({ traceId: randomUUID(), job: "signal-research" });
      try {
        await runNewsCycle({
          db: input.db,
          soso,
          classifier,
          quotes,
          markets,
          now,
          log,
          config: pipelineConfig(input.env),
          onTradeOpened: () => {
            watcher.invalidate();
          },
        });
      } catch (e) {
        log.error(
          { err: e instanceof Error ? { name: e.name, message: e.message } : String(e) },
          "signal research cycle failed",
        );
      } finally {
        cycleBusy = false;
      }
    },
  };
}
