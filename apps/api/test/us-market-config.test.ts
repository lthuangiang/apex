import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadApiConfig } from "../src/config";

// #589 / DEC-402 mục 9: `US_MARKET_ENABLED` mặc định BẬT; `false` là nút tắt.

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

describe("US_MARKET_ENABLED", () => {
  it("is on by default and parses true / false", () => {
    expect(loadApiConfig(env).US_MARKET_ENABLED).toBe(true);
    expect(loadApiConfig({ ...env, US_MARKET_ENABLED: "false" }).US_MARKET_ENABLED).toBe(false);
    expect(loadApiConfig({ ...env, US_MARKET_ENABLED: "true" }).US_MARKET_ENABLED).toBe(true);
  });

  it("Wealth weight cap defaults to 400", () => {
    expect(loadApiConfig(env).WEALTH_READ_MAX_WEIGHT_PER_MIN).toBe(400);
    expect(
      loadApiConfig({ ...env, WEALTH_READ_MAX_WEIGHT_PER_MIN: "100" })
        .WEALTH_READ_MAX_WEIGHT_PER_MIN,
    ).toBe(100);
  });
});
