import { readdirSync, readFileSync } from "node:fs";
import { Writable } from "node:stream";

import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSignerApp } from "../src/app";
import { KeyUnusableError, type VaultTransit } from "../src/vault";

// #558 PR2 (DEC-398): signer chỉ mã hoá / giải mã phiên rewards, không gọi ra ngoài Vault. Không cần Docker: pool và
// Vault giả. Kiểm CN (mTLS) ở `mtls.test.ts`. Token mẫu là chuỗi giả dạng JWT, không phải JWT thật.

const TOKEN = "eyJhbGciOiJub25lIn0.eyJleHAiOjE3OTYwMDAwMDB9.c2ln";
const USER = "0195f000-0000-7000-8000-000000000001";

function fakeVault(
  overrides: Partial<Pick<VaultTransit, "encrypt" | "decrypt">> = {},
): VaultTransit {
  return {
    keyRef: "vault-transit:drift-rewards",
    encrypt: overrides.encrypt ?? ((b) => Promise.resolve(`vault:v1:${b.toString("base64")}`)),
    decrypt:
      overrides.decrypt ??
      ((c) => Promise.resolve(Buffer.from(c.replace(/^vault:v1:/, ""), "base64"))),
  };
}

function fakePool(rows: { token_ciphertext: string | null; status: string }[]) {
  const query = vi.fn(() => Promise.resolve({ rows }));
  return { pool: { query } as unknown as pg.Pool, query };
}

function build(opts: {
  rows?: { token_ciphertext: string | null; status: string }[];
  rewardsVault?: VaultTransit | null;
}) {
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logs.push(chunk.toString());
      cb();
    },
  });
  const { pool, query } = fakePool(opts.rows ?? []);
  const rv = opts.rewardsVault === undefined ? fakeVault() : opts.rewardsVault;
  const app = buildSignerApp({
    pool,
    vault: {} as VaultTransit,
    ...(rv === null ? {} : { rewardsVault: rv }),
    logLevel: "info",
    logStream,
  });
  return { app, logs, query };
}

const encryptedToken = `vault:v1:${Buffer.from(TOKEN).toString("base64")}`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /v1/rewards-tokens/encrypt", () => {
  it("encrypts with the rewards transit key and never echoes the token", async () => {
    const { app, logs } = build({});
    const res = await app.inject({
      method: "POST",
      url: "/v1/rewards-tokens/encrypt",
      payload: { token: TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ciphertext: encryptedToken,
      keyRef: "vault-transit:drift-rewards",
    });
    expect(res.body).not.toContain(TOKEN);
    expect(logs.join("")).not.toContain(TOKEN);
  });

  it("rejects non-JWT bodies and extra fields", async () => {
    const { app } = build({});
    for (const payload of [{ token: "opaque" }, { token: TOKEN, userId: USER }, {}]) {
      const res = await app.inject({ method: "POST", url: "/v1/rewards-tokens/encrypt", payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it("returns 503 without a rewards key or when Vault fails", async () => {
    const off = build({ rewardsVault: null });
    expect(
      (
        await off.app.inject({
          method: "POST",
          url: "/v1/rewards-tokens/encrypt",
          payload: { token: TOKEN },
        })
      ).statusCode,
    ).toBe(503);
    const failing = build({
      rewardsVault: fakeVault({ encrypt: () => Promise.reject(new Error("vault down")) }),
    });
    const res = await failing.app.inject({
      method: "POST",
      url: "/v1/rewards-tokens/encrypt",
      payload: { token: TOKEN },
    });
    expect(res.statusCode).toBe(503);
    expect(failing.logs.join("")).not.toContain(TOKEN);
  });
});

describe("POST /v1/rewards-tokens/decrypt", () => {
  it("decrypts the active row of one user, reading the ciphertext itself", async () => {
    const { app, logs, query } = build({
      rows: [{ token_ciphertext: encryptedToken, status: "active" }],
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/rewards-tokens/decrypt",
      payload: { userId: USER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ token: TOKEN });
    expect(query).toHaveBeenCalledWith(
      "select token_ciphertext, status from rewards_watch where user_id = $1",
      [USER],
    );
    const text = logs.join("");
    expect(text).toContain("rewards token decrypted");
    expect(text).not.toContain(TOKEN);
  });

  it("returns 404 for a paused row, a row without ciphertext, or no row", async () => {
    for (const rows of [
      [{ token_ciphertext: encryptedToken, status: "paused" }],
      [{ token_ciphertext: null, status: "paused" }],
      [],
    ]) {
      const { app } = build({ rows });
      const res = await app.inject({
        method: "POST",
        url: "/v1/rewards-tokens/decrypt",
        payload: { userId: USER },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(TOKEN);
    }
  });

  it("does not accept a ciphertext from the caller", async () => {
    const { app, query } = build({ rows: [] });
    const res = await app.inject({
      method: "POST",
      url: "/v1/rewards-tokens/decrypt",
      payload: { userId: USER, ciphertext: encryptedToken },
    });
    expect(res.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it("maps an undecryptable ciphertext to 422 and Vault errors to 503", async () => {
    const rows = [{ token_ciphertext: encryptedToken, status: "active" }];
    const lost = build({
      rows,
      rewardsVault: fakeVault({ decrypt: () => Promise.reject(new KeyUnusableError()) }),
    });
    expect(
      (
        await lost.app.inject({
          method: "POST",
          url: "/v1/rewards-tokens/decrypt",
          payload: { userId: USER },
        })
      ).statusCode,
    ).toBe(422);
    const down = build({
      rows,
      rewardsVault: fakeVault({ decrypt: () => Promise.reject(new Error("vault down")) }),
    });
    expect(
      (
        await down.app.inject({
          method: "POST",
          url: "/v1/rewards-tokens/decrypt",
          payload: { userId: USER },
        })
      ).statusCode,
    ).toBe(503);
  });
});

describe("signer has no egress besides Vault", () => {
  it("never calls fetch while encrypting or decrypting rewards tokens", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const { app } = build({ rows: [{ token_ciphertext: encryptedToken, status: "active" }] });
    await app.inject({
      method: "POST",
      url: "/v1/rewards-tokens/encrypt",
      payload: { token: TOKEN },
    });
    await app.inject({
      method: "POST",
      url: "/v1/rewards-tokens/decrypt",
      payload: { userId: USER },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("only the Vault client uses fetch in the signer source", () => {
    const dir = new URL("../src/", import.meta.url);
    const users = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /\bfetch\(/.test(readFileSync(new URL(f, dir), "utf8")));
    expect(users).toEqual(["vault.ts"]);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src, f).not.toMatch(/node:(http|https|net)["']/);
      expect(src, f).not.toContain("sodex.dev");
    }
  });
});
