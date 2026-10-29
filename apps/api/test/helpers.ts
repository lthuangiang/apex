import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { createDb, type Db } from "@drift/db";
import { runMigrations } from "@drift/db";
import {
  aiParameters,
  AppError,
  CSRF_COOKIE,
  CSRF_HEADER,
  ErrorCode,
  IDEMPOTENCY_KEY_HEADER,
  recommend,
  SESSION_COOKIE,
  type MaxDropOption,
  type RecoGoal,
  type RecoMarket,
  type RecoStrategy,
} from "@drift/shared";
import { MemoryRateLimitStore, SignedWriteClient, SodexRestClient } from "@drift/sodex";
import { buildSodexMock, type SodexMock } from "@drift/sodex-mock";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

import { buildApp } from "../src/app";
import type { Mail } from "../src/lib/mailer";
import type { RecoClient } from "../src/lib/reco-client";
import { memoryRateLimiter } from "../src/plugins/rate-limit";

// Postgres thật qua Testcontainers, cùng image với docker compose.
export const POSTGRES_IMAGE = "timescale/timescaledb:2.16.1-pg16";

export interface TestEnv {
  app: FastifyInstance;
  db: Db;
  pool: pg.Pool;
  container: StartedPostgreSqlContainer;
  mails: Mail[];
  logs: string[];
  clock: { now: Date };
  totpKey: Buffer;
  sodex: SodexMock;
  /** Giá gần nhất cho kiểm tra "fresh price". */
  prices: Map<string, { price: string; at: number }>;
  /** Service reco giả: chạy engine thật trong process với market cấu hình được. */
  reco: FakeReco;
  /** Id key mà signer giả coi là không giải mã được. */
  unusableKeys: Set<string>;
  close(): Promise<void>;
}

export const TEST_BUILDER_ID = 1645n;

export async function startTestEnv(options: { connectEnabled?: boolean } = {}): Promise<TestEnv> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  await runMigrations(url);
  const { db, pool } = createDb(url);
  const mails: Mail[] = [];
  const logs: string[] = [];
  const clock = { now: new Date("2026-10-27T08:00:00Z") };
  const unusableKeys = new Set<string>();
  const totpKey = randomBytes(32);
  const sodex = buildSodexMock({ builderIds: [Number(TEST_BUILDER_ID)] });
  const sodexOptions = {
    config: { restUrl: "https://mainnet-gw.sodex.dev" },
    rateLimit: new MemoryRateLimitStore(),
    egressKey: "test",
    fetch: sodex.fetch,
  };
  const prices = new Map<string, { price: string; at: number }>();
  const reco: FakeReco = { markets: [], down: false };
  const app = await buildApp({
    lastPrice: (market) => Promise.resolve(prices.get(market) ?? null),
    reco: fakeRecoClient(reco),
    rateLimiter: memoryRateLimiter(),
    rateLimits: { perIp: 1_000_000, perUser: 1_000_000, windowMs: 60_000 },
    prices: (markets) =>
      Promise.resolve(
        Object.fromEntries(
          markets.flatMap((m) => {
            const p = prices.get(m);
            return p === undefined ? [] : [[m, p.price]];
          }),
        ),
      ),
    sodex: {
      rest: new SodexRestClient(sodexOptions),
      writer: new SignedWriteClient(sodexOptions),
      // Signer giả: sinh key và lưu ciphertext giả. Signer thật có test riêng với Vault.
      signer: {
        // Key trong `unusableKeys` mô phỏng ciphertext không giải mã được (Vault mất khoá).
        verifyApiKey: (id) => Promise.resolve(unusableKeys.has(id) ? "unusable" : "ok"),
        async createApiKey(input) {
          const id = uuidv7();
          const publicKey = privateKeyToAddress(generatePrivateKey());
          await pool.query(
            `insert into api_keys (id, sodex_account_id, name, public_key, ciphertext, kms_key_ref, last4, permissions_mask, expires_at, status)
             values ($1, $2, $3, $4, 'vault:v1:test', 'test', $5, 14, $6, 'pending')`,
            [
              id,
              input.sodexAccountId,
              input.name,
              publicKey,
              publicKey.slice(-4).toLowerCase(),
              input.expiresAt,
            ],
          );
          return { id, publicKey };
        },
      },
      builderId: TEST_BUILDER_ID,
      connectEnabled: options.connectEnabled ?? true,
    },
    db,
    mailer: {
      send: (mail) => {
        mails.push(mail);
        return Promise.resolve();
      },
    },
    totpKey,
    cookieSecure: false,
    logLevel: "info",
    now: () => clock.now,
    logStream: new Writable({
      write(chunk: Buffer, _enc, done) {
        logs.push(chunk.toString());
        done();
      },
    }),
  });
  return {
    app,
    unusableKeys,
    db,
    pool,
    container,
    mails,
    logs,
    clock,
    totpKey,
    sodex,
    prices,
    reco,
    async close() {
      await app.close();
      await pool.end();
      await container.stop();
    },
  };
}

/** Client giữ cookie như trình duyệt và tự gửi CSRF header. */
export class TestClient {
  readonly cookies = new Map<string, string>();

  constructor(private readonly app: FastifyInstance) {}

  async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    options: { body?: unknown; idempotencyKey?: string | false; csrf?: boolean } = {},
  ): Promise<LightMyRequestResponse> {
    if (method !== "GET" && !this.cookies.has(CSRF_COOKIE)) {
      await this.request("GET", "/api/v1/auth/csrf");
    }
    const headers: Record<string, string> = {};
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const csrf = this.cookies.get(CSRF_COOKIE);
    if (method !== "GET" && options.csrf !== false && csrf !== undefined)
      headers[CSRF_HEADER] = csrf;
    if (method !== "GET" && options.idempotencyKey !== false) {
      headers[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey ?? randomUUID();
    }
    const response = await this.app.inject({
      method,
      url,
      headers,
      ...(options.body === undefined ? {} : { payload: options.body as object }),
    });
    for (const c of response.cookies) {
      if (c.value === "" || (c.expires !== undefined && c.expires.getTime() <= Date.now() - 1e9)) {
        this.cookies.delete(c.name);
      } else {
        this.cookies.set(c.name, c.value);
      }
    }
    return response;
  }

  get session(): string | undefined {
    return this.cookies.get(SESSION_COOKIE);
  }
}

export function lastCode(mails: Mail[]): string {
  const match = /\b(\d{6})\b/.exec(mails.at(-1)?.text ?? "");
  if (match?.[1] === undefined) throw new Error("No OTP mail");
  return match[1];
}

export async function signIn(
  env: TestEnv,
  client: TestClient,
  email: string,
  twoFactorCode?: string,
) {
  await client.request("POST", "/api/v1/auth/otp", { body: { email } });
  return client.request("POST", "/api/v1/auth/session", {
    body: {
      email,
      code: lastCode(env.mails),
      ...(twoFactorCode === undefined ? {} : { twoFactorCode }),
    },
  });
}

export interface FakeReco {
  markets: RecoMarket[];
  down: boolean;
}

function fakeRecoClient(state: FakeReco): RecoClient {
  const check = () => {
    if (state.down) throw new AppError(ErrorCode.recoUnavailable, "AI parameters unavailable.");
  };
  return {
    plan(body) {
      check();
      return Promise.resolve(
        recommend(
          {
            account: body.account,
            goals: {
              ...body.goals,
              goal: body.goals.goal as RecoGoal,
              maxDrop: body.goals.maxDrop as MaxDropOption,
            },
            markets: state.markets,
            accountLeverageCap: body.accountLeverageCap,
            now: body.now,
          },
          body.timeZone,
        ),
      );
    },
    params(body) {
      check();
      const market = state.markets.find((m) => m.market === body.market);
      if (market === undefined) return Promise.resolve(null);
      return Promise.resolve(
        aiParameters(
          body.strategy as RecoStrategy,
          market,
          { ...body, maxDrop: body.maxDrop as MaxDropOption, markets: state.markets },
          body.timeZone,
        ),
      );
    },
  };
}
