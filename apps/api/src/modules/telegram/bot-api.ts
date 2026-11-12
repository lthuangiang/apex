import { z } from "zod";

// Client Bot API tối thiểu bằng `fetch` (docs/NOTIFICATIONS.md mục 6: không thêm dependency).
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

const responseSchema = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().int().optional() }).optional(),
});

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
        const parsed = responseSchema.safeParse(await res.json().catch(() => null));
        if (res.ok && parsed.success && parsed.data.ok) return { ok: true };
        return {
          ok: false,
          status: res.status,
          description: redact(parsed.success ? (parsed.data.description ?? "") : "", options.token),
          retryAfterSec: parsed.success ? (parsed.data.parameters?.retry_after ?? null) : null,
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
export function redact(text: string, token: string): string {
  return token.length === 0 ? text : text.split(token).join("[redacted]");
}
