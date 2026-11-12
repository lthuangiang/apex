import { TELEGRAM_LINK_TOKEN_RE } from "@drift/shared";
import { z } from "zod";

// Update Telegram gửi tới webhook là dữ liệu từ ngoài: parse bằng zod, chỉ lấy phần cần (CODING_STANDARDS C2).
// v1 chỉ xử lý tin nhắn văn bản trong chat riêng; mọi thứ khác bỏ qua (mục 3 và 5).

const chatSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  username: z.string().optional(),
});

export const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      chat: chatSchema,
      text: z.string().max(4096).optional(),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export type BotCommand =
  | { kind: "start"; token: string | null }
  | { kind: "stop" }
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "text" };

/**
 * Tách lệnh từ nội dung tin. Nhận cả dạng `/start@desklabsbot <token>`. Tham số `start` không đúng định dạng
 * token thì coi như token sai (vẫn trả `token`), để trả lời "link expired" chứ không lộ là định dạng sai.
 */
export function parseCommand(text: string | undefined, botUsername: string): BotCommand {
  const raw = (text ?? "").trim();
  const m = /^\/([a-z]+)(?:@([A-Za-z0-9_]+))?(?:\s+(\S+))?\s*$/i.exec(raw);
  if (m === null) return { kind: "text" };
  const [, name = "", mention, arg] = m;
  // Lệnh gọi bot khác (`/start@otherbot`) không phải của mình.
  if (mention !== undefined && mention.toLowerCase() !== botUsername.toLowerCase())
    return { kind: "text" };
  switch (name.toLowerCase()) {
    case "start":
      return { kind: "start", token: arg ?? null };
    case "stop":
      return { kind: "stop" };
    case "help":
      return { kind: "help" };
    case "status":
      return { kind: "status" };
    default:
      return { kind: "text" };
  }
}

export function isWellFormedToken(token: string): boolean {
  return TELEGRAM_LINK_TOKEN_RE.test(token);
}
