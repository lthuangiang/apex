import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadApiConfig } from "../src/config";

// #547 / DEC-397: `REWARDS_ENABLED` là công tắc toàn hệ thống của SoDEX rewards, mặc định tắt trong lúc xây.

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

describe("REWARDS_ENABLED", () => {
  it("is off by default and parses true / false", () => {
    expect(loadApiConfig(env).REWARDS_ENABLED).toBe(false);
    expect(loadApiConfig({ ...env, REWARDS_ENABLED: "true" }).REWARDS_ENABLED).toBe(true);
    expect(loadApiConfig({ ...env, REWARDS_ENABLED: "false" }).REWARDS_ENABLED).toBe(false);
  });
});
