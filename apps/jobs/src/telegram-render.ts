import { escapeTelegramHtml, groupOf, type NotificationType } from "@drift/shared";

import messages from "./messages/en.json" with { type: "json" };

// Nội dung tin Telegram (docs/NOTIFICATIONS.md mục 5, artboard NT-Telegram): tiêu đề một dòng có emoji theo
// nhóm, 1–2 câu, rồi một URL button mở đúng màn hình. Hàm thuần, không I/O.
// - Chuỗi không do DeskLabs viết (tên bot, market) luôn được escape.
// - Không bao giờ có địa chỉ ví, key, secret, link đăng nhập. Payload hiện có không mang số USDC, nên không có
//   câu số tiền (mục 5: thiếu dữ liệu thì bỏ câu có số).

const M = messages.telegram;
const REASONS: Record<string, string> = messages.reasons;

export interface RenderRow {
  type: NotificationType;
  data: Record<string, unknown>;
  /** Tên bot do user đặt (chưa escape); null khi không có bot hoặc không tìm thấy. */
  botName: string | null;
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
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
    case "daily_summary":
      return { path: "/desk", label: M.buttons.desk };
    case "leader_big_move":
      return { path: "/following", label: M.buttons.following };
    case "telegram_connected":
    case "telegram_moved":
    case "telegram_blocked":
      return { path: "/settings?tab=notifications", label: M.buttons.settings };
  }
}

function title(row: RenderRow): string {
  const bot = botOf(row);
  const paper = row.data.paper === true;
  switch (row.type) {
    case "bot_paused":
      return fill(paper ? M.titles.paper_paused : M.titles.bot_paused, { bot });
    case "bot_stopped":
      return fill(paper ? M.titles.paper_stopped : M.titles.bot_stopped, { bot });
    case "unknown_order":
      return fill(M.titles.unknown_order, { bot });
    case "risk_alert":
      return M.titles.risk_alert;
    case "key_fee":
      return M.titles.key_fee;
    case "fill":
      return fill(M.titles.fill, { bot });
    case "daily_summary":
      return M.titles.daily_summary;
    case "leader_big_move":
      return M.titles.leader_big_move;
    case "telegram_connected":
    case "telegram_moved":
    case "telegram_blocked":
      // Nhóm hệ thống không đi Telegram (DEC-183); nhánh này chỉ để switch đủ.
      return M.titles.key_fee;
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
    case "daily_summary":
      return M.bodies.daily_summary;
    case "leader_big_move": {
      const coin = str(row.data.coin);
      return coin === null
        ? null
        : fill(M.bodies.leader_big_move, { coin: escapeTelegramHtml(coin) });
    }
    case "fill":
    case "telegram_connected":
    case "telegram_moved":
    case "telegram_blocked":
      return null;
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
