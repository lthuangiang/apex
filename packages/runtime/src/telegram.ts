// Client Bot API tối thiểu bằng `fetch` cho api và jobs (docs/NOTIFICATIONS.md mục 6: không thêm dependency).
// Token nằm trong URL (`/bot<token>/<method>`), nên URL không bao giờ được log hay đưa vào lỗi: chỉ ghi tên
// method và kết quả (CLAUDE.md quy tắc 1.9).

export const TELEGRAM_API_ORIGIN = "https://api.telegram.org";

/** Nút URL duy nhất của mỗi tin (mục 5): chỉ mở app, không có nút hành động. */
export interface UrlButton {
  text: string;
  url: string;
}

export interface SendMessage {
  chat_id: number;
  text: string;
  parse_mode: "HTML";
  link_preview_options: { is_disabled: true };
  reply_markup?: { inline_keyboard: [[UrlButton]] };
}

export type BotApiResult =
  | { ok: true }
  | {
      ok: false;
      /** HTTP status từ Telegram; 0 khi không tới được (mạng, timeout). */
      status: number;
      description: string;
      retryAfterSec: number | null;
    };

export interface BotApi {
  sendMessage(message: SendMessage): Promise<BotApiResult>;
}

interface TelegramResponse {
  ok: boolean;
  description: string;
  retryAfter: number | null;
}

function parseResponse(raw: unknown): TelegramResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ok !== "boolean") return null;
  const params = r.parameters;
  const retry =
    typeof params === "object" && params !== null
      ? (params as Record<string, unknown>).retry_after
      : undefined;
  return {
    ok: r.ok,
    description: typeof r.description === "string" ? r.description : "",
    retryAfter: typeof retry === "number" && Number.isInteger(retry) ? retry : null,
  };
}

export function createBotApi(options: {
  token: string;
  origin?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): BotApi {
  const origin = options.origin ?? TELEGRAM_API_ORIGIN;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;
  return {
    async sendMessage(message) {
      try {
        const res = await doFetch(`${origin}/bot${options.token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const parsed = parseResponse(await res.json().catch(() => null));
        if (res.ok && parsed?.ok === true) return { ok: true };
        return {
          ok: false,
          status: res.status,
          description: redactToken(parsed?.description ?? "", options.token),
          retryAfterSec: parsed?.retryAfter ?? null,
        };
      } catch (error) {
        // Lỗi fetch có thể chứa URL (gồm token): chỉ giữ tên lỗi.
        const name = error instanceof Error ? error.name : "Error";
        return { ok: false, status: 0, description: name, retryAfterSec: null };
      }
    },
  };
}

/** Bỏ token khỏi chuỗi bất kỳ trước khi log (phòng khi Telegram lặp lại URL). */
export function redactToken(text: string, token: string): string {
  return token.length === 0 ? text : text.split(token).join("[redacted]");
}

/**
 * Người dùng chặn bot / xoá chat (mục 3 "Bị chặn", mục 6): 403, hoặc 400 "chat not found". Khi đó đặt `blocked`
 * và ngừng gửi; gửi lại không có ích.
 */
export function isBlockedResult(r: BotApiResult): boolean {
  if (r.ok) return false;
  return r.status === 403 || (r.status === 400 && /chat not found/i.test(r.description));
}
