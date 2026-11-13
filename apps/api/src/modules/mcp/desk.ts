import {
  MCP_NOT_FORECAST,
  type McpGetWhatIf,
  type McpNeedsYou,
  type McpTrackRecord,
  type WhatIfView,
} from "@drift/shared";

import { aiDeskOn } from "../bots/service";
import { recordView } from "../desk/record";
import { deskHome, whatifView } from "../desk/whatif";

import type { UserToolDeps } from "./user";

// Tool AI Desk cho người dùng (docs/MCP.md mục 5B, DEC-221). Cùng service với màn AI Desk: trang chủ
// (`/api/v1/desk/home`), so sánh (`/api/v1/desk/whatifs/:id`), thành tích (`/api/v1/desk/record`). Chỉ đọc: không
// bắt đầu so sánh, không Apply, không Switch back. Kết quả là 7 ngày đã qua, không phải dự báo (`notForecast`).

const meta = (deps: UserToolDeps, source: string) => ({
  asOf: deps.account.now().toISOString(),
  source,
  notForecast: MCP_NOT_FORECAST,
});

const gate = (deps: UserToolDeps, userId: string) => aiDeskOn(deps.account.db, userId);

const whatif = (w: WhatIfView) => ({ ...w, bot: { ...w.bot, name: { userText: w.bot.name } } });

export async function mcpNeedsYou(deps: UserToolDeps, userId: string): Promise<McpNeedsYou> {
  const m = meta(deps, "AI Desk home (/api/v1/desk/home)");
  if (!(await gate(deps, userId))) return { ...m, needsYou: null, reason: "ai_desk_not_enabled" };
  const h = await deskHome(deps.account.bots, userId);
  return {
    ...m,
    needsYou: {
      ...h,
      items: h.items.map((i) => ({
        ...i,
        botName: { userText: i.botName },
        whatif: i.whatif === null ? null : whatif(i.whatif),
      })),
      bots: h.bots.map((b) => ({ ...b, name: { userText: b.name } })),
    },
    reason: null,
  };
}

export async function mcpGetWhatIf(
  deps: UserToolDeps,
  userId: string,
  id: string,
): Promise<McpGetWhatIf> {
  const m = meta(deps, "AI Desk comparison (/api/v1/desk/whatifs/:id)");
  if (!(await gate(deps, userId))) return { ...m, whatif: null, reason: "ai_desk_not_enabled" };
  // `whatifView` lọc theo userId: so sánh của người khác → 404 như không tồn tại.
  return { ...m, whatif: whatif(await whatifView(deps.account.bots, userId, id)), reason: null };
}

export async function mcpTrackRecord(deps: UserToolDeps, userId: string): Promise<McpTrackRecord> {
  const m = meta(deps, "AI Desk track record (/api/v1/desk/record)");
  if (!(await gate(deps, userId))) return { ...m, record: null, reason: "ai_desk_not_enabled" };
  const r = await recordView(deps.account.bots, userId);
  return {
    ...m,
    record: { ...r, rows: r.rows.map((x) => ({ ...x, botName: { userText: x.botName } })) },
    reason: null,
  };
}
