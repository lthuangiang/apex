import {
  mcpBotDecisionsInputSchema,
  mcpDraftChangeInputSchema,
  mcpDraftNewInputSchema,
  mcpGetWhatIfInputSchema,
  mcpFindTradersInputSchema,
  mcpGetTraderInputSchema,
  mcpListBotsInputSchema,
  mcpPortfolioInputSchema,
  teamBotTimelineInputSchema,
  teamBuilderRevenueInputSchema,
  teamConnectAttemptsInputSchema,
  teamFindUserInputSchema,
  teamUnknownOrdersInputSchema,
  teamUserBotsInputSchema,
  uuidSchema,
} from "@drift/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { audit, AuditAction } from "../../lib/audit";
import { parseOrThrow } from "../../lib/http";
import { requireAuth } from "../../plugins/session";

import { requireMcpCaller, type McpAuthDeps, type McpCaller } from "./auth";
import { mcpGetWhatIf, mcpNeedsYou, mcpTrackRecord } from "./desk";
import { draftBotChange, draftNewBot, endRefresh, openDraft } from "./drafts";
import {
  teamBotTimeline,
  teamBuilderRevenue,
  teamConnectAttempts,
  teamFindUser,
  teamUnknownOrders,
  teamUserBots,
  type TeamDeps,
} from "./team";
import {
  mcpBotDecisions,
  mcpFindTraders,
  mcpGetBot,
  mcpGetTrader,
  mcpListBots,
  mcpPortfolioSummary,
  mcpRiskStatus,
  type UserToolDeps,
} from "./user";

// Route nội bộ apps/mcp → api cho tool MCP (DEC-219). Chỉ GET, chỉ đọc. Mỗi request tự kiểm tra shared
// secret + token MCP (`requireMcpCaller`). Traefik chặn `/api/v1/mcp/` từ ngoài; api vẫn tự kiểm tra (phòng thủ hai lớp).

export const MCP_TEAM_PREFIX = "/api/v1/mcp/team";
export const MCP_USER_PREFIX = "/api/v1/mcp/me";

export function registerMcpRoutes(
  app: FastifyInstance,
  deps: McpAuthDeps & TeamDeps & UserToolDeps & { appUrl: string },
): void {
  registerMcpUserRoutes(app, deps);
  registerDraftRoutes(app, deps);
  const team = deps;
  /** Review #75: mỗi lần team xem dữ liệu một user qua MCP → audit (target = user, kèm tool và tokenId). */
  const viewed = async (
    caller: McpCaller,
    tool: string,
    targets: readonly string[],
    extra: Record<string, unknown> = {},
  ) => {
    for (const target of new Set(targets))
      await audit(deps.db, {
        userId: caller.userId,
        action: AuditAction.mcpTeamUserViewed,
        target,
        metadata: { tool, tokenId: caller.tokenId, ...extra },
        ip: null,
      });
  };

  app.get(`${MCP_TEAM_PREFIX}/users`, async (request) => {
    const caller = await requireMcpCaller(deps, request, "team");
    const q = parseOrThrow(teamFindUserInputSchema, request.query);
    const res = await teamFindUser(team, q.query);
    await viewed(
      caller,
      "team_find_user",
      res.users.map((u) => u.id),
    );
    return res;
  });

  app.get(`${MCP_TEAM_PREFIX}/connect-attempts`, async (request) => {
    const caller = await requireMcpCaller(deps, request, "team");
    const q = parseOrThrow(teamConnectAttemptsInputSchema, request.query);
    const res = await teamConnectAttempts(team, q);
    await viewed(
      caller,
      "team_connect_attempts",
      q.userId !== undefined ? [q.userId] : res.attempts.map((a) => a.userId),
    );
    return res;
  });

  app.get(`${MCP_TEAM_PREFIX}/users/:userId/bots`, async (request) => {
    const caller = await requireMcpCaller(deps, request, "team");
    const p = parseOrThrow(teamUserBotsInputSchema, request.params);
    const res = await teamUserBots(team, p.userId);
    await viewed(caller, "team_user_bots", [p.userId]);
    return res;
  });

  app.get(`${MCP_TEAM_PREFIX}/bots/:botId/timeline`, async (request) => {
    const caller = await requireMcpCaller(deps, request, "team");
    const p = parseOrThrow(z.object({ botId: uuidSchema }), request.params);
    const q = parseOrThrow(teamBotTimelineInputSchema.omit({ botId: true }), request.query);
    const res = await teamBotTimeline(team, { ...q, botId: p.botId });
    await viewed(caller, "team_bot_timeline", [res.bot.userId], { botId: p.botId });
    return res;
  });

  app.get(`${MCP_TEAM_PREFIX}/unknown-orders`, async (request) => {
    await requireMcpCaller(deps, request, "team");
    const q = parseOrThrow(teamUnknownOrdersInputSchema, request.query);
    return teamUnknownOrders(team, q);
  });

  app.get(`${MCP_TEAM_PREFIX}/builder-revenue`, async (request) => {
    await requireMcpCaller(deps, request, "team");
    const q = parseOrThrow(teamBuilderRevenueInputSchema, request.query);
    return teamBuilderRevenue(team, q);
  });
}

/**
 * Tool đọc cho người dùng (B1, DEC-220): endpoint `/mcp`, scope `read`. `userId` luôn lấy từ token,
 * không bao giờ từ tham số; bot của người khác → 404.
 */
function registerMcpUserRoutes(app: FastifyInstance, deps: McpAuthDeps & UserToolDeps): void {
  const me = async (request: Parameters<typeof requireMcpCaller>[1]) =>
    (await requireMcpCaller(deps, request, "user")).userId;
  const botParams = z.object({ botId: uuidSchema });

  app.get(`${MCP_USER_PREFIX}/portfolio`, async (request) => {
    const userId = await me(request);
    const q = parseOrThrow(mcpPortfolioInputSchema, request.query);
    return mcpPortfolioSummary(deps, userId, q.period);
  });

  app.get(`${MCP_USER_PREFIX}/risk`, async (request) => mcpRiskStatus(deps, await me(request)));

  app.get(`${MCP_USER_PREFIX}/bots`, async (request) => {
    const userId = await me(request);
    const q = parseOrThrow(mcpListBotsInputSchema, request.query);
    return mcpListBots(deps, userId, q.archived === "true");
  });

  app.get(`${MCP_USER_PREFIX}/bots/:botId`, async (request) => {
    const userId = await me(request);
    const p = parseOrThrow(botParams, request.params);
    return mcpGetBot(deps, userId, p.botId);
  });

  app.get(`${MCP_USER_PREFIX}/bots/:botId/decisions`, async (request) => {
    const userId = await me(request);
    const p = parseOrThrow(botParams, request.params);
    const q = parseOrThrow(mcpBotDecisionsInputSchema.omit({ botId: true }), request.query);
    return mcpBotDecisions(deps, userId, { ...q, botId: p.botId });
  });

  app.get(`${MCP_USER_PREFIX}/traders`, async (request) => {
    const userId = await me(request);
    const q = parseOrThrow(mcpFindTradersInputSchema, request.query);
    return mcpFindTraders(deps, userId, q.tab);
  });

  // B2 (DEC-221): AI Desk, chỉ đọc.
  app.get(`${MCP_USER_PREFIX}/desk/needs-you`, async (request) =>
    mcpNeedsYou(deps, await me(request)),
  );

  app.get(`${MCP_USER_PREFIX}/desk/whatifs/:whatifId`, async (request) => {
    const userId = await me(request);
    const p = parseOrThrow(mcpGetWhatIfInputSchema, request.params);
    return mcpGetWhatIf(deps, userId, p.whatifId);
  });

  app.get(`${MCP_USER_PREFIX}/desk/record`, async (request) =>
    mcpTrackRecord(deps, await me(request)),
  );

  app.get(`${MCP_USER_PREFIX}/traders/:address`, async (request) => {
    const userId = await me(request);
    const p = parseOrThrow(mcpGetTraderInputSchema, request.params);
    return mcpGetTrader(deps, userId, p.address);
  });
}

/**
 * Bản nháp từ Claude (B3, DEC-TBD-mcp-drafts). Route MCP cần scope `draft`; chỉ ghi `bot_drafts`, không bao giờ tạo bot,
 * thêm version hay Start. Web đọc bản nháp bằng phiên đăng nhập để điền sẵn màn Create / Edit.
 */
function registerDraftRoutes(
  app: FastifyInstance,
  deps: McpAuthDeps & UserToolDeps & TeamDeps & { appUrl: string },
): void {
  const drafts = { bots: deps.account.bots, appUrl: deps.appUrl };

  app.post(`${MCP_USER_PREFIX}/drafts/new`, async (request) => {
    const caller = await requireMcpCaller(deps, request, "user", "draft");
    const body = parseOrThrow(mcpDraftNewInputSchema, request.body);
    return draftNewBot(drafts, caller, body);
  });

  app.post(`${MCP_USER_PREFIX}/drafts/change`, async (request) => {
    const caller = await requireMcpCaller(deps, request, "user", "draft");
    const body = parseOrThrow(mcpDraftChangeInputSchema, request.body);
    return draftBotChange(drafts, caller, body);
  });

  // Step-up (PM chốt C): apps/mcp gọi khi token thiếu `draft` mà client gọi tool bản nháp. Refresh của family cũ hết
  // hạn ngay (access token còn dùng tới khi hết 1 giờ): SDK nhận invalid_grant khi refresh, xoá token và chạy lại OAuth
  // với scope "read draft" (màn consent), thay vì refresh ra token cũ chỉ có `read`.
  app.post("/api/v1/mcp/step-up", async (request, reply) => {
    const caller = await requireMcpCaller(deps, request, "user");
    await endRefresh(deps.db, caller.tokenId, deps.now());
    return reply.status(204).send();
  });

  app.get("/api/v1/drafts/:id", async (request) => {
    const { userId } = requireAuth(request);
    const { id } = parseOrThrow(z.object({ id: uuidSchema }), request.params);
    return openDraft(drafts, userId, id);
  });
}
