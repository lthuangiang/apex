import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadApiConfig } from "../src/config";

// Desk AI: DESK_AI_BASE_URL chỉ cho Claude API giả trong E2E; production trỏ localhost thì không khởi động.

const env = {
  DATABASE_URL: "postgres://x",
  API_TOTP_ENC_KEY: randomBytes(32).toString("base64"),
  SMTP_URL: "smtp://x",
  REDIS_URL: "redis://x",
  SIGNER_URL: "https://signer:8090",
  RECO_URL: "http://reco:8095",
  MAIL_FROM: "DeskLabs <no-reply@example.com>",
  SODEX_REST_URL: "https://mainnet-gw.sodex.dev",
  SODEX_WS_URL: "wss://mainnet-gw.sodex.dev/ws",
  SODEX_CHAIN: "mainnet",
  DRIFT_BUILDER_ID: "1645",
};

describe("Desk AI config", () => {
  it("leaves the Claude API URL unset and the model off by default", () => {
    const c = loadApiConfig(env);
    expect(c.DESK_AI_BASE_URL).toBeUndefined();
    expect(c.DESK_AI_API_KEY).toBeUndefined();
    expect(loadApiConfig({ ...env, DESK_AI_BASE_URL: "" }).DESK_AI_BASE_URL).toBeUndefined();
  });

  it("refuses a localhost Claude API URL in production, allows it outside", () => {
    const local = { ...env, DESK_AI_BASE_URL: "http://127.0.0.1:18097" };
    expect(() => loadApiConfig({ ...local, NODE_ENV: "production" })).toThrow(/DESK_AI_BASE_URL/);
    expect(() =>
      loadApiConfig({ ...env, DESK_AI_BASE_URL: "http://localhost:1", NODE_ENV: "production" }),
    ).toThrow(/DESK_AI_BASE_URL/);
    expect(loadApiConfig(local).DESK_AI_BASE_URL).toBe("http://127.0.0.1:18097");
  });
});
