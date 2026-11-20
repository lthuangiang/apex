import { randomUUID } from "node:crypto";

import { finishSignalExperiments, type Db } from "@drift/db";
import {
  NEWS_LIMIT_DEFAULTS,
  NEWS_RULES,
  SR_QUOTES_KEY,
  SR_QUOTES_TTL_MS,
  type SrQuotesSnapshot,
} from "@drift/shared";
import { z } from "zod";

import { anthropicClassifier, type NewsClassifier } from "./classifier";
import { runContextBackfill } from "./context-backfill";
import { runNewsCycle, type MarketInfo, type PipelineConfig } from "./pipeline";
import { LiveBooks, QuoteSource } from "./prices";
import { sosoClient, type SosoClient } from "./soso";
import { spreadHists } from "./store";
import { PaperWatcher } from "./watcher";

// Lắp ráp lane tin tức của Signal research (#271) trong scheduler (leader). Không import gì của @drift/sodex: lane này
// không có client SoDEX, signer hay gateway; giá chỉ đến từ dữ liệu marketdata đã lưu (Redis / NATS / DB).

const flag = z
  .string()
  .optional()
  .transform((v) => ["true", "1"].includes((v ?? "").trim().toLowerCase()));

/** Env của lane tin tức (scheduler). Bật khi `SIGNAL_RESEARCH_ENABLED` là `true` / `1` và có đủ hai key. */
export const signalResearchEnvSchema = z.object({
  SIGNAL_RESEARCH_ENABLED: flag,
  SOSO_API_KEY: z.string().default(""),
  DESK_AI_API_KEY: z.string().default(""),
  /**
   * Ngân sách Claude mỗi ngày UTC, theo đơn vị token đầu vào quy đổi theo giá (`weightedInput`: đầu vào 1×, ghi cache TTL
   * 1 giờ 2×, đọc cache 0.1×, đầu ra 5×). Hết thì ngừng phân loại tới hôm sau (`CLAUDE_BUDGET_REACHED`).
   */
  SIGNAL_CLAUDE_DAILY_INPUT_TOKENS: z.coerce
    .number()
    .int()
    .positive()
    .default(NEWS_LIMIT_DEFAULTS.claudeDailyInputBudget),
  /** Số lần gọi API Claude tối đa mỗi chu kỳ, kể cả thử lại. */
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

const ENV_KEYS = Object.keys(signalResearchEnvSchema.shape);

/**
 * Parse env của lane RIÊNG (không gộp vào env chung của scheduler), để giá trị `SIGNAL_*` sai không bao giờ làm scheduler
 * (risk, leaderboard, fee tier…) không khởi động được. Flag tắt mà giá trị khác sai → bỏ qua, dùng mặc định, kèm cảnh
 * báo. Flag bật mà giá trị sai → lane không chạy (`env = null`) kèm lý do. Không bao giờ in giá trị.
 */
export function parseSignalEnv(raw: Readonly<Record<string, string | undefined>>): {
  env: SignalResearchEnv | null;
  warning: string | null;
} {
  const input = Object.fromEntries(ENV_KEYS.map((k) => [k, raw[k]]));
  const p = signalResearchEnvSchema.safeParse(input);
  if (p.success) return { env: p.data, warning: null };
  const bad = [...new Set(p.error.issues.map((i) => String(i.path[0] ?? "?")))].join(", ");
  const on = flag.parse(raw.SIGNAL_RESEARCH_ENABLED);
  if (on) return { env: null, warning: `invalid ${bad}` };
  return {
    env: signalResearchEnvSchema.parse({
      SIGNAL_RESEARCH_ENABLED: "false",
      SOSO_API_KEY: raw.SOSO_API_KEY,
      DESK_AI_API_KEY: raw.DESK_AI_API_KEY,
    }),
    warning: `ignored invalid ${bad} (signal research is off)`,
  };
}

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
  /** Ghi bản chụp `sr:quotes` (#308); không có → không ghi (api không có lãi / lỗ chưa chốt). */
  set?: (key: string, value: string, px: "PX", ms: number) => Promise<unknown>;
}

export interface PerpsSymbolInfo {
  name: string;
  status: string;
  tickSize: string;
  takerFee?: string | undefined;
}

const lastSchema = z.object({ price: z.string(), at: z.number() });

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
  /**
   * Danh sách perps SoDEX (scheduler đọc một lần khi nhận lease, rồi dùng chung với `mmModelTick`); null = chưa có → chu kỳ
   * chỉ Collect. Không bao giờ dò danh sách market bằng `candles_1m`.
   */
  perps: () => readonly PerpsSymbolInfo[] | null;
  now?: () => number;
  soso?: SosoClient;
  classifier?: NewsClassifier;
}) {
  const now = input.now ?? Date.now;
  const books = new LiveBooks();
  const markets = (): MarketInfo[] | null => {
    const perps = input.perps();
    if (perps === null) return null;
    return perps
      .filter((p) => p.status === "TRADING")
      .map((p) => ({ name: p.name, tickSize: p.tickSize, takerFee: p.takerFee ?? null }));
  };
  const tickSizes = () => new Map((input.perps() ?? []).map((p) => [p.name, p.tickSize] as const));
  const quotes = new QuoteSource({
    now,
    books,
    lastPrices: (m) => readLastPrices(input.redis, m),
    spreadHists: (m, since) => spreadHists(input.db, m, since),
    tickSize: (m) => tickSizes().get(m) ?? null,
  });
  const redisSet = input.redis.set?.bind(input.redis);
  const watcher = new PaperWatcher({
    db: input.db,
    quotes,
    now,
    log: input.log,
    ...(redisSet === undefined
      ? {}
      : {
          publishQuotes: async (snap: SrQuotesSnapshot) => {
            await redisSet(SR_QUOTES_KEY, JSON.stringify(snap), "PX", SR_QUOTES_TTL_MS);
          },
        }),
  });
  const soso = input.soso ?? sosoClient(input.env.SOSO_API_KEY);
  const classifier = input.classifier ?? anthropicClassifier(input.env.DESK_AI_API_KEY, input.log);
  let cycleBusy = false;
  let backfillBusy = false;
  let backfillDay: string | null = null;

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
      }
      try {
        // #377: thí nghiệm đủ 100 cặp với Baseline thì version tự dừng (Finished). Chỉ đổi trạng thái version, có audit;
        // không đụng lệnh đang mở hay logic giao dịch; Baseline không bao giờ bị dừng ở đây.
        for (const f of await finishSignalExperiments(input.db, new Date(now())))
          log.info(
            { versionId: f.id, number: f.number, verdict: f.result.verdict, pairs: f.result.pairs },
            "signal experiment finished",
          );
      } catch (e) {
        log.error(
          { err: e instanceof Error ? { name: e.name, message: e.message } : String(e) },
          "signal experiments check failed",
        );
      } finally {
        cycleBusy = false;
      }
    },
    /**
     * Backfill ngữ cảnh cho tín hiệu cũ (#333): một lượt mỗi ngày UTC (lượt đầu khi nhận lease); lượt trước chưa xong thì bỏ
     * qua. Lượt chạm giới hạn bài thì lần gọi sau trong cùng ngày chạy tiếp. Chỉ đọc DB, ghi `signal_contexts` backfilled.
     */
    async runContextBackfill(): Promise<void> {
      const day = new Date(now()).toISOString().slice(0, 10);
      if (backfillBusy || backfillDay === day) return;
      backfillBusy = true;
      const log = input.log.child({ traceId: randomUUID(), job: "signal-context-backfill" });
      try {
        const r = await runContextBackfill({ db: input.db, log, now });
        if (!r.more && r.failed === 0) backfillDay = day;
      } catch (e) {
        log.error(
          { err: e instanceof Error ? { name: e.name, message: e.message } : String(e) },
          "signal context backfill failed",
        );
      } finally {
        backfillBusy = false;
      }
    },
  };
}
