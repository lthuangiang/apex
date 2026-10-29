import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

// Gọi dịch vụ nội bộ qua mTLS (api / engine → signer, DEC-42). Không thêm dependency: dùng `node:https` vì `fetch`
// của Node không nhận client certificate. Không có TLS (dev không cấu hình) thì gọi http thường.

export interface ClientTls {
  cert: string;
  key: string;
  ca: string;
}

/** Đọc cert/key/CA từ đường dẫn trong env; thiếu một trong ba thì trả `undefined` (không dùng mTLS). */
export function loadClientTls(
  env: Record<string, string | undefined>,
  prefix: string,
): ClientTls | undefined {
  const cert = env[`${prefix}_CERT`];
  const key = env[`${prefix}_KEY`];
  const ca = env[`${prefix}_CA`];
  if (
    cert === undefined ||
    cert === "" ||
    key === undefined ||
    key === "" ||
    ca === undefined ||
    ca === ""
  )
    return undefined;
  return {
    cert: readFileSync(cert, "utf8"),
    key: readFileSync(key, "utf8"),
    ca: readFileSync(ca, "utf8"),
  };
}

export function postJson(
  url: string,
  body: unknown,
  opts: { tls?: ClientTls | undefined; timeoutMs: number },
): Promise<{ status: number; json: unknown }> {
  const u = new URL(url);
  const payload = JSON.stringify(body);
  const secure = u.protocol === "https:";
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: opts.timeoutMs,
        ...(secure && opts.tls !== undefined
          ? { cert: opts.tls.cert, key: opts.tls.key, ca: opts.tls.ca }
          : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try {
            json = text === "" ? null : JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("request timed out"));
    });
    req.on("error", reject);
    req.end(payload);
  });
}
