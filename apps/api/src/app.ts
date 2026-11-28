import type { Db } from "@drift/db";
import type { BotApi } from "@drift/runtime";
import { parseDepthCapMarkets, type DepthCapScope } from "@drift/strategies";
import { fastifyCookie as cookie } from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";

import { registerErrorHandler } from "./lib/http";
import type { Mailer } from "./lib/mailer";
import type { RecoClient } from "./lib/reco-client";
import { builderFeesOf, cachedMmFeeOf } from "./modules/account/builder-fees";
import { registerAccountRoutes } from "./modules/account/routes";
import { registerAuthRoutes } from "./modules/auth/routes";
import { registerBacktestRoutes } from "./modules/backtests/routes";
import { registerBotRoutes } from "./modules/bots/routes";
import {
  adaptiveDcaOn,
  aiDeskOn,
  listBots,
  signalResearchOn,
  volumeBotsOn,
} from "./modules/bots/service";
import { registerChartRoutes } from "./modules/chart/routes";
import { createChartService, type LiquidationProvider } from "./modules/chart/service";
import { registerCopyRoutes } from "./modules/copy/routes";
import { sodexVolume24h } from "./modules/copy/volume";
import { registerDataRoutes } from "./modules/data/routes";
import type { DeskLlm } from "./modules/desk/llm";
import { sodexMarketSource } from "./modules/desk/market";
import { registerDeskRoutes } from "./modules/desk/routes";
import { startTelegramBriefs } from "./modules/desk/telegram-brief";
import { registerMcpRoutes } from "./modules/mcp/routes";
import { registerNewsBotRoutes } from "./modules/news-signal-bots/routes";
import type { CimdDeps } from "./modules/oauth/cimd";
import { registerOauthRoutes } from "./modules/oauth/routes";
import { registerProfileRoutes } from "./modules/profile/routes";
import { registerPublicRoutes } from "./modules/public/routes";
import { registerRecoRoutes } from "./modules/reco/routes";
import { registerRewardsWatchRoutes } from "./modules/rewards-watch/routes";
import type { RewardsWatchDeps } from "./modules/rewards-watch/service";
import { rewardsVisibleTo } from "./modules/rewards-watch/visibility";
import { registerSignalAnalysisRoutes } from "./modules/signal-analysis/routes";
import { registerSignalResearchRoutes } from "./modules/signal-research/routes";
import { registerSodexRoutes } from "./modules/sodex/routes";
import type { SodexDeps } from "./modules/sodex/service";
import { registerSodexDebuggerRoutes } from "./modules/sodex-debugger/routes";
import { registerTelegramRoutes } from "./modules/telegram/routes";
import { registerUsMarketRoutes } from "./modules/us-market/routes";
import {
  createUsMarketService,
  type UsMarketRest,
  type WealthReader,
} from "./modules/us-market/service";
import { registerWealthWatchRoutes } from "./modules/wealth-watch/routes";
import { wealthAlertsVisibleTo, type WealthWatchSwitches } from "./modules/wealth-watch/visibility";
import { registerPlainDecimals } from "./plugins/plain-decimals";
import { registerRateLimit, type RateLimiter } from "./plugins/rate-limit";
import { registerSession } from "./plugins/session";

// Danh sách redact cố định (CODING_STANDARDS C11). Có test đảm bảo không lộ.
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  "*.privateKey",
  "*.secret",
  "*.signature",
  "*.apiKey",
  "*.seed",
  "*.mnemonic",
  "*.code",
  "*.twoFactorCode",
  // MCP (DEC-167): shared secret apps/mcp → api và token MCP của người dùng.
  'req.headers["x-mcp-introspect-secret"]',
  'req.headers["x-mcp-token"]',
  // #558 (DEC-398): JWT rewards trong body `POST /api/v1/rewards/watch`.
  "*.token",
  "*.accessToken",
];

/** Wealth reader khi tính năng tắt: mọi lời gọi trả `not_provided` (route đã 404 trước đó). */
const notProvided = () =>
  Promise.resolve({ kind: "not_provided" as const, reason: "network" as const });

export interface AppDeps {
  /** OAuth cho MCP (DEC-215). Thiếu = issuer mặc định, introspect tắt. */
  oauth?: {
    issuer: string;
    mcpPublicUrl: string;
    introspectSecret: string | null;
    /** Test: thay DNS / transport khi tải Client ID Metadata Document. */
    cimd?: CimdDeps;
  };
  db: Db;
  mailer: Mailer;
  totpKey: Buffer;
  cookieSecure: boolean;
  logLevel: string;
  now?: () => Date;
  /** Thay stream log trong test. */
  logStream?: NodeJS.WritableStream;
  sodex: Pick<
    SodexDeps,
    "rest" | "writer" | "signer" | "builderId" | "builderExempt" | "connectEnabled"
  >;
  /** Giá gần nhất (Redis `md:last:<market>`, do marketdata ghi). */
  lastPrice: (market: string) => Promise<{ price: string; at: number } | null>;
  reco: RecoClient;
  /** Giá gần nhất của nhiều market (Redis `md:last:*`). */
  prices: (markets: readonly string[]) => Promise<Record<string, string>>;
  /** #305: Redis `sr:markets` (danh sách perps SoDEX do scheduler ghi) cho Signal research; không có → null. */
  srMarkets?: () => Promise<string | null>;
  /**
   * #308: Redis `sr:quotes` (bid / ask SoDEX do scheduler ghi) cho lãi / lỗ chưa chốt của Signal research; không có →
   * null.
   */
  srQuotes?: () => Promise<string | null>;
  /** #394: Redis `sr:lane` (chu kỳ lane tin tức do scheduler ghi) cho Signal research; không có → null. */
  srLane?: () => Promise<string | null>;
  /**
   * #420: `SIGNAL_NEWS_BOTS_ENABLED`, chốt chặn bot `news_signal` mainnet (tạo / Start / Resume). Thiếu = tắt. Hàm để test
   * đổi được giữa chừng.
   */
  newsSignalBotsEnabled?: () => boolean;
  /** #547 / DEC-397: `REWARDS_ENABLED`, công tắc toàn hệ thống của SoDEX rewards. Thiếu = tắt. */
  rewardsEnabled?: () => boolean;
  /**
   * #558 (DEC-398): báo box mới SoDEX rewards. `enabled` = `REWARDS_WATCH_ENABLED`. Không truyền = tắt: mọi route
   * `/api/v1/rewards/watch` trả 404.
   */
  rewardsWatch?: { enabled: () => boolean } & Pick<
    RewardsWatchDeps,
    "audAllow" | "reader" | "signer"
  >;
  /**
   * #589 / DEC-402: US Market + SoDEX Wealth. `enabled` = `US_MARKET_ENABLED` (mặc định bật ở config). Không truyền = tắt:
   * `/api/v1/markets/us` và `/api/v1/wealth/me` trả 404, `/features.usMarket` = false. `rest` thiếu = `sodex.rest`.
   */
  usMarket?: { enabled: () => boolean; wealth: WealthReader; rest?: UsMarketRest };
  /** #594 / DEC-404: `WEALTH_WATCH_ENABLED` (cảnh báo SoDEX Wealth). Thiếu = tắt (team vẫn dùng được khi US Market bật). */
  wealthWatchEnabled?: () => boolean;
  /**
   * #590 (DEC-402 bổ sung 2026-11-28): market áp giới hạn theo sổ lệnh lúc tạo / sửa bot (`DEPTH_CAP_MARKETS`). Thiếu =
   * danh sách mặc định. Trả về web qua `/features.depthCapMarkets`.
   */
  depthCapMarkets?: DepthCapScope;
  rateLimiter: RateLimiter;
  /** Nhà cung cấp bản đồ thanh lý (IMP-05). Không có / null: tab Liquidation map ẩn. */
  liquidations?: LiquidationProvider | null;
  /** Ghi đè giới hạn (test). */
  rateLimits?: { perIp: number; perUser: number; windowMs: number };
  /** Copy Trading: ngưỡng USD cảnh báo big move; trống = tắt (DEC-163, OPEN_QUESTIONS 21a). */
  copyBigMoveMinUsd?: string | null;
  /** Kênh Telegram (DEC-170). Không truyền = tắt: mọi route `/api/v1/telegram/*` trả 404. */
  telegram?: {
    enabled: boolean;
    botUsername: string;
    webhookSecret: string | null;
    appUrl: string;
    botApi: BotApi;
  };
  /** Desk AI (DEC-165): null = LLM tắt, trả lời bằng câu mẫu. */
  deskLlm?: DeskLlm | null;
  /** Morning brief qua Telegram (N4). Không truyền = tắt (test). */
  telegramBrief?: { enabled: boolean; useLlm: boolean; everyMs?: number };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const now = deps.now ?? (() => new Date());
  const app = Fastify({
    logger: {
      level: deps.logLevel,
      base: { service: "api" },
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      ...(deps.logStream === undefined ? {} : { stream: deps.logStream }),
    },
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });
  await app.register(cookie);
  registerErrorHandler(app);
  registerPlainDecimals(app);
  app.get("/healthz", () => ({ status: "ok" }));
  registerSession(app, { db: deps.db, cookieSecure: deps.cookieSecure, now });
  registerRateLimit(app, deps.rateLimiter, deps.rateLimits);
  registerAuthRoutes(app, {
    deps: { db: deps.db, mailer: deps.mailer, totpKey: deps.totpKey, now },
    cookieSecure: deps.cookieSecure,
  });
  registerDataRoutes(app, { db: deps.db, now });
  // Tính năng của người đang đăng nhập: bot khối lượng do admin bật ở Users (DEC-80). Chưa đăng nhập → tắt.
  const depthCapMarkets = deps.depthCapMarkets ?? parseDepthCapMarkets(undefined);
  const wealthSwitches: WealthWatchSwitches = {
    usMarket: deps.usMarket?.enabled ?? (() => false),
    enabled: deps.wealthWatchEnabled ?? (() => false),
  };
  app.get("/api/v1/features", async (request) => {
    const on = request.auth === null ? false : await volumeBotsOn(deps.db, request.auth.userId);
    const desk = request.auth === null ? false : await aiDeskOn(deps.db, request.auth.userId);
    const adca = request.auth === null ? false : await adaptiveDcaOn(deps.db, request.auth.userId);
    const sr = request.auth === null ? false : await signalResearchOn(deps.db, request.auth.userId);
    // Builder fee hiệu lực của user (DEC-159); chưa đăng nhập → bảng mặc định.
    const builderFees =
      request.auth === null ? {} : await builderFeesOf(deps.db, request.auth.userId);
    // Thẻ builder fee Market Making (DEC-261): cache ~2 phút theo user; tắt bot khối lượng → null, không truy vấn.
    const mmFee =
      request.auth === null || !on
        ? null
        : await cachedMmFeeOf(deps.db, request.auth.userId, now());
    return {
      volumeMaker: on,
      volumeFarm: on,
      aiDesk: desk,
      adaptiveDca: adca,
      signalResearch: sr,
      // DEC-397: công tắc toàn hệ thống (`REWARDS_ENABLED`), giống nhau cho mọi user; không phải cờ theo tài khoản.
      // Bổ sung #551: công tắc tắt thì role team vẫn thấy (thử bằng ví thật trên prod, như Signal Research).
      sodexRewards: await rewardsVisibleTo(
        deps.db,
        deps.rewardsEnabled,
        request.auth === null ? null : request.auth.userId,
      ),
      // #589 / DEC-402 mục 9: công tắc toàn hệ thống `US_MARKET_ENABLED`.
      usMarket: deps.usMarket?.enabled() ?? false,
      // #594 / DEC-404: công tắc "Alerts" ở My Wealth (US Market bật và `WEALTH_WATCH_ENABLED` hoặc role team).
      wealthAlerts: await wealthAlertsVisibleTo(
        deps.db,
        wealthSwitches,
        request.auth === null ? null : request.auth.userId,
      ),
      // #590: market đang áp giới hạn theo sổ lệnh (`DEPTH_CAP_MARKETS`); `["*"]` = mọi market, `[]` = tắt.
      depthCapMarkets: depthCapMarkets.all ? ["*"] : [...depthCapMarkets.markets],
      builderFees,
      mmFee,
    };
  });
  const newsBotsEnabled = deps.newsSignalBotsEnabled ?? (() => false);
  registerBotRoutes(app, {
    db: deps.db,
    totpKey: deps.totpKey,
    now,
    rest: deps.sodex.rest,
    builderId: deps.sodex.builderId,
    builderExempt: deps.sodex.builderExempt,
    lastPrice: deps.lastPrice,
    prices: deps.prices,
    verifyApiKey: (id: string) => deps.sodex.signer.verifyApiKey(id),
    depthCapMarkets,
    newsBotsEnabled,
  });
  const chart = createChartService({
    rest: deps.sodex.rest,
    liquidations: deps.liquidations ?? null,
    now,
  });
  registerChartRoutes(app, chart);
  registerPublicRoutes(app, { db: deps.db, now });
  registerBacktestRoutes(app, { db: deps.db, now });
  registerProfileRoutes(app, {
    db: deps.db,
    totpKey: deps.totpKey,
    now,
    cookieSecure: deps.cookieSecure,
  });
  const botDeps = {
    db: deps.db,
    totpKey: deps.totpKey,
    now,
    rest: deps.sodex.rest,
    builderId: deps.sodex.builderId,
    builderExempt: deps.sodex.builderExempt,
    lastPrice: deps.lastPrice,
    prices: deps.prices,
    verifyApiKey: (id: string) => deps.sodex.signer.verifyApiKey(id),
    depthCapMarkets,
  };
  const accountDeps = {
    db: deps.db,
    totpKey: deps.totpKey,
    now,
    rest: deps.sodex.rest,
    prices: deps.prices,
    bots: botDeps,
    builderId: deps.sodex.builderId,
    builderExempt: deps.sodex.builderExempt,
    // #558: nhóm thông báo SoDEX rewards chỉ với user thấy Rewards (cùng điều kiện với /features.sodexRewards).
    rewardsVisible: (userId: string) => rewardsVisibleTo(deps.db, deps.rewardsEnabled, userId),
    // #594: nhóm thông báo SoDEX Wealth chỉ với user dùng được cảnh báo Wealth (cùng điều kiện với /features).
    wealthVisible: (userId: string) => wealthAlertsVisibleTo(deps.db, wealthSwitches, userId),
  };
  registerAccountRoutes(app, accountDeps);
  const recoDeps = { db: deps.db, reco: deps.reco, rest: deps.sodex.rest, now };
  registerRecoRoutes(app, recoDeps);
  registerDeskRoutes(app, {
    bots: botDeps,
    reco: recoDeps,
    llm: deps.deskLlm ?? null,
    market: sodexMarketSource({ rest: deps.sodex.rest, prices: deps.prices, now }),
  });
  const copyDeps = {
    bots: botDeps,
    bigMoveMinUsd: deps.copyBigMoveMinUsd ?? null,
    volume24h: sodexVolume24h(deps.sodex.rest, now),
  };
  registerCopyRoutes(app, copyDeps);
  registerSodexRoutes(app, { ...deps.sodex, db: deps.db, totpKey: deps.totpKey, now });
  registerSodexDebuggerRoutes(app, { db: deps.db, now, builderId: deps.sodex.builderId });
  registerSignalAnalysisRoutes(app, { db: deps.db, now });
  registerNewsBotRoutes(app, { ...botDeps, newsBotsEnabled });
  registerSignalResearchRoutes(app, {
    db: deps.db,
    now,
    srQuotes: deps.srQuotes ?? (() => Promise.resolve(null)),
    srMarkets: deps.srMarkets ?? (() => Promise.resolve(null)),
    srLane: deps.srLane ?? (() => Promise.resolve(null)),
  });
  const oauth = deps.oauth ?? {
    issuer: "https://desklabs.xyz",
    mcpPublicUrl: "https://mcp.desklabs.xyz",
    introspectSecret: null,
  };
  const mcpBase = oauth.mcpPublicUrl.replace(/\/+$/, "");
  const oauthDeps = {
    db: deps.db,
    now,
    issuer: oauth.issuer.replace(/\/+$/, ""),
    resources: [`${mcpBase}/mcp`, `${mcpBase}/team/mcp`],
    ...(oauth.cimd === undefined ? {} : { cimd: oauth.cimd }),
  };
  registerOauthRoutes(app, {
    deps: oauthDeps,
    rateLimiter: deps.rateLimiter,
    introspectSecret: oauth.introspectSecret,
  });
  registerMcpRoutes(app, {
    db: deps.db,
    now,
    appUrl: oauthDeps.issuer,
    account: accountDeps,
    copy: copyDeps,
    oauth: oauthDeps,
    introspectSecret: oauth.introspectSecret,
    resources: { user: `${mcpBase}/mcp`, team: `${mcpBase}/team/mcp` },
  });
  const um = deps.usMarket;
  registerUsMarketRoutes(app, {
    enabled: um?.enabled ?? (() => false),
    service: createUsMarketService({
      db: deps.db,
      now,
      rest: um?.rest ?? deps.sodex.rest,
      wealth: um?.wealth ?? {
        getFunds: notProvided,
        getTradingStatus: notProvided,
        getPositions: notProvided,
        getPnl: notProvided,
        getInFlight: notProvided,
        getFundDetails: notProvided,
        getRecurringBuys: notProvided,
        getPnlHistory: notProvided,
      },
      log: {
        warn: (obj, msg) => {
          app.log.warn(obj, msg);
        },
      },
    }),
  });
  registerWealthWatchRoutes(app, { db: deps.db, now, switches: wealthSwitches });
  const rw = deps.rewardsWatch;
  registerRewardsWatchRoutes(app, {
    enabled: rw?.enabled ?? (() => false),
    deps: {
      db: deps.db,
      now,
      audAllow: rw?.audAllow ?? (() => []),
      reader: rw?.reader ?? {
        getSopointsSummary: () => Promise.resolve({ kind: "error", code: "network" }),
      },
      signer: rw?.signer ?? { encrypt: () => Promise.resolve({ failure: "network" as const }) },
    },
  });
  const tg = deps.telegram;
  registerTelegramRoutes(app, {
    enabled: tg?.enabled ?? false,
    webhookSecret: tg?.webhookSecret ?? null,
    deps: {
      db: deps.db,
      now,
      botUsername: tg?.botUsername ?? "desklabsbot",
      appUrl: tg?.appUrl ?? "https://desklabs.xyz",
      botApi: tg?.botApi ?? { sendMessage: () => Promise.resolve({ ok: true }) },
      rateLimiter: deps.rateLimiter,
      listBots: (userId) => listBots(botDeps, userId),
      warn: (msg, data) => {
        app.log.warn(data, msg);
      },
    },
  });
  const brief = deps.telegramBrief;
  if (brief?.enabled === true && tg?.enabled === true) {
    let stop: (() => void) | null = null;
    app.addHook("onReady", () => {
      stop = startTelegramBriefs(
        { ...botDeps, llm: deps.deskLlm ?? null, useLlm: brief.useLlm },
        app.log,
        brief.everyMs,
      );
      return Promise.resolve();
    });
    app.addHook("onClose", () => {
      stop?.();
      return Promise.resolve();
    });
  }
  return app;
}
