import {
  type BotSummary,
  type McpBotDecisions,
  type McpBotSummary,
  type McpFindTraders,
  type McpGetBot,
  type McpGetTrader,
  type McpListBots,
  type McpPortfolioSummary,
  type McpRiskStatus,
  type TraderList,
  type TraderProfile,
  type TraderTab,
} from "@drift/shared";

import { overview, risk, type AccountDeps } from "../account/service";
import { aiDeskOn, botDetail, listBots } from "../bots/service";
import { listTraders, traderProfile, type CopyDeps } from "../copy/service";

import { ownBotOr404 } from "./auth";
import { botTimeline, type TimelineInput } from "./team";

// Tool đọc cho người dùng (docs/MCP.md mục 5B, DEC-220). Mọi hàm nhận `userId` của token (api đã tự
// introspect) và chỉ đọc dữ liệu của người đó, qua đúng service mà màn hình đang dùng để số khớp. Thiếu dữ liệu →
// null kèm lý do, không bao giờ 0 (quy tắc 1.8). Chữ do người khác nhập (tên bot, tên trader) → `userText`.

export interface UserToolDeps {
  account: AccountDeps;
  copy: CopyDeps;
}

const PAPER_NOTE =
  "Paper bots use fake money inside DeskLabs. They are never sent to SoDEX and are not included in real-money numbers.";

const meta = (deps: UserToolDeps, source: string) => ({
  asOf: deps.account.now().toISOString(),
  source,
});

export const mcpBot = (b: BotSummary): McpBotSummary => ({ ...b, name: { userText: b.name } });

export async function mcpPortfolioSummary(
  deps: UserToolDeps,
  userId: string,
  period: "1" | "7" | "30" | "all",
): Promise<McpPortfolioSummary> {
  const o = await overview(deps.account, userId, period === "all" ? null : Number(period));
  const bots = await listBots(deps.account.bots, userId);
  return {
    ...meta(deps, "Overview (/api/v1/overview), Strategy Lab (/api/v1/bots)"),
    period,
    realMoney: {
      portfolio: o.portfolio,
      reason: o.portfolio === null ? "sodex_not_connected" : null,
      realizedPnl: o.realizedPnl,
      realizedSince: new Date(o.realizedSince).toISOString(),
      bots: bots.filter((b) => b.mode === "live").map(mcpBot),
    },
    paper: { note: PAPER_NOTE, bots: bots.filter((b) => b.mode === "paper").map(mcpBot) },
  };
}

export async function mcpRiskStatus(deps: UserToolDeps, userId: string): Promise<McpRiskStatus> {
  const r = await risk(deps.account, userId);
  return {
    ...meta(deps, "Risk (/api/v1/risk)"),
    risk: r,
    reason: r === null ? "sodex_not_connected" : null,
  };
}

export async function mcpListBots(
  deps: UserToolDeps,
  userId: string,
  archived: boolean,
): Promise<McpListBots> {
  const bots = await listBots(deps.account.bots, userId, archived);
  return { ...meta(deps, "Strategy Lab (/api/v1/bots)"), bots: bots.map(mcpBot) };
}

export async function mcpGetBot(
  deps: UserToolDeps,
  userId: string,
  botId: string,
): Promise<McpGetBot> {
  // Kiểm tra quyền trước: bot của người khác → 404 như bot không tồn tại.
  await ownBotOr404(deps.account.db, userId, botId);
  const d = await botDetail(deps.account.bots, userId, botId);
  const active = d.versions.find((v) => v.status === "active");
  const pending = d.versions.find((v) => v.status === "pending");
  return {
    ...meta(deps, "Trading Agent (/api/v1/bots/:id)"),
    bot: mcpBot(d.bot),
    activeConfig:
      active === undefined
        ? null
        : {
            version: active.version,
            config: active.config,
            paramSource: active.paramSource,
            appliedAt: active.appliedAt,
          },
    configReason: active === undefined ? "no_active_version" : null,
    pendingVersion: pending?.version ?? null,
    openOrders: d.openOrders,
    runningSince: d.runningSince,
    volumeMaker: d.volumeMaker,
    volumeFarm: d.volumeFarm,
    adaptiveDca: d.adaptiveDca,
  };
}

export async function mcpBotDecisions(
  deps: UserToolDeps,
  userId: string,
  input: TimelineInput,
): Promise<McpBotDecisions> {
  const bot = await ownBotOr404(deps.account.db, userId, input.botId);
  const res = await botTimeline({ db: deps.account.db, now: deps.account.now }, bot, input);
  return { ...res, source: "Trading Agent decisions and orders (bot_events, orders)" };
}

/** Bỏ đường cong (nặng); tên hiển thị của Hyperliquid là chữ người khác đặt → `userText`. */
const traderCard = (c: TraderList["items"][number]) => ({
  address: c.address,
  stats: c.stats,
  tags: c.tags,
  slot: c.slot,
  following: c.following,
  displayName: c.displayName === null ? null : { userText: c.displayName },
});

/** Copy Trading cần AI Desk (DEC-163): chưa bật → null + lý do, không phải lỗi. */
async function deskGated<T>(deps: UserToolDeps, userId: string, work: () => Promise<T>) {
  return (await aiDeskOn(deps.account.db, userId)) ? work() : null;
}

export async function mcpFindTraders(
  deps: UserToolDeps,
  userId: string,
  tab: TraderTab,
): Promise<McpFindTraders> {
  const list = await deskGated(deps, userId, () => listTraders(deps.copy, userId, tab));
  return {
    ...meta(deps, "Copy Trading › Find traders (/api/v1/traders)"),
    traders: list === null ? null : { ...list, items: list.items.map(traderCard) },
    reason: list === null ? "copy_trading_not_enabled" : null,
  };
}

export async function mcpGetTrader(
  deps: UserToolDeps,
  userId: string,
  address: string,
): Promise<McpGetTrader> {
  const p: TraderProfile | null = await deskGated(deps, userId, () =>
    traderProfile(deps.copy, userId, address),
  );
  return {
    ...meta(deps, "Copy Trading › Trader (/api/v1/traders/:address)"),
    trader: p === null ? null : { ...p, card: traderCard(p.card) },
    reason: p === null ? "copy_trading_not_enabled" : null,
  };
}
