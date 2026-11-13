import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { connect as connectNats } from "@nats-io/transport-node";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Redis } from "ioredis";
import { GenericContainer, Wait } from "testcontainers";

import { startClaudeMock } from "./support/claude-mock";
import { startTelegramMock } from "./support/telegram-mock";

// Dựng toàn bộ hệ thống cho E2E (CODING_STANDARDS C14): Postgres + Vault + Mailpit bằng Testcontainers,
// rồi chạy thật sodex-mock, signer, api, mcp và web. SoDEX luôn là mock: E2E không bao giờ ký lên mainnet (DEC-23).

export const PORTS = {
  mock: 18099,
  mockControl: 18098,
  signer: 18090,
  api: 18080,
  web: 13100,
  reco: 18095,
  claude: 18097,
  telegram: 18096,
  mcp: 18094,
} as const;
/** Shared secret giả giữa apps/mcp và api cho introspect (không phải giá trị thật). */
const MCP_FAKE_SECRET = "e2e_fake_mcp_introspect_secret_0123456789abcdef";
/** Token và webhook secret giả cho Telegram Bot API giả (không phải giá trị thật). */
const TELEGRAM_FAKE_TOKEN = "e2e-fake-telegram-bot-token";
const TELEGRAM_FAKE_SECRET = "e2e_fake_webhook_secret_0123456789abcdef";
export const BUILDER_ID = "1645";
/** Trader Hyperliquid seed sẵn cho spec Copy Trading (p13). */
export const E2E_TRADER = "0xaaa0000000000000000000000000000000000001";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VAULT_TOKEN = "e2e-root";

async function waitFor(url: string, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // chưa lên
    }
    if (Date.now() > until) throw new Error(`Timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Chờ cổng TCP mở (mock chạy https với cert tự ký mà tiến trình này không tin). */
async function waitForPort(port: number, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        resolve(false);
      });
    });
    if (open) return;
    if (Date.now() > until) throw new Error(`Timed out waiting for port ${String(port)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function killGroup(child: ChildProcess) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // đã thoát
  }
}

function start(name: string, args: string[], env: Record<string, string>): ChildProcess {
  // `detached`: mỗi service một process group, để teardown kill được cả pnpm → tsx → node.
  const child = spawn("pnpm", args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stderr.on("data", (d: Buffer) => {
    if (process.env.E2E_DEBUG === "1") process.stderr.write(`[${name}] ${d.toString()}`);
  });
  child.stdout.on("data", (d: Buffer) => {
    if (process.env.E2E_DEBUG === "1") process.stdout.write(`[${name}] ${d.toString()}`);
  });
  return child;
}

/** Cert tự ký cho mock (api chỉ nhận SoDEX qua https); api tin cert qua NODE_EXTRA_CA_CERTS. */
function selfSignedCert(): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "drift-e2e-"));
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  const res = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  if (res.status !== 0) throw new Error("openssl failed");
  return { cert, key };
}

/** CA nội bộ + cert cho mTLS api/engine ↔ signer (cùng script với compose dev). */
function mtlsCerts(): string {
  const dir = mkdtempSync(join(tmpdir(), "drift-mtls-"));
  const res = spawnSync("sh", [join(ROOT, "infra/certs/gen-dev-certs.sh"), dir], {
    stdio: "ignore",
  });
  if (res.status !== 0) throw new Error("mTLS cert generation failed");
  return dir;
}

export default async function globalSetup() {
  const tls = selfSignedCert();
  const certs = mtlsCerts();
  const signerClient = (who: "api" | "engine") => ({
    SIGNER_CLIENT_CERT: join(certs, `${who}.crt`),
    SIGNER_CLIENT_KEY: join(certs, `${who}.key`),
    SIGNER_CLIENT_CA: join(certs, "ca.crt"),
  });
  // Lần lượt từng container: khởi động song song hay làm Docker timeout khi bind cổng.
  const postgres = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  const vault = await new GenericContainer("hashicorp/vault:1.17")
    .withEnvironment({ VAULT_DEV_ROOT_TOKEN_ID: VAULT_TOKEN })
    .withAddedCapabilities("IPC_LOCK")
    .withExposedPorts(8200)
    .withWaitStrategy(Wait.forHttp("/v1/sys/health", 8200))
    .start();
  const mailpit = await new GenericContainer("axllent/mailpit:v1.32.0")
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp("/livez", 8025))
    .start();
  const nats = await new GenericContainer("nats:2.10-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage("Server is ready"))
    .start();
  const redis = await new GenericContainer("redis:7.4-alpine")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
    .start();

  const vaultAddr = `http://${vault.getHost()}:${String(vault.getMappedPort(8200))}`;
  for (const [path, body] of [
    ["/v1/sys/mounts/transit", { type: "transit" }],
    ["/v1/transit/keys/drift-api-keys", { type: "aes256-gcm96" }],
  ] as const) {
    const res = await fetch(`${vaultAddr}${path}`, {
      method: "POST",
      headers: { "X-Vault-Token": VAULT_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`vault ${path} ${String(res.status)}`);
  }

  const databaseUrl = postgres.getConnectionUri();
  const migrate = spawnSync("pnpm", ["--filter", "@drift/api", "db:migrate"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
  if (migrate.status !== 0) throw new Error("migration failed");
  // Thay scheduler: thống kê ngày cho vBTC_vUSDC để engine đề xuất có dữ liệu (P8).
  const seeded = await postgres.exec([
    "psql",
    "-U",
    postgres.getUsername(),
    "-d",
    postgres.getDatabase(),
    "-c",
    "insert into market_stats_daily (market, engine, date, sigma30, p5, p50, p95, last_price, trend, range_score) values ('vBTC_vUSDC', 'spot', current_date, 0.02, 92, 100, 108, 100, 0, 0.7)",
  ]);
  if (seeded.exitCode !== 0) throw new Error(`seed failed: ${seeded.output}`);
  // Copy Trading (DEC-163), thay scheduler: một trader Hyperliquid đã tính thống kê ở lượt đêm, và tài khoản email
  // `e2e-copy-…` được bật AI Desk khi đăng ký (không cần quyền team).
  const traderStats = JSON.stringify({
    profit: "84120",
    worstDip: "9800",
    typicalHoldMs: 20_400_000,
    winRate: "0.62",
    wins: 73,
    closedEpisodes: 118,
    topTradeShare: "0.18",
    coverage: "1",
    liquidations: 0,
    medianEntryNotional: "40000",
    markets: ["BTC-USD"],
    unlistedCoins: [],
    dailyCurve: [
      [Date.now() - 2 * 86_400_000, "1000"],
      [Date.now() - 86_400_000, "1500"],
    ],
    historyIncomplete: false,
    fills: 412,
  });
  const copySeed = await postgres.exec([
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    postgres.getUsername(),
    "-d",
    postgres.getDatabase(),
    "-c",
    `create function e2e_copy_desk() returns trigger language plpgsql as $$ begin if new.email like 'e2e-copy-%' then new.ai_desk := true; end if; return new; end $$;
     create trigger e2e_copy_desk before insert on users for each row execute function e2e_copy_desk();
     insert into leaderboard_runs (date, status) values (current_date, 'ok');
     insert into leader_wallets (source, address) values ('hyperliquid', '${E2E_TRADER}');
     insert into leader_stats_daily (source, address, date, stats, hidden, tabs, steady_score, profit, typical_hold_ms, computed_at)
       values ('hyperliquid', '${E2E_TRADER}', current_date, '${traderStats}', '{}', '{steady,top,long,all}', 8.5, '84120', 20400000, now());`,
  ]);
  if (copySeed.exitCode !== 0) throw new Error(`copy seed failed: ${copySeed.output}`);
  // AI Desk B+ (p14): user `e2e-desk-*` được bật AI Desk như team bật ở Users › AI Desk.
  const deskSeed = await postgres.exec([
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    postgres.getUsername(),
    "-d",
    postgres.getDatabase(),
    "-c",
    `create function e2e_desk() returns trigger language plpgsql as $$ begin if new.email like 'e2e-desk-%' then new.ai_desk := true; end if; return new; end $$;
     create trigger e2e_desk before insert on users for each row execute function e2e_desk();`,
  ]);
  if (deskSeed.exitCode !== 0) throw new Error(`desk seed failed: ${deskSeed.output}`);
  process.env.E2E_PG = JSON.stringify({
    id: postgres.getId(),
    user: postgres.getUsername(),
    db: postgres.getDatabase(),
  });
  // Claude API giả: Desk AI gọi tới đây (DESK_AI_BASE_URL), không bao giờ gọi Anthropic thật.
  const claude = await startClaudeMock(PORTS.claude);
  process.env.E2E_CLAUDE = `http://127.0.0.1:${String(PORTS.claude)}`;
  // Telegram Bot API giả (N5): api và jobs gửi tin tới đây, không bao giờ gọi api.telegram.org.
  const telegram = await startTelegramMock(PORTS.telegram);
  const telegramOrigin = `http://127.0.0.1:${String(PORTS.telegram)}`;
  process.env.E2E_TELEGRAM = telegramOrigin;
  process.env.E2E_TELEGRAM_SECRET = TELEGRAM_FAKE_SECRET;

  const mailpitApi = `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(8025))}`;
  process.env.E2E_MAILPIT = mailpitApi;
  process.env.E2E_MOCK_CONTROL = `http://127.0.0.1:${String(PORTS.mockControl)}`;
  process.env.E2E_WEB = `http://127.0.0.1:${String(PORTS.web)}`;

  const apiOrigin = `http://127.0.0.1:${String(PORTS.api)}`;
  process.env.E2E_API = apiOrigin;
  const webOrigin = `http://127.0.0.1:${String(PORTS.web)}`;
  const mcpOrigin = `http://127.0.0.1:${String(PORTS.mcp)}`;
  process.env.E2E_MCP = mcpOrigin;
  const redisUrl = `redis://${redis.getHost()}:${String(redis.getMappedPort(6379))}`;
  const natsUrl = `nats://${nats.getHost()}:${String(nats.getMappedPort(4222))}`;
  // Thay marketdata: đẩy giá 100 cho vBTC_vUSDC mỗi giây vào NATS và Redis `md:last:*` (P7).
  const feedNc = await connectNats({ servers: natsUrl });
  const feedRedis = new Redis(redisUrl);
  const feed = setInterval(() => {
    const T = Date.now();
    feedNc.publish("md.vBTC_vUSDC.price", JSON.stringify({ s: "vBTC_vUSDC", c: "100", T }));
    void feedRedis.set("md:last:vBTC_vUSDC", JSON.stringify({ price: "100", at: T }), "PX", 60_000);
    // Copy Trading (p13): market Perps của trader seed sẵn.
    feedNc.publish("md.BTC-USD.price", JSON.stringify({ s: "BTC-USD", c: "100", T }));
    void feedRedis.set("md:last:BTC-USD", JSON.stringify({ price: "100", at: T }), "PX", 60_000);
  }, 1_000);
  const children = [
    start("mock", ["--filter", "@drift/sodex-mock", "start"], {
      PORT: String(PORTS.mock),
      CONTROL_PORT: String(PORTS.mockControl),
      DRIFT_BUILDER_ID: BUILDER_ID,
      TLS_CERT: tls.cert,
      TLS_KEY: tls.key,
    }),
    start("signer", ["--filter", "@drift/signer", "start"], {
      SIGNER_PORT: String(PORTS.signer),
      SIGNER_TLS_CERT: join(certs, "signer.crt"),
      SIGNER_TLS_KEY: join(certs, "signer.key"),
      SIGNER_TLS_CA: join(certs, "ca.crt"),
      SIGNER_REQUIRE_MTLS: "true",
      DATABASE_URL: databaseUrl,
      VAULT_ADDR: vaultAddr,
      VAULT_TOKEN,
    }),
    start("jobs", ["--filter", "@drift/jobs", "start"], {
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      NATS_URL: natsUrl,
      SODEX_REST_URL: `https://localhost:${String(PORTS.mock)}`,
      SODEX_WS_URL: "wss://localhost/ws",
      SODEX_CHAIN: "mainnet",
      // SoDEX mock không có giới hạn của mainnet: nâng bucket tự đặt để các test không chặn lẫn nhau.
      SODEX_REST_WEIGHT_PER_MIN: "1000000",
      DRIFT_BUILDER_ID: BUILDER_ID,
      NODE_EXTRA_CA_CERTS: tls.cert,
      TELEGRAM_ENABLED: "true",
      DRIFT_TELEGRAM_BOT_TOKEN: TELEGRAM_FAKE_TOKEN,
      DRIFT_TELEGRAM_API_ORIGIN: telegramOrigin,
      LOG_LEVEL: "warn",
    }),
    start("engine", ["--filter", "@drift/engine", "start"], {
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      NATS_URL: natsUrl,
      ...signerClient("engine"),
      SIGNER_URL: `https://localhost:${String(PORTS.signer)}`,
      SODEX_REST_URL: `https://localhost:${String(PORTS.mock)}`,
      SODEX_WS_URL: "wss://localhost:1/ws",
      SODEX_CHAIN: "mainnet",
      // SoDEX mock không có giới hạn của mainnet: nâng bucket tự đặt để các test không chặn lẫn nhau.
      SODEX_REST_WEIGHT_PER_MIN: "1000000",
      DRIFT_BUILDER_ID: BUILDER_ID,
      NODE_EXTRA_CA_CERTS: tls.cert,
      ENGINE_SHARD_LEASE_TTL_MS: "5000",
      ENGINE_FEE_CHECK_MS: "3000",
      LOG_LEVEL: "warn",
    }),
    start("backtest", ["--filter", "@drift/backtest", "start"], {
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      NATS_URL: natsUrl,
      SODEX_REST_URL: `https://localhost:${String(PORTS.mock)}`,
      SODEX_WS_URL: "wss://localhost:1/ws",
      SODEX_CHAIN: "mainnet",
      // SoDEX mock không có giới hạn của mainnet: nâng bucket tự đặt để các test không chặn lẫn nhau.
      SODEX_REST_WEIGHT_PER_MIN: "1000000",
      DRIFT_BUILDER_ID: BUILDER_ID,
      NODE_EXTRA_CA_CERTS: tls.cert,
      LOG_LEVEL: "warn",
    }),
    start("reco", ["--filter", "@drift/reco", "start"], {
      RECO_PORT: String(PORTS.reco),
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      SODEX_REST_URL: `https://localhost:${String(PORTS.mock)}`,
      SODEX_WS_URL: "wss://localhost:1/ws",
      SODEX_CHAIN: "mainnet",
      // SoDEX mock không có giới hạn của mainnet: nâng bucket tự đặt để các test không chặn lẫn nhau.
      SODEX_REST_WEIGHT_PER_MIN: "1000000",
      DRIFT_BUILDER_ID: BUILDER_ID,
      NODE_EXTRA_CA_CERTS: tls.cert,
      LOG_LEVEL: "warn",
    }),
    start("api", ["--filter", "@drift/api", "start"], {
      API_PORT: String(PORTS.api),
      DATABASE_URL: databaseUrl,
      API_TOTP_ENC_KEY: randomBytes(32).toString("base64"),
      API_COOKIE_SECURE: "false",
      SMTP_URL: `smtp://${mailpit.getHost()}:${String(mailpit.getMappedPort(1025))}`,
      MAIL_FROM: "DRIFT <no-reply@drift.test>",
      REDIS_URL: redisUrl,
      ...signerClient("api"),
      SIGNER_URL: `https://localhost:${String(PORTS.signer)}`,
      RECO_URL: `http://127.0.0.1:${String(PORTS.reco)}`,
      SODEX_REST_URL: `https://localhost:${String(PORTS.mock)}`,
      NODE_EXTRA_CA_CERTS: tls.cert,
      SODEX_WS_URL: "wss://mock.invalid/ws",
      SODEX_CHAIN: "mainnet",
      // SoDEX mock không có giới hạn của mainnet: nâng bucket tự đặt để các test không chặn lẫn nhau.
      SODEX_REST_WEIGHT_PER_MIN: "1000000",
      DRIFT_BUILDER_ID: BUILDER_ID,
      SODEX_CONNECT_ENABLED: "true",
      // Mọi request E2E đến từ 127.0.0.1 qua Next proxy: nâng giới hạn theo IP / user.
      API_RATE_LIMIT_PER_IP: "100000",
      API_RATE_LIMIT_PER_USER: "100000",
      // Desk AI với Claude API giả (key giả, không phải key thật).
      DESK_AI_API_KEY: "e2e-fake-key",
      DESK_AI_BASE_URL: `http://127.0.0.1:${String(PORTS.claude)}`,
      // Telegram với Bot API giả (N5).
      TELEGRAM_ENABLED: "true",
      DRIFT_TELEGRAM_BOT_TOKEN: TELEGRAM_FAKE_TOKEN,
      DRIFT_TELEGRAM_WEBHOOK_SECRET: TELEGRAM_FAKE_SECRET,
      DRIFT_TELEGRAM_API_ORIGIN: telegramOrigin,
      // MCP (DEC-167): issuer OAuth là web E2E, token gắn với apps/mcp chạy local.
      DRIFT_APP_URL: webOrigin,
      MCP_PUBLIC_URL: mcpOrigin,
      MCP_INTROSPECT_SECRET: MCP_FAKE_SECRET,
      LOG_LEVEL: "warn",
    }),
    start("mcp", ["--filter", "@drift/mcp", "start"], {
      MCP_PORT: String(PORTS.mcp),
      API_INTERNAL_URL: apiOrigin,
      MCP_PUBLIC_URL: mcpOrigin,
      DRIFT_APP_URL: webOrigin,
      MCP_INTROSPECT_SECRET: MCP_FAKE_SECRET,
      REDIS_URL: redisUrl,
      LOG_LEVEL: "warn",
    }),
  ];

  const stopAll = async () => {
    clearInterval(feed);
    await feedNc.close();
    feedRedis.disconnect();
    for (const child of children) killGroup(child);
    claude.close();
    telegram.close();
    await Promise.all([postgres.stop(), vault.stop(), mailpit.stop(), redis.stop(), nats.stop()]);
  };
  try {
    const build = spawnSync("pnpm", ["--filter", "@drift/web", "build"], {
      cwd: ROOT,
      env: { ...process.env, API_INTERNAL_URL: apiOrigin, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: process.env.E2E_DEBUG === "1" ? "inherit" : "ignore",
    });
    if (build.status !== 0) throw new Error("web build failed");
    children.push(
      start("web", ["--filter", "@drift/web", "exec", "next", "start", "-p", String(PORTS.web)], {
        API_INTERNAL_URL: apiOrigin,
      }),
    );

    await Promise.all([
      waitForPort(PORTS.mock),
      waitFor(`http://127.0.0.1:${String(PORTS.mockControl)}/`),
      waitForPort(PORTS.signer),
      waitFor(`${apiOrigin}/healthz`),
      waitFor(`http://127.0.0.1:${String(PORTS.reco)}/healthz`),
      waitFor(`${mcpOrigin}/healthz`),
      waitFor(`http://127.0.0.1:${String(PORTS.web)}/signup`),
    ]);
  } catch (error) {
    await stopAll();
    throw error;
  }
  return stopAll;
}
