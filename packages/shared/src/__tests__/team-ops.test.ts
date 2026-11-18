import { describe, expect, it } from "vitest";

import {
  groupOf,
  TEAM_INCIDENT_SEVERITY,
  teamIncidentThrottle,
  teamOpsEventSchema,
  teamMaskAddress,
  teamMaskEmail,
  NOTIFICATION_DEFAULTS,
  TEAM_ONLY_GROUPS,
  TELEGRAM_ONLY_GROUPS,
} from "../api/notifications";

// Báo team qua Telegram (DEC-184): che email / ví, nhóm teamOps chỉ cho team, chỉ Telegram, mặc định bật.

describe("team ops masking", () => {
  it("keeps two letters and the domain of an email", () => {
    expect(teamMaskEmail("giang@gmail.com")).toBe("gi···@gmail.com");
    expect(teamMaskEmail("a@x.io")).toBe("a···@x.io");
    expect(teamMaskEmail("not-an-email")).toBe("···");
  });

  it("keeps the first and last four hex digits of a wallet, never the full address", () => {
    const full = "0x3e9a4c7b1d2e3f405162738495a6b7c8d9e011fd";
    const m = teamMaskAddress(full);
    expect(m).toBe("0x3e9a…11fd");
    expect(m).not.toContain(full.slice(6, -4));
    expect(teamMaskAddress("0x12")).toBe("0x…");
  });
});

describe("teamOps group", () => {
  it("is team-only, Telegram-only and on by default", () => {
    expect(groupOf("team_signup")).toBe("teamOps");
    expect(groupOf("team_bot_started")).toBe("teamOps");
    expect(TEAM_ONLY_GROUPS).toContain("teamOps");
    expect(TELEGRAM_ONLY_GROUPS).toContain("teamOps");
    expect(NOTIFICATION_DEFAULTS.teamOps).toEqual({ in_app: false, email: false, telegram: true });
  });
});

describe("team incidents (#241)", () => {
  it("are teamOps types", () => {
    expect(groupOf("team_incident")).toBe("teamOps");
    expect(groupOf("team_incident_digest")).toBe("teamOps");
  });

  it("throttles money incidents per bot and market for 10 minutes and warnings per type for 30, never the position pair", () => {
    const bot = "0b5c1f9e-4a7d-4f00-9c3e-12ab34cd56ef";
    expect(teamIncidentThrottle({ kind: "close_failed", botId: bot, market: "BTC-USD" })).toEqual({
      key: `team:incident:close_failed:${bot}:BTC-USD`,
      ms: 600_000,
    });
    expect(teamIncidentThrottle({ kind: "tick_slow", botId: bot })).toEqual({
      key: "team:incident:tick_slow",
      ms: 1_800_000,
    });
    expect(teamIncidentThrottle({ kind: "position_mismatch", botId: bot })).toBeNull();
    expect(teamIncidentThrottle({ kind: "position_matched", botId: bot })).toBeNull();
    expect(TEAM_INCIDENT_SEVERITY.position_matched).toBe("info");
  });

  it("rejects an unknown kind or a detail that is too long", () => {
    expect(
      teamOpsEventSchema.safeParse({ type: "team_incident", kind: "nope", detail: "" }).success,
    ).toBe(false);
    expect(
      teamOpsEventSchema.safeParse({
        type: "team_incident",
        kind: "tick_slow",
        detail: "x".repeat(201),
      }).success,
    ).toBe(false);
  });
});
