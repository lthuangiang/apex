import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

import { OAUTH_CONFIG } from "@drift/shared";
import { z } from "zod";

// Client ID Metadata Document (đặc tả MCP authorization, draft-ietf-oauth-client-id-metadata-document; DEC-215).
// client_id là URL https; api tải JSON metadata từ URL đó. Đây là request ra ngoài theo URL do client chọn, nên chặn SSRF
// (PM chốt): chỉ https cổng 443; resolve DNS một lần, mọi địa chỉ phải là địa chỉ công khai, rồi kết nối thẳng tới IP đã
// kiểm tra (chống DNS rebinding); không theo redirect; chỉ `application/json`; tối đa 16 KB; timeout 3 s; không cookie,
// không header xác thực. Lỗi → từ chối authorize, không fallback.

export class ClientMetadataError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ClientMetadataError";
  }
}

/** Dải địa chỉ không được tải: private, loopback, link-local, CGNAT, multicast, dành riêng, IPv4-mapped. */
const BLOCKED = (() => {
  const b = new BlockList();
  for (const [net, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const)
    b.addSubnet(net, prefix, "ipv4");
  for (const [net, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
    ["2001:db8::", 32],
  ] as const)
    b.addSubnet(net, prefix, "ipv6");
  return b;
})();

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    const a = address.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) và NAT64 (64:ff9b::/96): chặn hết. Không đặt hai dải này vào BlockList vì Node so
    // khớp cả địa chỉ IPv4 thường với dải IPv4-mapped, làm mọi IPv4 bị chặn.
    if (a.startsWith("::ffff:") || a.startsWith("64:ff9b:")) return false;
  }
  return !BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** URL client_id hợp lệ: https, không cổng khác 443, không user:pass, không fragment, có path. */
export function parseClientIdUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ClientMetadataError("client_id is not a URL");
  }
  if (url.protocol !== "https:") throw new ClientMetadataError("client_id must use https");
  if (url.port !== "" && url.port !== "443")
    throw new ClientMetadataError("client_id must use port 443");
  if (url.username !== "" || url.password !== "")
    throw new ClientMetadataError("client_id must not contain credentials");
  if (url.hash !== "") throw new ClientMetadataError("client_id must not contain a fragment");
  if (url.pathname === "/" || url.pathname === "")
    throw new ClientMetadataError("client_id must contain a path");
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0)
    throw new ClientMetadataError("client_id host must be a name, not an IP address");
  return url;
}

export const clientMetadataSchema = z.object({
  client_id: z.string(),
  client_name: z.string().max(200).optional(),
  redirect_uris: z.array(z.string().max(2000)).min(1).max(20),
});
export type ClientMetadata = z.infer<typeof clientMetadataSchema>;

/** Phản hồi HTTP thô của một lần tải (tách ra để test được redirect / kích thước / timeout / content-type). */
export interface FetchedResponse {
  status: number;
  contentType: string | null;
  body: string;
}

export interface CimdDeps {
  /** Resolve DNS (mặc định `dns.lookup` all). */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** Tải URL bằng IP đã kiểm tra (mặc định https.request gắn IP qua `lookup`, SNI = host). */
  get?: (url: URL, address: string, family: number) => Promise<FetchedResponse>;
}

/** Tải qua https tới đúng IP đã kiểm tra, không theo redirect, cắt ở 16 KB, timeout 3 s. */
export function httpsGetPinned(
  url: URL,
  address: string,
  family: number,
  /** Test: thay transport (http thường) và cổng. */
  t: { request?: typeof httpsRequest; port?: number } = {},
): Promise<FetchedResponse> {
  return new Promise((resolve, reject) => {
    // Hạn tổng 3 s cho cả request (option `timeout` chỉ là idle timeout: server nhỏ giọt giữ được lâu hơn).
    const deadline = setTimeout(() => {
      req.destroy(new ClientMetadataError("client metadata request timed out"));
    }, OAUTH_CONFIG.cimdTimeoutMs);
    const done =
      <T>(fn: (v: T) => void) =>
      (v: T) => {
        clearTimeout(deadline);
        fn(v);
      };
    const req = (t.request ?? httpsRequest)(
      {
        host: url.hostname,
        servername: url.hostname,
        port: t.port ?? 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { accept: "application/json", "user-agent": "DeskLabs-OAuth" },
        // Kết nối thẳng tới IP đã kiểm tra: không resolve lại (chống DNS rebinding).
        // Node gọi với `all: true` khi tự chọn họ địa chỉ (autoSelectFamily): khi đó callback nhận mảng.
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          if (opts.all === true) cb(null, [{ address, family }]);
          else cb(null, address, family);
        }) as never,
        timeout: OAUTH_CONFIG.cimdTimeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > OAUTH_CONFIG.cimdMaxBytes) {
            req.destroy(new ClientMetadataError("client metadata is larger than 16 KB"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          clearTimeout(deadline);
          resolve({
            status: res.statusCode ?? 0,
            contentType: res.headers["content-type"] ?? null,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", done(reject));
      },
    );
    req.on("timeout", () => {
      req.destroy(new ClientMetadataError("client metadata request timed out"));
    });
    req.on("error", done(reject));
    req.end();
  });
}

const defaultLookup = (host: string) => dnsLookup(host, { all: true, order: "verbatim" });

/** Tải và kiểm tra Client ID Metadata Document. Mọi lỗi → `ClientMetadataError` (từ chối, không fallback). */
export async function fetchClientMetadata(
  rawClientId: string,
  deps: CimdDeps = {},
): Promise<ClientMetadata> {
  const url = parseClientIdUrl(rawClientId);
  const resolved = await (deps.lookup ?? defaultLookup)(url.hostname).catch(() => {
    throw new ClientMetadataError("client_id host does not resolve");
  });
  if (resolved.length === 0) throw new ClientMetadataError("client_id host does not resolve");
  // Một địa chỉ nội bộ là đủ để từ chối (tránh chọn may rủi giữa nhiều bản ghi).
  if (resolved.some((r) => !isPublicAddress(r.address)))
    throw new ClientMetadataError("client_id host resolves to a non-public address");
  const target = resolved[0];
  if (target === undefined) throw new ClientMetadataError("client_id host does not resolve");
  let res: FetchedResponse;
  try {
    res = await (deps.get ?? httpsGetPinned)(url, target.address, target.family);
  } catch (e) {
    throw e instanceof ClientMetadataError
      ? e
      : new ClientMetadataError("client metadata could not be fetched");
  }
  if (res.status >= 300 && res.status < 400)
    throw new ClientMetadataError("client metadata must not redirect");
  if (res.status !== 200)
    throw new ClientMetadataError(`client metadata returned HTTP ${String(res.status)}`);
  if (res.contentType === null || !/^application\/json(\s*;|$)/i.test(res.contentType))
    throw new ClientMetadataError("client metadata must be application/json");
  if (Buffer.byteLength(res.body) > OAUTH_CONFIG.cimdMaxBytes)
    throw new ClientMetadataError("client metadata is larger than 16 KB");
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new ClientMetadataError("client metadata is not valid JSON");
  }
  const parsed = clientMetadataSchema.safeParse(json);
  if (!parsed.success) throw new ClientMetadataError("client metadata is missing required fields");
  if (parsed.data.client_id !== rawClientId)
    throw new ClientMetadataError("client metadata client_id does not match its URL");
  for (const r of parsed.data.redirect_uris)
    if (!isAllowedRedirectUri(r))
      throw new ClientMetadataError("client metadata has a disallowed redirect_uri");
  return parsed.data;
}

/** redirect_uri được phép: https bất kỳ, hoặc http loopback (127.0.0.1, [::1], localhost) cho client chạy trên máy. */
export function isAllowedRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash !== "" || u.username !== "" || u.password !== "") return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname);
}
