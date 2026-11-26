import { describe, expect, it } from "vitest";

import { loadRewardsSignerState } from "../src/rewards-watch/signer-tls";

// #558 (DEC-398): scheduler khởi động được khi prod chưa có scheduler.crt; job rewards tắt, không ném lỗi.

const ENV = {
  SIGNER_URL: "https://signer:8090",
  SIGNER_CLIENT_CERT: "/certs/scheduler.crt",
  SIGNER_CLIENT_KEY: "/certs/scheduler.key",
  SIGNER_CLIENT_CA: "/certs/ca.crt",
};

const files: Record<string, string> = {
  "/certs/scheduler.crt": "CERT",
  "/certs/scheduler.key": "KEY",
  "/certs/ca.crt": "CA",
};
const read = (p: string) => {
  const v = files[p];
  if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  return v;
};

describe("loadRewardsSignerState", () => {
  it("is ready when the watch is on and the scheduler cert exists", () => {
    expect(loadRewardsSignerState(ENV, true, read)).toEqual({
      kind: "ready",
      url: "https://signer:8090",
      tls: { cert: "CERT", key: "KEY", ca: "CA" },
    });
  });

  it("does not read files when the watch is off", () => {
    let reads = 0;
    const state = loadRewardsSignerState(ENV, false, (p) => {
      reads += 1;
      return read(p);
    });
    expect(state).toEqual({ kind: "off", reason: "watch_disabled" });
    expect(reads).toBe(0);
  });

  it("turns off without throwing when scheduler.crt is missing (old prod cert volume)", () => {
    const missing = (p: string) => {
      if (p === "/certs/scheduler.crt")
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return read(p);
    };
    expect(() => loadRewardsSignerState(ENV, true, missing)).not.toThrow();
    expect(loadRewardsSignerState(ENV, true, missing)).toEqual({
      kind: "off",
      reason: "cert_missing",
    });
  });

  it("reports unreadable certs and missing settings", () => {
    const denied = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(loadRewardsSignerState(ENV, true, denied)).toEqual({
      kind: "off",
      reason: "cert_unreadable",
    });
    expect(loadRewardsSignerState({ ...ENV, SIGNER_CLIENT_KEY: "" }, true, read)).toEqual({
      kind: "off",
      reason: "not_configured",
    });
    expect(loadRewardsSignerState({}, true, read)).toEqual({
      kind: "off",
      reason: "not_configured",
    });
  });
});
