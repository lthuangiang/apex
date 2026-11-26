import {
  escapeTelegramHtml,
  feeTierChangeText,
  groupOf,
  rewardsBoxReceivedDataSchema,
  rewardsClaimableDataSchema,
  rewardsDrawWonDataSchema,
  TEAM_INCIDENT_KINDS,
  TEAM_INCIDENT_SEVERITY,
  type NotificationType,
  type RewardsNotificationType,
  type TeamIncidentKind,
} from "@drift/shared";

import messages from "./messages/en.json" with { type: "json" };
import { isPlannedStop, type StoppedRun } from "./stopped-run";
import { plannedStopBody, plannedStopReason } from "./stopped-run-render";

// Nội dung tin Telegram (docs/NOTIFICATIONS.md mục 5, artboard NT-Telegram): tiêu đề một dòng có emoji theo
// nhóm, 1–2 câu, rồi một URL button mở đúng màn hình. Hàm thuần, không I/O.
// - Chuỗi không do DeskLabs viết (tên bot, market) luôn được escape.
// - Không bao giờ có địa chỉ ví, key, secret, link đăng nhập. Payload hiện có không mang số USDC, nên không có
//   câu số tiền (mục 5: thiếu dữ liệu thì bỏ câu có số).

const M = messages.telegram;
const REASONS: Record<string, string> = messages.reasons;
const STRATEGIES: Record<string, string> = messages.strategies;
const COPY_SKIP: Record<string, string> = messages.copySkip;
const INC = M.incident;
const INC_KINDS: Record<string, string> = INC.kinds;
const INC_SEVERITY: Record<string, string> = INC.severity;

/**
 * Coin của market ("BTC-USD" → "BTC"). Tin bot copy (DEC-212) không dùng tên bot: tên mặc định của bot
 * copy chứa địa chỉ ví rút gọn của trader (mục 5 cấm), nên tiêu đề ghi "Your copy bot".
 */
const coinOf = (market: string | null): string | null =>
  market === null ? null : escapeTelegramHtml(market.split("-")[0] ?? market);

export interface RenderRow {
  type: NotificationType;
  data: Record<string, unknown>;
  /** Tên bot do user đặt (chưa escape); null khi không có bot hoặc không tìm thấy. */
  botName: string | null;
  /** `bot_stopped` dừng đúng kế hoạch (#566): số liệu phiên do worker đọc lúc dựng tin; null/thiếu = không có số. */
  run?: StoppedRun | null;
}

export interface Rendered {
  text: string;
  button: { text: string; url: string };
}

/** Điền `{key}` trong mẫu. Giá trị phải được escape trước khi truyền vào. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * Morning brief (N4): lời Desk AI đã qua kiểm tra số, hoặc câu mẫu chép từ web `desk.ai.templates.brief`. Tên bot và lời
 * LLM là dữ liệu nên luôn escape. Payload cũ (không có lời / số việc) → câu cố định.
 */
function briefBody(data: Record<string, unknown>): string {
  const text = str(data.text);
  if (text !== null) return escapeTelegramHtml(text);
  const count = typeof data.count === "number" ? data.count : null;
  if (count === null) return M.bodies.daily_summary;
  // Việc đầu là việc cấp account (DEC-272): gọi theo việc, không có tên bot.
  const bot = data.first === "goal" ? M.goalLimit : escapeTelegramHtml(str(data.bot) ?? M.aBot);
  if (count === 0) return M.bodies.briefNone;
  return count === 1 ? fill(M.bodies.briefOne, { bot }) : fill(M.bodies.briefMany, { count, bot });
}
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Tin bậc builder fee đổi (DEC-261, câu duyệt 2026-11-16). Volume làm tròn xuống (không bao giờ ghi cao hơn
 * thật); thiếu số thì chỉ câu mức mới / cũ. Payload sai dạng → tiêu đề chung, không có câu (không đoán số).
 */
export function feeTierMessage(data: Record<string, unknown>): {
  title: string;
  body: string | null;
} {
  const x = feeTierChangeText(data);
  if (x === null) return { title: M.titles.key_fee, body: null };
  const usdc = (amount: string | null) => (amount === null ? "" : fill(M.bodies.usdc, { amount }));
  const vars = {
    rate: x.vars.rate,
    previous: x.vars.previous,
    volume: usdc(x.vars.volume),
    min: usdc(x.vars.min),
  };
  return {
    title: fill(x.title === "lowered" ? M.titles.fee_tier_lowered : M.titles.fee_tier_back, vars),
    body: fill(
      x.body === "lowered"
        ? M.bodies.fee_tier_lowered
        : x.body === "raised"
          ? M.bodies.fee_tier_raised
          : M.bodies.fee_tier_rates,
      vars,
    ),
  };
}

function reasonOf(data: Record<string, unknown>): string | null {
  const code = str(data.reasonCode);
  return code === null ? null : (REASONS[code] ?? null);
}

function botOf(row: RenderRow): string {
  return escapeTelegramHtml(row.botName ?? M.aBot);
}

/** Đường dẫn trong app (không chứa token đăng nhập). Bot tiền giả chỉ xem được ở AI Desk (DEC-105). */
function targetOf(row: RenderRow): { path: string; label: string } {
  const botId = str(row.data.botId);
  const agent = botId === null ? "/agent" : `/agent/${encodeURIComponent(botId)}`;
  const paper = row.data.paper === true;
  switch (row.type) {
    case "bot_paused":
    case "bot_stopped":
      // Dừng đúng kế hoạch (#566, mẫu đã duyệt): nút "Open Trading Agent".
      if (row.type === "bot_stopped" && isPlannedStop(row.data))
        return { path: agent, label: M.buttons.agent };
      return paper
        ? { path: "/desk", label: M.buttons.desk }
        : { path: agent, label: M.buttons.review };
    case "unknown_order":
    case "fill":
      return paper
        ? { path: "/desk", label: M.buttons.desk }
        : { path: agent, label: M.buttons.agent };
    case "risk_alert":
      return { path: "/risk", label: M.buttons.risk };
    case "key_fee":
      return { path: "/settings", label: M.buttons.settings };
    case "fee_tier_changed":
      return { path: "/settings?tab=access", label: M.buttons.settings };
    case "daily_summary":
      return { path: "/desk", label: M.buttons.openDesk };
    case "leader_big_move":
    case "leader_position":
      return { path: "/following", label: M.buttons.following };
    case "copy_bot_opened":
    case "copy_bot_skipped":
      return { path: agent, label: M.buttons.bot };
    case "telegram_connected":
    case "telegram_moved":
    case "telegram_blocked":
      return { path: "/settings?tab=notifications", label: M.buttons.settings };
    case "team_signup":
    case "team_sodex_connected":
    case "team_bot_started":
      return { path: "/admin/users", label: M.buttons.users };
    case "team_mcp_tool_errors":
    case "team_mcp_introspect_failing":
    case "team_mcp_daily_limit":
    case "team_invariant":
      return { path: "/admin/stats", label: M.buttons.stats };
    case "team_incident":
      return incidentTarget(row.data);
    case "team_incident_digest":
      return { path: "/admin/bot-monitor", label: M.buttons.botMonitor };
    case "team_sr_new_market":
      return { path: "/admin/signal-analysis", label: M.buttons.signalAnalysis };
    // SoDEX rewards (#558): mở trang Rewards (tab Blind Boxes, trừ tin tạm dừng: ký lại ở đầu trang).
    case "rewards_claimable":
    case "rewards_box_received":
    case "rewards_draw_won":
      return { path: "/rewards?tab=boxes", label: M.buttons.rewards };
    case "rewards_watch_paused":
      return { path: "/rewards", label: M.buttons.rewards };
  }
}

// ---------- Sự cố tiền thật cho team (#241) ----------

const incidentKind = (data: Record<string, unknown>): TeamIncidentKind | null => {
  const k = str(data.kind);
  return k !== null && (TEAM_INCIDENT_KINDS as readonly string[]).includes(k)
    ? (k as TeamIncidentKind)
    : null;
};
/** Bot id hợp lệ (UUID) thì mới dựng link; không bao giờ ghép chuỗi lạ vào URL. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOf = (v: unknown): string | null => {
  const id = str(v);
  return id !== null && UUID_RE.test(id) ? id : null;
};
const incidentBot = (data: Record<string, unknown>): string | null => uuidOf(data.botId);

/**
 * Nút của tin sự cố: lỗi SoDEX / WS → SoDEX Debugger lọc lỗi; luồng lệnh WS trễ → SoDEX Debugger không lọc (các tin trễ
 * là dòng `ok`, bộ lọc lỗi không hiện, #518); còn lại → Bot Monitor.
 */
function incidentTarget(data: Record<string, unknown>): { path: string; label: string } {
  const kind = incidentKind(data);
  if (kind === "sodex_ws_lag") return { path: "/admin/sodex-debugger", label: M.buttons.debugger };
  return kind === "sodex_errors" || kind === "ws_closes"
    ? { path: "/admin/sodex-debugger?show=errors", label: M.buttons.debugger }
    : { path: "/admin/bot-monitor", label: M.buttons.botMonitor };
}

/** Tiêu đề một dòng: mức độ + loại. */
function incidentTitle(data: Record<string, unknown>): string {
  const kind = incidentKind(data);
  const severity = kind === null ? "warning" : TEAM_INCIDENT_SEVERITY[kind];
  return fill(INC.title, {
    severity: INC_SEVERITY[severity] ?? severity,
    title: kind === null ? M.titles.key_fee : (INC_KINDS[kind] ?? kind),
  });
}

/** "Volume Farm · BTC-USD · bot ··1a2b3c4d"; phần nào thiếu thì bỏ. */
function incidentWhere(data: Record<string, unknown>): string | null {
  const strategy = str(data.strategy);
  const market = str(data.market);
  const bot = incidentBot(data);
  const parts = [
    strategy === null ? null : escapeTelegramHtml(STRATEGIES[strategy] ?? strategy),
    market === null ? null : escapeTelegramHtml(market),
    bot === null ? null : fill(INC.bot, { bot: `··${bot.slice(-8)}` }),
  ].filter((x): x is string => x !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

const link = (base: string, path: string, label: string) =>
  `<a href="${escapeTelegramHtml(`${base}${path}`)}">${label}</a>`;

/**
 * Link trong tin: trang Users › chi tiết của chủ bot (có danh sách bot; team không mở được trang bot của user), SoDEX
 * Debugger lọc theo bot, Bot Monitor. Không token đăng nhập.
 */
function incidentLinks(data: Record<string, unknown>, base: string): string {
  const bot = incidentBot(data);
  const user = uuidOf(data.userId);
  return [
    user === null ? null : link(base, `/admin/users/${user}`, INC.links.user),
    bot === null ? null : link(base, `/admin/sodex-debugger?botId=${bot}`, INC.links.debugger),
    link(base, "/admin/bot-monitor", INC.links.monitor),
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");
}

function incidentText(data: Record<string, unknown>, base: string): string {
  const detail = str(data.detail);
  return [
    incidentTitle(data),
    incidentWhere(data),
    detail === null ? null : escapeTelegramHtml(detail),
    incidentLinks(data, base),
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
}

/** Tin tổng hợp ngày: số lần theo loại (kể cả lần bị chặn lặp), nặng nhất trước. */
function digestText(data: Record<string, unknown>): string {
  const order = { critical: 0, warning: 1, info: 2 } as const;
  const lines = TEAM_INCIDENT_KINDS.flatMap((k) => {
    const n = data[k];
    return typeof n === "number" && n > 0 ? [{ k, n }] : [];
  })
    .sort((a, b) => order[TEAM_INCIDENT_SEVERITY[a.k]] - order[TEAM_INCIDENT_SEVERITY[b.k]])
    .map(({ k, n }) =>
      fill(INC.digestLine, { n, title: INC_KINDS[k] ?? k, severity: TEAM_INCIDENT_SEVERITY[k] }),
    );
  return `${INC.digestTitle}\n${lines.length === 0 ? INC.digestNone : lines.join("\n")}`;
}

/** Bất biến tiền thật (DEC-274): không ví / key; bot ghi `··` + 8 ký tự cuối id. */
function invariantTitle(row: RenderRow): string {
  const s = (k: string) => escapeTelegramHtml(str(row.data[k]) ?? "");
  const vars = {
    invariant: s("invariant"),
    strategy: s("strategy"),
    market: s("market"),
    bot: s("bot"),
    paper: row.data.mode === "paper" ? " · paper" : "",
    detail: s("detail"),
  };
  // "resolved" chỉ ghi lý do khi có (ví dụ "no longer checked"); rỗng thì không thêm dấu "·".
  return row.data.status === "resolved"
    ? fill(M.titles.team_invariant_resolved, {
        ...vars,
        detail: vars.detail === "" ? "" : ` · ${vars.detail}`,
      })
    : fill(M.titles.team_invariant, vars);
}

/**
 * Market SoDEX mới chưa có trong asset map Signal research (#311). Tên market đến từ SoDEX nên escape. `total` lớn hơn
 * số tên = tin tổng hợp (scheduler chỉ gửi tối đa 10 tên).
 */
function newMarketTitle(data: Record<string, unknown>): string {
  const markets = escapeTelegramHtml(str(data.markets) ?? "");
  const version = escapeTelegramHtml(str(data.version) ?? "");
  const shown = markets === "" ? 0 : markets.split(", ").length;
  const total = typeof data.total === "number" && data.total > shown ? data.total : shown;
  if (total <= 1) return fill(M.titles.team_sr_new_market, { market: markets, version });
  return fill(M.titles.team_sr_new_markets, {
    n: total,
    version,
    markets,
    more: total > shown ? fill(M.titles.team_sr_new_markets_more, { n: total - shown }) : "",
  });
}

/** Tin theo dõi MCP (DEC-225): câu PM duyệt nguyên văn; email đã che lúc fan-out. */
function mcpTitle(row: RenderRow): string {
  const num = (k: string) => {
    const v = row.data[k];
    return typeof v === "number" ? v : 0;
  };
  if (row.type === "team_mcp_tool_errors") {
    const tool = str(row.data.tool);
    const head = fill(M.titles.team_mcp_tool_errors, {
      errors: num("errors"),
      calls: num("calls"),
      pct: escapeTelegramHtml(str(row.data.pct) ?? "0"),
    });
    return tool === null
      ? head
      : `${head} ${fill(M.titles.team_mcp_tool_errors_most, { tool: escapeTelegramHtml(tool) })}`;
  }
  if (row.type === "team_mcp_introspect_failing")
    return fill(M.titles.team_mcp_introspect_failing, { failures: num("failures") });
  const n = num("count");
  return fill(M.titles.team_mcp_daily_limit, {
    users: fill(n === 1 ? M.titles.team_mcp_user : M.titles.team_mcp_users, { n }),
    emails: escapeTelegramHtml(str(row.data.emails) ?? "···"),
  });
}

/**
 * Tin báo team (DEC-184): email và ví đã che lúc fan-out (`teamMaskEmail` / `teamMaskAddress`); tên bot và market là chuỗi do
 * user nhập nên escape. Vốn do engine tính sẵn; thiếu thì bỏ phần vốn (không ghi 0).
 */
function teamTitle(row: RenderRow): string {
  const email = escapeTelegramHtml(str(row.data.email) ?? "···");
  if (row.type === "team_signup") return fill(M.titles.team_signup, { email });
  if (row.type === "team_sodex_connected")
    return fill(M.titles.team_sodex_connected, {
      email,
      wallet: escapeTelegramHtml(str(row.data.wallet) ?? "0x…"),
    });
  const strategy = str(row.data.strategy);
  const capital = str(row.data.capital);
  const asset = str(row.data.capitalAsset);
  const market = str(row.data.market);
  const parts = [
    escapeTelegramHtml(row.botName ?? str(row.data.botName) ?? M.aBot),
    strategy === null ? null : escapeTelegramHtml(STRATEGIES[strategy] ?? strategy),
    market === null ? null : escapeTelegramHtml(market),
    capital === null || asset === null ? null : escapeTelegramHtml(`${capital} ${asset}`),
  ].filter((x): x is string => x !== null);
  return fill(M.titles.team_bot_started, { email, details: parts.join(" · ") });
}

/**
 * Tiêu đề tin SoDEX rewards (#558, câu đã duyệt plan-558 NEW COPY 19–22). Dữ liệu sai dạng thì dùng câu không có số. Không
 * bao giờ có địa chỉ ví; cấp box là chuỗi SoDEX trả, được escape.
 */
function rewardsTitle(type: RewardsNotificationType, row: RenderRow): string {
  switch (type) {
    case "rewards_claimable": {
      const d = rewardsClaimableDataSchema.safeParse(row.data);
      if (!d.success) return M.titles.rewards_claimable_any;
      return d.data.count === 1
        ? M.titles.rewards_claimable_one
        : fill(M.titles.rewards_claimable, { n: d.data.count });
    }
    case "rewards_box_received": {
      const d = rewardsBoxReceivedDataSchema.safeParse(row.data);
      if (!d.success) return M.titles.rewards_received_one;
      if (d.data.count > 1) return fill(M.titles.rewards_received, { n: d.data.count });
      const level = d.data.levels[0]?.level ?? null;
      return level === null
        ? M.titles.rewards_received_one
        : fill(M.titles.rewards_received_level, { level: escapeTelegramHtml(level) });
    }
    case "rewards_draw_won": {
      const d = rewardsDrawWonDataSchema.safeParse(row.data);
      if (!d.success || d.data.wins === null || d.data.tickets === null)
        return M.titles.rewards_draw_prize;
      return d.data.tickets === 1
        ? fill(M.titles.rewards_draw_won_one_ticket, { wins: d.data.wins })
        : fill(M.titles.rewards_draw_won, { wins: d.data.wins, tickets: d.data.tickets });
    }
    case "rewards_watch_paused":
      return M.titles.rewards_paused;
  }
}

function title(row: RenderRow): string {
  const bot = botOf(row);
  const paper = row.data.paper === true;
  switch (row.type) {
    case "bot_paused":
      return fill(paper ? M.titles.paper_paused : M.titles.bot_paused, { bot });
    case "bot_stopped":
      if (isPlannedStop(row.data))
        return fill(M.titles.bot_stopped_planned, {
          bot,
          reason: plannedStopReason(row.data, row.run ?? null),
        });
      return fill(paper ? M.titles.paper_stopped : M.titles.bot_stopped, { bot });
    case "unknown_order":
      return fill(M.titles.unknown_order, { bot });
    case "risk_alert":
      return M.titles.risk_alert;
    case "key_fee":
      return M.titles.key_fee;
    case "fee_tier_changed":
      return feeTierMessage(row.data).title;
    case "fill":
      return fill(M.titles.fill, { bot });
    case "daily_summary":
      return M.titles.daily_summary;
    case "leader_big_move":
      return M.titles.leader_big_move;
    case "leader_position": {
      // Không ghi địa chỉ ví của trader (mục 5), chỉ loại thay đổi, chiều và coin.
      const kind = str(row.data.kind);
      const side = row.data.side === "long" || row.data.side === "short" ? row.data.side : null;
      const coin = escapeTelegramHtml(str(row.data.coin) ?? "");
      const template =
        kind === "close"
          ? M.titles.leader_position_close
          : kind === "flip"
            ? M.titles.leader_position_flip
            : kind === "liquidated"
              ? M.titles.leader_position_liquidated
              : M.titles.leader_position_open;
      return fill(template, { side: side ?? M.positionSide, coin });
    }
    case "copy_bot_opened": {
      const move = str(row.data.move);
      const side = row.data.side === "long" || row.data.side === "short" ? row.data.side : null;
      const template =
        move === "added"
          ? M.titles.copy_bot_added
          : move === "flipped"
            ? M.titles.copy_bot_flipped
            : M.titles.copy_bot_opened;
      return fill(template, {
        side: side ?? M.positionSide,
        coin: coinOf(str(row.data.market)) ?? "",
      });
    }
    case "copy_bot_skipped": {
      const coin = coinOf(str(row.data.market));
      return coin === null
        ? M.titles.copy_bot_skipped_any
        : fill(M.titles.copy_bot_skipped, { coin });
    }
    case "telegram_connected":
    case "telegram_moved":
    case "telegram_blocked":
      // Nhóm hệ thống không đi Telegram (DEC-183); nhánh này chỉ để switch đủ.
      return M.titles.key_fee;
    case "team_signup":
    case "team_sodex_connected":
    case "team_bot_started":
      return teamTitle(row);
    case "team_mcp_tool_errors":
    case "team_mcp_introspect_failing":
    case "team_mcp_daily_limit":
      return mcpTitle(row);
    case "team_invariant":
      return invariantTitle(row);
    case "team_incident":
      return incidentTitle(row.data);
    case "team_incident_digest":
      return INC.digestTitle;
    case "team_sr_new_market":
      return newMarketTitle(row.data);
    case "rewards_claimable":
    case "rewards_box_received":
    case "rewards_draw_won":
    case "rewards_watch_paused":
      return rewardsTitle(row.type, row);
  }
}

function body(row: RenderRow): string | null {
  const reason = reasonOf(row.data);
  const paper = row.data.paper === true;
  switch (row.type) {
    case "bot_paused":
      if (paper) return M.bodies.paper;
      return reason === null
        ? M.bodies.keptOrders
        : fill(M.bodies.pausedReason, { reason: capitalize(reason) });
    case "bot_stopped":
      if (paper) return M.bodies.paper;
      if (isPlannedStop(row.data)) return plannedStopBody(row.run ?? null);
      return reason === null ? null : fill(M.bodies.stoppedReason, { reason: capitalize(reason) });
    case "unknown_order":
      return M.bodies.unknown_order;
    case "risk_alert": {
      const kind = str(row.data.kind);
      return kind === "daily_loss"
        ? M.bodies.risk_daily_loss
        : kind === "max_drawdown"
          ? M.bodies.risk_max_drawdown
          : M.bodies.risk_other;
    }
    case "key_fee":
      return M.bodies.key_fee;
    case "fee_tier_changed":
      return feeTierMessage(row.data).body;
    case "daily_summary":
      return briefBody(row.data);
    case "leader_big_move": {
      const coin = str(row.data.coin);
      return coin === null
        ? null
        : fill(M.bodies.leader_big_move, { coin: escapeTelegramHtml(coin) });
    }
    case "leader_position":
      return M.bodies.leader_position;
    case "copy_bot_opened": {
      // Thiếu số thì bỏ câu có số (mục 5), không ghi 0.
      const size = str(row.data.size);
      const price = str(row.data.avgEntry);
      const coin = coinOf(str(row.data.market));
      if (size === null || price === null || coin === null) return null;
      return fill(M.bodies.copy_bot_opened, {
        size: escapeTelegramHtml(size),
        coin,
        price: escapeTelegramHtml(price),
      });
    }
    case "copy_bot_skipped": {
      const reason = COPY_SKIP[str(row.data.reason) ?? "other"] ?? COPY_SKIP.other ?? null;
      return reason === null ? null : fill(M.bodies.copy_bot_skipped, { reason });
    }
    case "fill":
    case "telegram_connected":
    case "telegram_moved":
    case "telegram_blocked":
    case "team_signup":
    case "team_sodex_connected":
    case "team_bot_started":
    case "team_mcp_tool_errors":
    case "team_mcp_introspect_failing":
    case "team_mcp_daily_limit":
    case "team_invariant":
    case "team_incident":
    case "team_incident_digest":
    case "team_sr_new_market":
      return null;
    case "rewards_claimable":
      return M.bodies.rewards_claimable;
    case "rewards_box_received":
      return null;
    case "rewards_draw_won": {
      const d = rewardsDrawWonDataSchema.safeParse(row.data);
      return d.success && d.data.round !== null
        ? fill(M.bodies.rewards_draw_round, { round: d.data.round })
        : null;
    }
    case "rewards_watch_paused":
      return M.bodies.rewards_paused;
  }
}

/** Bỏ thẻ HTML để dùng tiêu đề làm một dòng trong tin gộp. */
function plain(html: string): string {
  return html.replace(/<\/?b>/g, "");
}

/** Số dòng tối đa trong tin gộp; phần còn lại ghi "+N more". */
export const MERGED_LINES = 5;

/**
 * Một tin cho một hoặc nhiều thông báo cùng nhóm (mục 5 "Gộp tin"). Nhiều bot cùng pause vì cùng một lý do (ví dụ
 * revoke fee, halt all) → "3 bots paused: builder fee approval is 0."
 */
export function renderTelegram(rows: readonly RenderRow[], appUrl: string): Rendered {
  const base = appUrl.replace(/\/+$/, "");
  const first = rows[0];
  if (first === undefined) throw new Error("renderTelegram needs at least one row");
  if (rows.length === 1 && first.type === "team_incident") {
    const t = targetOf(first);
    return {
      text: incidentText(first.data, base),
      button: { text: t.label, url: `${base}${t.path}` },
    };
  }
  if (first.type === "team_incident_digest") {
    // Mỗi ngày một tin; hai tin (giao lại) thì chỉ hiện tin mới nhất.
    const last = rows[rows.length - 1] ?? first;
    return {
      text: digestText(last.data),
      button: { text: M.buttons.botMonitor, url: `${base}/admin/bot-monitor` },
    };
  }
  if (rows.length === 1) {
    const b = body(first);
    const t = targetOf(first);
    return {
      text: b === null ? title(first) : `${title(first)}\n${b}`,
      button: { text: t.label, url: `${base}${t.path}` },
    };
  }

  const group = groupOf(first.type);
  const reasons = new Set(rows.map((r) => str(r.data.reasonCode)));
  const samePause =
    rows.every((r) => r.type === "bot_paused" && r.data.paper !== true) && reasons.size === 1;
  const sameReason = samePause ? reasonOf(first.data) : null;
  if (sameReason !== null) {
    return {
      text: fill(M.merged.samePause, { n: rows.length, reason: sameReason }),
      button: { text: M.buttons.review, url: `${base}/agent` },
    };
  }
  // Báo team: worker chỉ gộp CÙNG loại sự kiện ("3 new signups"), mở trang Users.
  // Theo dõi MCP: mỗi loại tối đa 1 tin / 30 phút nên hiếm khi gộp; gộp thì liệt kê từng dòng, không thêm tiêu đề.
  // Sự cố (#241): mỗi dòng giữ mức độ, nơi xảy ra, số liệu và link SoDEX Debugger của bot.
  if (first.type === "team_incident") {
    const lines = rows.slice(0, MERGED_LINES).map((r) => {
      const where = incidentWhere(r.data);
      const detail = str(r.data.detail);
      const bot = incidentBot(r.data);
      return [
        `• ${plain(incidentTitle(r.data))}`,
        where,
        detail === null ? null : escapeTelegramHtml(detail),
        bot === null ? null : link(base, `/admin/sodex-debugger?botId=${bot}`, INC.links.debugger),
      ]
        .filter((x): x is string => x !== null)
        .join(" · ");
    });
    if (rows.length > MERGED_LINES)
      lines.push(fill(M.merged.more, { n: rows.length - MERGED_LINES }));
    return {
      text: `${fill(INC.merged, { n: rows.length })}\n${lines.join("\n")}`,
      button: { text: M.buttons.botMonitor, url: `${base}/admin/bot-monitor` },
    };
  }
  // Market SoDEX mới (#311): mỗi tin đã đủ ý, gộp thì liệt kê từng tin.
  if (first.type === "team_sr_new_market") {
    return {
      text: rows.map((r) => title(r)).join("\n"),
      button: { text: M.buttons.signalAnalysis, url: `${base}/admin/signal-analysis` },
    };
  }
  if (first.type.startsWith("team_mcp_")) {
    return {
      text: rows.map((r) => title(r)).join("\n"),
      button: { text: M.buttons.stats, url: `${base}/admin/stats` },
    };
  }
  if (group === "teamOps") {
    const lines = rows.slice(0, MERGED_LINES).map((r) => `• ${plain(title(r))}`);
    if (rows.length > MERGED_LINES)
      lines.push(fill(M.merged.more, { n: rows.length - MERGED_LINES }));
    const head =
      first.type === "team_signup"
        ? M.merged.team_signup
        : first.type === "team_sodex_connected"
          ? M.merged.team_sodex_connected
          : M.merged.team_bot_started;
    return {
      text: `${fill(head, { n: rows.length })}\n${lines.join("\n")}`,
      button: { text: M.buttons.users, url: `${base}/admin/users` },
    };
  }
  const head =
    group === "botErrors"
      ? fill(M.merged.botErrors, { n: rows.length })
      : group === "risk"
        ? fill(M.merged.risk, { n: rows.length })
        : fill(M.merged.other, { n: rows.length });
  const lines = rows.slice(0, MERGED_LINES).map((r) => `• ${plain(title(r))}`);
  if (rows.length > MERGED_LINES)
    lines.push(fill(M.merged.more, { n: rows.length - MERGED_LINES }));
  const target =
    group === "botErrors"
      ? { path: "/agent", label: M.buttons.review }
      : group === "risk"
        ? { path: "/risk", label: M.buttons.risk }
        : { path: "", label: M.buttons.app };
  return {
    text: `${head}\n${lines.join("\n")}`,
    button: { text: target.label, url: `${base}${target.path}` },
  };
}
