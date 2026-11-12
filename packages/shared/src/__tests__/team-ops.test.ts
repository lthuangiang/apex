import { describe, expect, it } from "vitest";

import {
  groupOf,
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
