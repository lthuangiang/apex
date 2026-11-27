import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadApiConfig } from "../src/config";

// #547 / DEC-397: `REWARDS_ENABLED` là công tắc toàn hệ thống của SoDEX rewards. Mặc định BẬT cho mọi user từ bản sau
// #575 (DEC-397 bổ sung); `false` là nút tắt khẩn.

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
  it("is on by default and parses true / false", () => {
    expect(loadApiConfig(env).REWARDS_ENABLED).toBe(true);
    expect(loadApiConfig({ ...env, REWARDS_ENABLED: "true" }).REWARDS_ENABLED).toBe(true);
    expect(loadApiConfig({ ...env, REWARDS_ENABLED: "false" }).REWARDS_ENABLED).toBe(false);
  });
});

describe("REWARDS_WATCH_ENABLED (#558, DEC-398)", () => {
  it("is off by default and parses true / false", () => {
    expect(loadApiConfig(env).REWARDS_WATCH_ENABLED).toBe(false);
    expect(loadApiConfig({ ...env, REWARDS_WATCH_ENABLED: "true" }).REWARDS_WATCH_ENABLED).toBe(
      true,
    );
    expect(loadApiConfig({ ...env, REWARDS_WATCH_ENABLED: "false" }).REWARDS_WATCH_ENABLED).toBe(
      false,
    );
  });
});
