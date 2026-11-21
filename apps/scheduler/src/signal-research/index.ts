import { randomUUID } from "node:crypto";

import { finishSignalExperiments, type Db } from "@drift/db";
import {
  claudeCallsForCycle,
  NEWS_CYCLE,
  NEWS_LIMIT_DEFAULTS,
  NEWS_RULES,
  SR_LANE_KEY,
  SR_LANE_TTL_MS,
  SR_QUOTES_KEY,
  SR_QUOTES_TTL_MS,
  type SrLaneSnapshot,
  type SrQuotesSnapshot,
} from "@drift/shared";
import { z } from "zod";

import { anthropicClassifier, type NewsClassifier } from "./classifier";
import { runContextBackfill } from "./context-backfill";
import { runNewsCycle, type MarketInfo, type PipelineConfig } from "./pipeline";
import { LiveBooks, QuoteSource } from "./prices";
import { sosoClient, SosoRateLimiter, type SosoClient } from "./soso";
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
  /**
   * Chu kỳ Collect → Decide (phút, #394): số nguyên 1–5, mặc định 5. Giá trị sai không bao giờ làm lane hay scheduler dừng:
   * `parseSignalEnv` bỏ giá trị đó, dùng 5 và trả cảnh báo.
   */
  SIGNAL_NEWS_CYCLE_MINUTES: z.coerce
    .number()
    .int()
    .min(NEWS_CYCLE.minMinutes)
    .max(NEWS_CYCLE.maxMinutes)
    .default(NEWS_CYCLE.defaultMinutes),
  /**
   * Số lần gọi API Claude tối đa mỗi 5 phút (= một chu kỳ mặc định), kể cả thử lại. Chu kỳ ngắn hơn chia theo tỷ lệ
   * (`claudeCallsForCycle`: 50 ở chu kỳ 1 phút → 10 mỗi chu kỳ), để tổng mỗi giờ không tăng khi chạy 1 phút.
   */
  SIGNAL_CLAUDE_MAX_CALLS_PER_CYCLE: z.coerce
    .number()
    .int()
    .positive()
    .default(NEWS_LIMIT_DEFAULTS.claudeMaxCallsPerCycle),
  /**
   * Số trang tin tối đa mỗi chu kỳ (1–5). Chu kỳ ≥ 1 phút và không chồng nhau nên mỗi phút ≤ 5 request, dưới trần 20 / phút
   * của SoSoValue; `SosoRateLimiter` vẫn chặn cứng ở 20 request / phút trượt.
   */
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
  /**
   * #419 PR 4: ghi tín hiệu dùng chung cho bot `news_signal` mainnet (`news_signals`) và phát chuông NATS `sr.signal.new`.
   * Mặc định tắt. Chỉ có tác dụng khi lane chạy (`SIGNAL_RESEARCH_ENABLED`); không đổi gì của research versions.
   */
  SIGNAL_NEWS_PUBLISH_ENABLED: flag,
});
export type SignalResearchEnv = z.infer<typeof signalResearchEnvSchema>;

const ENV_KEYS = Object.keys(signalResearchEnvSchema.shape);

const CYCLE_KEY = "SIGNAL_NEWS_CYCLE_MINUTES";

/**
 * Parse env của lane RIÊNG (không gộp vào env chung của scheduler), để giá trị `SIGNAL_*` sai không bao giờ làm scheduler
 * (risk, leaderboard, fee tier…) không khởi động được. Flag tắt mà giá trị khác sai → bỏ qua, dùng mặc định, kèm cảnh
 * báo. Flag bật mà giá trị sai → lane không chạy (`env = null`) kèm lý do. Riêng `SIGNAL_NEWS_CYCLE_MINUTES` (#394): sai
 * thì luôn dùng 5 kèm cảnh báo, lane vẫn chạy. Không bao giờ in giá trị.
 */
export function parseSignalEnv(raw: Readonly<Record<string, string | undefined>>): {
  env: SignalResearchEnv | null;
  warning: string | null;
} {
  const input: Record<string, string | undefined> = Object.fromEntries(
    ENV_KEYS.map((k) => [k, raw[k]]),
  );
  const notes: string[] = [];
  if (!signalResearchEnvSchema.shape[CYCLE_KEY].safeParse(input[CYCLE_KEY]).success) {
    input[CYCLE_KEY] = undefined;
    notes.push(`invalid ${CYCLE_KEY}, using ${String(NEWS_CYCLE.defaultMinutes)}`);
  }
  const p = signalResearchEnvSchema.safeParse(input);
  if (p.success) return { env: p.data, warning: notes.length === 0 ? null : notes.join("; ") };
  const bad = [...new Set(p.error.issues.map((i) => String(i.path[0] ?? "?")))].join(", ");
  const on = flag.parse(raw.SIGNAL_RESEARCH_ENABLED);
  if (on) return { env: null, warning: [`invalid ${bad}`, ...notes].join("; ") };
  return {
    env: signalResearchEnvSchema.parse({
      SIGNAL_RESEARCH_ENABLED: "false",
      SOSO_API_KEY: raw.SOSO_API_KEY,
      DESK_AI_API_KEY: raw.DESK_AI_API_KEY,
      [CYCLE_KEY]: input[CYCLE_KEY],
    }),
    warning: [`ignored invalid ${bad} (signal research is off)`, ...notes].join("; "),
  };
}

/** Hẹn `run` mỗi `cycleMinutes` phút (`setInterval`); `every` thay được trong test. */
export function scheduleNewsCycle(
  run: () => void,
  cycleMinutes: number,
  every: (fn: () => void, ms: number) => ReturnType<typeof setInterval> = setInterval,
): ReturnType<typeof setInterval> {
  return every(run, cycleMinutes * 60_000);
}

/**
 * Cảnh báo khi trần tháng `SIGNAL_SOSO_MONTHLY_LIMIT` sẽ hết trước cuối tháng ở chu kỳ đang đặt (ít nhất 1 request mỗi
 * chu kỳ, tháng 31 ngày); null khi đủ. Không tự nâng trần: chỉ người dùng nâng sau khi xác nhận quota thật của key.
 */
export function monthlyLimitWarning(env: SignalResearchEnv): string | null {
  const need = Math.ceil((31 * 24 * 60) / env.SIGNAL_NEWS_CYCLE_MINUTES);
  if (need <= env.SIGNAL_SOSO_MONTHLY_LIMIT) return null;
  return `SIGNAL_SOSO_MONTHLY_LIMIT ${String(env.SIGNAL_SOSO_MONTHLY_LIMIT)} is below about ${String(need)} requests a month needed at ${String(env.SIGNAL_NEWS_CYCLE_MINUTES)} min per cycle; collection stops (Delayed) when it is reached`;
}

export function pipelineConfig(env: SignalResearchEnv): PipelineConfig {
  return {
    claudeDailyInputBudget: env.SIGNAL_CLAUDE_DAILY_INPUT_TOKENS,
    claudeMaxCallsPerCycle: claudeCallsForCycle(
      env.SIGNAL_CLAUDE_MAX_CALLS_PER_CYCLE,
      env.SIGNAL_NEWS_CYCLE_MINUTES,
    ),
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
  /** Phát chuông `sr.signal.new` (main nối NATS); lỗi chỉ log. Thiếu = không phát (engine vẫn đọc bảng). */
  notifySignal?: (id: string) => void;
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
  // Một bộ đếm cho cả tiến trình: mọi chu kỳ (và `signals:once`) dùng chung trần 20 request / phút của key.
  const sosoLimiter = new SosoRateLimiter(now);
  /** Ghi `sr:lane` (#394); lỗi Redis chỉ log, không bao giờ chặn chu kỳ. */
  const publishLane = async (): Promise<void> => {
    if (redisSet === undefined) return;
    const snap: SrLaneSnapshot = {
      cycleMinutes: input.env.SIGNAL_NEWS_CYCLE_MINUTES,
      sosoMonthlyLimit: input.env.SIGNAL_SOSO_MONTHLY_LIMIT,
      updatedAt: new Date(now()).toISOString(),
    };
    await redisSet(SR_LANE_KEY, JSON.stringify(snap), "PX", SR_LANE_TTL_MS).catch((e: unknown) => {
      input.log.warn(
        { err: e instanceof Error ? { name: e.name, message: e.message } : String(e) },
        "signal research lane snapshot not written",
      );
    });
  };
  const classifier = input.classifier ?? anthropicClassifier(input.env.DESK_AI_API_KEY, input.log);
  let cycleBusy = false;
  let backfillBusy = false;
  let backfillDay: string | null = null;

  return {
    books,
    watcher,
    /** Chu kỳ (phút) đã parse từ `SIGNAL_NEWS_CYCLE_MINUTES`. */
    cycleMinutes: input.env.SIGNAL_NEWS_CYCLE_MINUTES,
    /**
     * Một chu kỳ (`SIGNAL_NEWS_CYCLE_MINUTES`, mặc định 5 phút); chu kỳ trước chưa xong thì bỏ qua. Mỗi lần tới nhịp ghi bản
     * chụp `sr:lane` để api biết chu kỳ thật: sau chu kỳ (để không chen vào đồng hồ của chu kỳ), hoặc ngay khi bỏ qua.
     */
    async runCycle(): Promise<void> {
      if (cycleBusy) {
        await publishLane();
        return;
      }
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
          sosoLimiter,
          onTradeOpened: () => {
            watcher.invalidate();
          },
          newsSignals: input.env.SIGNAL_NEWS_PUBLISH_ENABLED
            ? { notify: (id) => input.notifySignal?.(id) }
            : null,
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
      await publishLane();
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
