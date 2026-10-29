import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { postJson } from "@drift/runtime";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildSignerApp } from "../src/app";
import type { VaultTransit } from "../src/vault";

// mTLS giữa api / engine và signer (DEC-42): cert client phải do CA nội bộ ký, và CN quyết định endpoint.

const dir = mkdtempSync(join(tmpdir(), "drift-mtls-"));
const run = (args: string[]) => {
  const r = spawnSync("openssl", args, { cwd: dir, stdio: "ignore" });
  if (r.status !== 0) throw new Error(`openssl ${args.join(" ")}`);
};
function issue(name: string, cn: string, ca: { key: string; crt: string }, server = false) {
  run([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-subj",
    `/CN=${cn}`,
    "-out",
    `${name}.csr`,
  ]);
  if (server)
    writeFileSync(join(dir, `${name}.ext`), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  run([
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    ca.crt,
    "-CAkey",
    ca.key,
    "-CAcreateserial",
    "-days",
    "1",
    "-out",
    `${name}.crt`,
    ...(server ? ["-extfile", `${name}.ext`] : []),
  ]);
  return {
    cert: readFileSync(join(dir, `${name}.crt`), "utf8"),
    key: readFileSync(join(dir, `${name}.key`), "utf8"),
  };
}

let app: FastifyInstance;
let url: string;
let caPem: string;
let client: Record<"api" | "engine" | "rogue", { cert: string; key: string }>;

beforeAll(async () => {
  run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-subj",
    "/CN=drift-internal-ca",
    "-days",
    "1",
    "-out",
    "ca.crt",
  ]);
  run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "rogue-ca.key",
    "-subj",
    "/CN=rogue-ca",
    "-days",
    "1",
    "-out",
    "rogue-ca.crt",
  ]);
  caPem = readFileSync(join(dir, "ca.crt"), "utf8");
  const ca = { key: "ca.key", crt: "ca.crt" };
  const server = issue("signer", "signer", ca, true);
  client = {
    api: issue("api", "api", ca),
    engine: issue("engine", "engine", ca),
    rogue: issue("rogue", "engine", { key: "rogue-ca.key", crt: "rogue-ca.crt" }),
  };
  app = buildSignerApp({
    pool: {} as pg.Pool,
    vault: {} as VaultTransit,
    logLevel: "silent",
    tls: { ...server, ca: caPem },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  url = `https://localhost:${String(typeof addr === "object" && addr !== null ? addr.port : 0)}`;
});
afterAll(async () => {
  await app.close();
});

const call = (path: string, who: "api" | "engine" | "rogue" | null) =>
  postJson(
    `${url}${path}`,
    {},
    {
      tls: who === null ? { cert: "", key: "", ca: caPem } : { ...client[who], ca: caPem },
      timeoutMs: 5000,
    },
  );

describe("signer mTLS", () => {
  it("lets only the engine sign and only the api create keys", async () => {
    expect((await call("/v1/sign", "api")).status).toBe(403);
    expect((await call("/v1/api-keys", "engine")).status).toBe(403);
    // Qua được kiểm tra caller, rồi bị từ chối vì body rỗng.
    expect((await call("/v1/sign", "engine")).status).toBe(400);
    expect((await call("/v1/api-keys", "api")).status).toBe(400);
  });

  it("refuses clients without a certificate signed by the internal CA", async () => {
    await expect(call("/v1/sign", "rogue")).rejects.toThrow();
    await expect(call("/v1/sign", null)).rejects.toThrow();
  });
});
