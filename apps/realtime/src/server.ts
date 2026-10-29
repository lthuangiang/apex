import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

import { sessions, sodexAccounts, type Db } from "@drift/db";
import { SESSION_COOKIE } from "@drift/shared";
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import { and, eq, gt, isNull } from "drizzle-orm";
import { WebSocketServer, type WebSocket } from "ws";

// realtime (ARCHITECTURE.md mục 3.2): đẩy sự kiện `user.<accountId>.*` từ NATS tới trình duyệt qua
// WebSocket. Xác thực bằng cookie phiên (giống api); chỉ đẩy sự kiện của account thuộc chính người dùng
// (CODING_STANDARDS C12). Không nhận lệnh từ client.

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export async function accountsForSession(
  db: Db,
  token: string,
  now: Date,
): Promise<string[] | null> {
  const hash = createHash("sha256").update(token).digest("hex");
  const [s] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, hash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        gt(sessions.absoluteExpiresAt, now),
      ),
    )
    .limit(1);
  if (s === undefined) return null;
  const rows = await db
    .select({ id: sodexAccounts.id })
    .from(sodexAccounts)
    .where(eq(sodexAccounts.userId, s.userId));
  return rows.map((r) => r.id);
}

export function startRealtime(deps: {
  db: Db;
  nc: NatsConnection;
  port: number;
  now?: () => Date;
}): Promise<Server> {
  const now = deps.now ?? (() => new Date());
  const server = createServer((_req, res) => {
    res.writeHead(_req.url === "/healthz" ? 200 : 404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const token = cookieValue(req, SESSION_COOKIE);
    void (async () => {
      const accounts = token === undefined ? null : await accountsForSession(deps.db, token, now());
      if (accounts === null) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        attach(ws, accounts);
      });
    })();
  });

  function attach(ws: WebSocket, accounts: string[]) {
    const subs: Subscription[] = accounts.map((id) => deps.nc.subscribe(`user.${id}.>`));
    for (const sub of subs) {
      void (async () => {
        for await (const m of sub) {
          if (ws.readyState !== ws.OPEN) break;
          ws.send(JSON.stringify({ subject: m.subject, data: m.json() }));
        }
      })();
    }
    ws.on("close", () => {
      for (const s of subs) s.unsubscribe();
    });
    ws.send(JSON.stringify({ subject: "realtime.ready", data: { accounts: accounts.length } }));
  }

  return new Promise((resolve) => {
    server.listen(deps.port, () => {
      resolve(server);
    });
  });
}
