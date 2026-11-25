import { botVersions, bots, insertNewsSignal, runningSignalBotVersions, type Db } from "@drift/db";
import {
  BotState,
  catalystRule,
  levelOf,
  NEWS_ASSET_MAP_VERSION,
  NEWS_CLASSIFIER,
  NEWS_RULES,
  NEWS_SIGNAL_TTL_MS,
  newsSignalConfigSchema,
  Strategy,
  versionHoldHours,
  type AssetKind,
  type Decimal,
  type Quote,
  type SignalCatalyst,
  type SignalReason,
  type SourceTier,
} from "@drift/shared";
import { and, eq, inArray } from "drizzle-orm";

// Tín hiệu tin tức dùng chung cho bot `news_signal` mainnet (#419 PR 4, DEC-360): mỗi câu chuyện qua Understand trong chu
// kỳ được ghi một dòng `news_signals` (idempotent theo story key × chu kỳ), rồi phát chuông NATS `sr.signal.new` (chỉ id).
// Engine lọc riêng từng bot (loại tin, Markets, level, story, giới hạn, giá, chi phí); ở đây không lọc theo version hay bot.
// Chỉ ghi, không bao giờ đổi quyết định của research versions: báo giá đọc riêng (không dùng cache của chu kỳ), lỗi chỉ log.

/** Chủ đề NATS báo có tín hiệu mới; payload `{ "id": "<news_signals.id>" }`. */
export const NEWS_SIGNAL_SUBJECT = "sr.signal.new";

/** Một bài của câu chuyện (đã qua Understand). */
export interface NewsSignalArticle {
  articleId: string;
  source: string;
  tier: SourceTier;
  publishedAt: number;
  collectedAt: number;
  candidate: { market: string; kind: AssetKind };
  catalyst: SignalCatalyst;
  /**
   * #530 (news-v6): sự kiện nhiều coin. `eventKey` null / thiếu = một coin; `eventCoins` = số coin (bot chia cỡ lệnh);
   * `sameEvent` = bài đăng lại của sự kiện đã xét: không ghi tín hiệu.
   */
  eventKey?: string | null;
  eventCoins?: number;
  sameEvent?: boolean;
  /** #530: bài đăng lại mà coin này được thử lại (trong cửa sổ thử lại, đã qua Understand ở bài đầu): vẫn ghi tín hiệu. */
  retryable?: boolean;
}

export interface NewsSignalPublishDeps {
  db: Db;
  now: () => number;
  quotes: { quotes: (markets: readonly string[]) => Promise<Map<string, Quote | SignalReason>> };
  typical: (market: string, holdHours: number) => Promise<Decimal | null>;
  /** Phát chuông sau khi dòng đã ghi; lỗi chỉ log (engine vẫn đọc bảng ở mỗi nhịp). */
  notify: (id: string) => void;
  log: { warn: (obj: object, msg: string) => void };
}

/** Trạng thái bot còn có thể nhận tín hiệu (đang chạy, hoặc sắp chạy lại). */
const LIVE_BOT_STATES = [
  BotState.starting,
  BotState.running,
  BotState.pausing,
  BotState.paused,
  BotState.resuming,
];

/**
 * Các số giờ giữ cần biến động thường gặp cho một loại tin: mặc định của `NEWS_RULES`, của mọi research version đang
 * chạy, và của mọi bot `news_signal` còn hoạt động (config chép từ version, có thể từ version đã dừng).
 */
export async function holdHoursByCatalyst(db: Db): Promise<(catalyst: SignalCatalyst) => number[]> {
  const configs: Parameters<typeof versionHoldHours>[0][] = [];
  const { versions } = await runningSignalBotVersions(db);
  for (const v of versions) configs.push(v.config);
  const rows = await db
    .select({ config: botVersions.config })
    .from(bots)
    .innerJoin(botVersions, eq(botVersions.id, bots.activeVersionId))
    .where(and(eq(bots.strategy, Strategy.newsSignal), inArray(bots.state, LIVE_BOT_STATES)));
  for (const r of rows) {
    const p = newsSignalConfigSchema.safeParse(r.config);
    if (p.success) configs.push(p.data);
  }
  return (catalyst) => {
    const set = new Set<number>([NEWS_RULES.catalysts[catalyst].maxHoldHours]);
    for (const c of configs) {
      const h = versionHoldHours(c, catalyst);
      if (h !== null) set.add(h);
    }
    return [...set].sort((a, b) => a - b);
  };
}

/**
 * Ghi tín hiệu cho từng câu chuyện của chu kỳ. `cycleAt` = giờ bắt đầu chu kỳ (khoá idempotent cùng story key);
 * `decided_at` = đồng hồ scheduler lúc ghi, `expires_at` = `decided_at` + `NEWS_SIGNAL_TTL_MS`. Level chỉ tính từ các bài
 * của chu kỳ này (không cộng nguồn của lần thử trước, vốn riêng từng version). Trả số dòng mới.
 */
export async function publishNewsSignals(
  deps: NewsSignalPublishDeps,
  cycleAt: number,
  groups: ReadonlyMap<string, readonly NewsSignalArticle[]>,
): Promise<number> {
  if (groups.size === 0) return 0;
  const holdHours = await holdHoursByCatalyst(deps.db);
  let created = 0;
  for (const [key, group] of groups) {
    const first = group[0];
    if (first === undefined) continue;
    // #530: bài đăng lại của một sự kiện nhiều coin đã xét không mở lệnh mới trên bot mainnet, trừ lần thử lại của coin đã
    // qua Understand ở bài đầu, trong cửa sổ thử lại (cùng `event_key`, `event_coins` = k của bài đầu).
    if (first.sameEvent === true && first.retryable !== true) continue;
    if ((first.eventCoins ?? 1) < 1) continue;
    try {
      const market = first.candidate.market;
      const typicalByHoldHours: Record<string, string | null> = {};
      for (const h of holdHours(first.catalyst)) {
        const t = await deps.typical(market, h);
        typicalByHoldHours[String(h)] = t === null ? null : t.toFixed();
      }
      const q = (await deps.quotes.quotes([market])).get(market);
      const quote = q === undefined || typeof q === "string" ? null : q;
      const decidedAt = deps.now();
      const r = await insertNewsSignal(deps.db, {
        storyKey: key,
        cycleAt: new Date(cycleAt),
        articleId: first.articleId,
        market,
        kind: first.candidate.kind,
        catalyst: first.catalyst,
        side: catalystRule(first.catalyst).direction,
        level: levelOf(group.map((s) => ({ name: s.source, tier: s.tier }))),
        firstPublishedAt: new Date(first.publishedAt),
        collectedAt: new Date(first.collectedAt),
        decidedAt: new Date(decidedAt),
        expiresAt: new Date(decidedAt + NEWS_SIGNAL_TTL_MS),
        // Thiếu giá thì null ("Not available"), không bao giờ 0.
        quoteBid: quote === null ? null : quote.bid.toFixed(),
        quoteAsk: quote === null ? null : quote.ask.toFixed(),
        quoteMid: quote === null ? null : quote.bid.add(quote.ask).div(2).toFixed(),
        quoteAt: quote?.at === undefined ? null : new Date(quote.at),
        typicalByHoldHours,
        classifierVersion: NEWS_CLASSIFIER.promptVersion,
        assetMapVersion: NEWS_ASSET_MAP_VERSION,
        ruleVersion: NEWS_RULES.version,
        // #530: mỗi coin của sự kiện một dòng, cùng `event_key`; engine chia cỡ lệnh cho `event_coins` (PR1).
        eventKey: first.eventKey ?? null,
        eventCoins: first.eventCoins ?? 1,
      });
      if (!r.created) continue;
      created += 1;
      try {
        deps.notify(r.signal.id);
      } catch (e) {
        deps.log.warn(
          { err: errOf(e), signalId: r.signal.id },
          "news signal: NATS notify failed, engine reads the table",
        );
      }
    } catch (e) {
      deps.log.warn({ err: errOf(e), storyKey: key }, "news signal not written");
    }
  }
  return created;
}

const errOf = (e: unknown) =>
  e instanceof Error ? { name: e.name, message: e.message } : String(e);
