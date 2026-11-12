import { createServer, type Server } from "node:http";

// Claude API giả cho E2E AI Desk (DEC-165): api trỏ `DESK_AI_BASE_URL` tới đây với key giả. Không bao giờ gọi Anthropic
// thật. Điều khiển bằng `POST /__claude/mode` ({ mode: "ok" | "error", text }); `GET /__claude/requests` trả các request
// đã nhận (system + user) để test kiểm tra đúng ngữ cảnh.

interface Mode {
  mode: "ok" | "error";
  text: string;
}

export function startClaudeMock(port: number): Promise<Server> {
  let mode: Mode = { mode: "ok", text: "Your bots are running." };
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/__claude/mode" && req.method === "POST") {
        mode = JSON.parse(raw) as Mode;
        json(200, { ok: true });
        return;
      }
      if (req.url === "/__claude/requests") {
        json(200, requests);
        return;
      }
      if (req.url?.startsWith("/v1/messages") === true && req.method === "POST") {
        requests.push(JSON.parse(raw) as unknown);
        if (mode.mode === "error") {
          json(500, { type: "error", error: { type: "api_error", message: "fake outage" } });
          return;
        }
        json(200, {
          id: `msg_e2e_${String(requests.length)}`,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: mode.text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 1000,
            output_tokens: 40,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        });
        return;
      }
      json(404, { error: "not found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

const control = () => process.env.E2E_CLAUDE ?? "";

export async function claudeMode(mode: "ok" | "error", text = "Your bots are running.") {
  await fetch(`${control()}/__claude/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, text }),
  });
}

export async function claudeRequests(): Promise<
  { system?: unknown; messages?: { content: string }[] }[]
> {
  const res = await fetch(`${control()}/__claude/requests`);
  return (await res.json()) as { messages?: { content: string }[] }[];
}
