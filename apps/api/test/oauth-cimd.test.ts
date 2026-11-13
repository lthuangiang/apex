import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  ClientMetadataError,
  fetchClientMetadata,
  httpsGetPinned,
  isPublicAddress,
  parseClientIdUrl,
  type CimdDeps,
  type FetchedResponse,
} from "../src/modules/oauth/cimd";

// Client ID Metadata Document: chống SSRF theo các điểm PM chốt (DEC-215). Không gọi mạng thật: DNS và
// transport được thay bằng hàm giả.

const URL_ID = "https://claude.example/oauth/client.json";
const ok = (body: unknown, extra: Partial<FetchedResponse> = {}): FetchedResponse => ({
  status: 200,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify(body),
  ...extra,
});
const meta = (over: Record<string, unknown> = {}) => ({
  client_id: URL_ID,
  client_name: "Claude",
  redirect_uris: ["https://claude.example/api/mcp/auth_callback"],
  ...over,
});
const deps = (
  address: string | string[],
  res: FetchedResponse | Error,
): CimdDeps & { seen: string[] } => {
  const seen: string[] = [];
  return {
    seen,
    lookup: () =>
      Promise.resolve(
        (Array.isArray(address) ? address : [address]).map((a) => ({
          address: a,
          family: a.includes(":") ? 6 : 4,
        })),
      ),
    get: (_url, ip) => {
      seen.push(ip);
      return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
    },
  };
};
const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    expect(e).toBeInstanceOf(ClientMetadataError);
    return (e as Error).message;
  }
};

describe("client ID metadata documents", () => {
  it("accepts a valid document and connects to the address it checked", async () => {
    const d = deps("93.184.216.34", ok(meta()));
    await expect(fetchClientMetadata(URL_ID, d)).resolves.toMatchObject({ client_name: "Claude" });
    expect(d.seen).toEqual(["93.184.216.34"]);
  });

  it("blocks private, loopback, link-local, CGNAT and IPv4-mapped addresses, even mixed with a public one", async () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "::ffff:127.0.0.1",
    ])
      expect(isPublicAddress(ip)).toBe(false);
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:2800:220:1::1")).toBe(true);
    const d = deps(["93.184.216.34", "10.0.0.7"], ok(meta()));
    expect(await reason(fetchClientMetadata(URL_ID, d))).toMatch(/non-public/);
    expect(d.seen).toEqual([]);
  });

  it("refuses redirects, non-JSON, bodies over 16 KB and timeouts, with no fallback", async () => {
    expect(
      await reason(fetchClientMetadata(URL_ID, deps("93.184.216.34", ok(meta(), { status: 302 })))),
    ).toMatch(/redirect/);
    expect(
      await reason(
        fetchClientMetadata(
          URL_ID,
          deps("93.184.216.34", ok(meta(), { contentType: "text/html" })),
        ),
      ),
    ).toMatch(/application\/json/);
    expect(
      await reason(
        fetchClientMetadata(
          URL_ID,
          deps("93.184.216.34", ok(meta({ client_name: "x".repeat(17_000) }))),
        ),
      ),
    ).toMatch(/16 KB/);
    expect(
      await reason(
        fetchClientMetadata(
          URL_ID,
          deps("93.184.216.34", new ClientMetadataError("client metadata request timed out")),
        ),
      ),
    ).toMatch(/timed out/);
  });

  it("requires the document to name its own URL and only safe redirect URIs", async () => {
    expect(
      await reason(
        fetchClientMetadata(
          URL_ID,
          deps("93.184.216.34", ok(meta({ client_id: "https://other.example/c.json" }))),
        ),
      ),
    ).toMatch(/does not match/);
    expect(
      await reason(
        fetchClientMetadata(
          URL_ID,
          deps("93.184.216.34", ok(meta({ redirect_uris: ["http://claude.example/cb"] }))),
        ),
      ),
    ).toMatch(/redirect_uri/);
  });

  it("accepts only https client_id URLs on port 443 with a path and a host name", () => {
    for (const bad of [
      "http://claude.example/c.json",
      "https://claude.example:8443/c.json",
      "https://claude.example/",
      "https://user:pw@claude.example/c.json",
      "https://93.184.216.34/c.json",
      "https://[::1]/c.json",
    ])
      expect(() => parseClientIdUrl(bad)).toThrow(ClientMetadataError);
    expect(parseClientIdUrl(URL_ID).hostname).toBe("claude.example");
  });

  it("gives up after 3 s in total even when the server keeps dripping bytes", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const t = setInterval(() => res.write(" "), 200);
      res.on("close", () => {
        clearInterval(t);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const started = Date.now();
    const err = await httpsGetPinned(new URL("https://drip.example/c.json"), "127.0.0.1", 4, {
      request: httpRequest,
      port,
    }).catch((e: unknown) => e);
    server.close();
    expect(err).toBeInstanceOf(ClientMetadataError);
    expect((err as Error).message).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(4_500);
  });
});
