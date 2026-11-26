import { describe, expect, it } from "vitest";

import { groupOf, NOTIFICATION_DEFAULTS, NOTIFICATION_TYPES } from "../api/notifications";
import {
  REWARDS_JWT_MAX_LENGTH,
  REWARDS_NOTIFICATION_DEFAULTS,
  REWARDS_NOTIFICATION_TYPES,
  REWARDS_TOAST_TYPES,
  rewardsWatchEnableBodySchema,
  rewardsWatchStateSchema,
} from "../api/rewards-watch";
import { ERROR_HTTP_STATUS, ErrorCode } from "../errors";

// #558 PR1 (DEC-398): schema và hằng của báo box mới SoDEX rewards. Token mẫu là chuỗi giả, không phải JWT thật.
const FAKE_JWT = "aaaa.bbbb.cccc";
// Địa chỉ giả, không phải ví của ai.
const ADDRESS = "0x0000000000000000000000000000000000000001";

describe("rewardsWatchEnableBodySchema", () => {
  it("accepts a JWT-shaped token and an address", () => {
    expect(rewardsWatchEnableBodySchema.parse({ token: FAKE_JWT, address: ADDRESS })).toEqual({
      token: FAKE_JWT,
      address: ADDRESS,
    });
  });

  it("rejects tokens that are not three base64url parts, too long, or extra fields", () => {
    for (const token of ["opaque", "a.b", "a.b.c.d", "a b.c.d", "a.b+c.d"]) {
      expect(rewardsWatchEnableBodySchema.safeParse({ token, address: ADDRESS }).success).toBe(
        false,
      );
    }
    const long = `${"a".repeat(REWARDS_JWT_MAX_LENGTH)}.b.c`;
    expect(rewardsWatchEnableBodySchema.safeParse({ token: long, address: ADDRESS }).success).toBe(
      false,
    );
    expect(
      rewardsWatchEnableBodySchema.safeParse({ token: FAKE_JWT, address: ADDRESS, extra: 1 })
        .success,
    ).toBe(false);
    expect(
      rewardsWatchEnableBodySchema.safeParse({ token: FAKE_JWT, address: "0x12" }).success,
    ).toBe(false);
  });
});

describe("rewardsWatchStateSchema", () => {
  it("parses off / active / paused states", () => {
    expect(
      rewardsWatchStateSchema.parse({
        status: "off",
        reason: null,
        expiresAt: null,
        lastCheckedAt: null,
        delayed: false,
      }).status,
    ).toBe("off");
    expect(
      rewardsWatchStateSchema.parse({
        status: "paused",
        reason: "expired",
        expiresAt: "2026-12-11T07:02:00.000Z",
        lastCheckedAt: "2026-12-11T06:50:00.000Z",
        delayed: false,
      }).reason,
    ).toBe("expired");
    expect(
      rewardsWatchStateSchema.safeParse({
        status: "on",
        reason: null,
        expiresAt: null,
        lastCheckedAt: null,
        delayed: false,
      }).success,
    ).toBe(false);
  });
});

describe("rewards notification constants", () => {
  it("are notification types of the rewards group (#558 PR4)", () => {
    for (const t of REWARDS_NOTIFICATION_TYPES) {
      expect((NOTIFICATION_TYPES as readonly string[]).includes(t)).toBe(true);
      expect(groupOf(t)).toBe("rewards");
    }
    expect(NOTIFICATION_DEFAULTS.rewards).toEqual(REWARDS_NOTIFICATION_DEFAULTS);
  });

  it("default to in-app only and toast only received boxes and draw wins", () => {
    expect(REWARDS_NOTIFICATION_DEFAULTS).toEqual({ in_app: true, email: false, telegram: true });
    expect(REWARDS_TOAST_TYPES).toEqual(["rewards_box_received", "rewards_draw_won"]);
  });
});

describe("rewards error codes", () => {
  it("map to HTTP statuses", () => {
    expect(ERROR_HTTP_STATUS[ErrorCode.rewardsWalletMismatch]).toBe(422);
    expect(ERROR_HTTP_STATUS[ErrorCode.rewardsTokenInvalid]).toBe(422);
    expect(ERROR_HTTP_STATUS[ErrorCode.rewardsWatchUnavailable]).toBe(503);
  });
});
