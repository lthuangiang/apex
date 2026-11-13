import {
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

import { parseOrThrow } from "../../lib/http";

import { requireMcpCaller, type McpAuthDeps } from "./auth";
import {
  teamBotTimeline,
  teamBuilderRevenue,
  teamConnectAttempts,
  teamFindUser,
  teamUnknownOrders,
  teamUserBots,
  type TeamDeps,
} from "./team";

// Route nội bộ apps/mcp → api cho tool MCP (DEC-TBD-mcp-team-tools). Chỉ GET, chỉ đọc. Mỗi request tự kiểm tra shared
// secret + token MCP (`requireMcpCaller`). Traefik chặn `/api/v1/mcp/` từ ngoài; api vẫn tự kiểm tra (phòng thủ hai lớp).

export const MCP_TEAM_PREFIX = "/api/v1/mcp/team";

export function registerMcpRoutes(app: FastifyInstance, deps: McpAuthDeps & TeamDeps): void {
  const team = deps;
  app.get(`${MCP_TEAM_PREFIX}/users`, async (request) => {
    await requireMcpCaller(deps, request, "team");
    const q = parseOrThrow(teamFindUserInputSchema, request.query);
    return teamFindUser(team, q.query);
  });

  app.get(`${MCP_TEAM_PREFIX}/connect-attempts`, async (request) => {
    await requireMcpCaller(deps, request, "team");
    const q = parseOrThrow(teamConnectAttemptsInputSchema, request.query);
    return teamConnectAttempts(team, q);
  });

  app.get(`${MCP_TEAM_PREFIX}/users/:userId/bots`, async (request) => {
    await requireMcpCaller(deps, request, "team");
    const p = parseOrThrow(teamUserBotsInputSchema, request.params);
    return teamUserBots(team, p.userId);
  });

  app.get(`${MCP_TEAM_PREFIX}/bots/:botId/timeline`, async (request) => {
    await requireMcpCaller(deps, request, "team");
    const p = parseOrThrow(z.object({ botId: uuidSchema }), request.params);
    const q = parseOrThrow(teamBotTimelineInputSchema.omit({ botId: true }), request.query);
    return teamBotTimeline(team, { ...q, botId: p.botId });
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
