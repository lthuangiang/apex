import { createServer, type Server } from "node:http";

// Telegram Bot API giả cho E2E Telegram (docs/NOTIFICATIONS.md mục 10): api và jobs trỏ `DRIFT_TELEGRAM_API_ORIGIN` tới
// đây với token giả. Không bao giờ gọi api.telegram.org. `POST /bot<token>/sendMessage` ghi lại tin và trả ok;
// `GET /__telegram/messages` trả các tin đã nhận (không kèm token).

export interface SentMessage {
  chat_id: number;
  text: string;
  parse_mode?: string;
  reply_markup?: { inline_keyboard?: { text: string; url?: string }[][] };
}

export function startTelegramMock(port: number): Promise<Server> {
  const messages: SentMessage[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/__telegram/messages") {
        json(200, messages);
        return;
      }
      if (/^\/bot[^/]+\/sendMessage$/.test(req.url ?? "") && req.method === "POST") {
        const m = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SentMessage;
        messages.push(m);
        json(200, { ok: true, result: { message_id: messages.length, chat: { id: m.chat_id } } });
        return;
      }
      json(404, { ok: false, error_code: 404, description: "Not Found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

/** Tin Bot API giả đã nhận cho một chat. */
export async function telegramMessages(chatId: number): Promise<SentMessage[]> {
  const res = await fetch(`${process.env.E2E_TELEGRAM ?? ""}/__telegram/messages`);
  return ((await res.json()) as SentMessage[]).filter((m) => m.chat_id === chatId);
}

/** Gửi một update như Telegram gửi webhook (đúng secret header). Trả body trả lời của api. */
export async function telegramUpdate(
  chatId: number,
  text: string,
  username = "e2e_tester",
): Promise<{ status: number; body: { method?: string; text?: string } }> {
  const res = await fetch(`${process.env.E2E_API ?? ""}/api/v1/telegram/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": process.env.E2E_TELEGRAM_SECRET ?? "",
    },
    body: JSON.stringify({
      update_id: Math.floor(Math.random() * 1e9),
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: "private", username },
        from: { id: chatId, is_bot: false, first_name: "E2E", username },
        text,
      },
    }),
  });
  return { status: res.status, body: (await res.json()) as { method?: string; text?: string } };
}
