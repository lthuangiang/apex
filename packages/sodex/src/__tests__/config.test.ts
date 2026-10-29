import { describe, expect, it } from "vitest";

import { loadSodexConfig } from "../config";

const env = {
  SODEX_REST_URL: "https://mainnet-gw.sodex.dev/",
  SODEX_WS_URL: "wss://mainnet-gw.sodex.dev/ws",
  SODEX_CHAIN: "mainnet",
  DRIFT_BUILDER_ID: "18446744073709551615",
};

describe("loadSodexConfig", () => {
  it("parses mainnet config and keeps the builder id as an exact uint64", () => {
    const config = loadSodexConfig(env);
    expect(config.restUrl).toBe("https://mainnet-gw.sodex.dev");
    expect(config.builderId).toBe(18446744073709551615n);
  });

  it("refuses to start without DRIFT_BUILDER_ID", () => {
    expect(() => loadSodexConfig({ ...env, DRIFT_BUILDER_ID: undefined })).toThrow();
    expect(() => loadSodexConfig({ ...env, DRIFT_BUILDER_ID: "" })).toThrow();
  });

  it("rejects builder ids that are not positive uint64 integers", () => {
    for (const bad of ["0", "-1", "12.5", "abc", "18446744073709551616"]) {
      expect(() => loadSodexConfig({ ...env, DRIFT_BUILDER_ID: bad }), bad).toThrow();
    }
  });

  it("only accepts mainnet over secure transports", () => {
    expect(() => loadSodexConfig({ ...env, SODEX_CHAIN: "testnet" })).toThrow();
    expect(() =>
      loadSodexConfig({ ...env, SODEX_REST_URL: "http://mainnet-gw.sodex.dev" }),
    ).toThrow();
    expect(() =>
      loadSodexConfig({ ...env, SODEX_WS_URL: "ws://mainnet-gw.sodex.dev/ws" }),
    ).toThrow();
  });
});
