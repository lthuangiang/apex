import { describe, expect, it } from "vitest";

import {
  NOTIFICATION_GROUPS,
  notificationSettingsBodySchema,
  notificationSettingsSchema,
  SETTINGS_NOTIFICATION_GROUPS,
  SYSTEM_GROUPS,
} from "../api/notifications";

// #558: nhóm của bảng cài đặt suy từ NOTIFICATION_GROUPS (trừ nhóm hệ thống), nên thêm nhóm mới không bị sót schema.

describe("SETTINGS_NOTIFICATION_GROUPS", () => {
  it("is every notification group except system groups, including rewards", () => {
    expect([...SETTINGS_NOTIFICATION_GROUPS].sort()).toEqual(
      Object.keys(NOTIFICATION_GROUPS)
        .filter((g) => !(SYSTEM_GROUPS as readonly string[]).includes(g))
        .sort(),
    );
    expect(SETTINGS_NOTIFICATION_GROUPS).toContain("rewards");
    expect(SETTINGS_NOTIFICATION_GROUPS).not.toContain("telegram");
  });

  it("parses settings and bodies for the rewards group", () => {
    expect(
      notificationSettingsSchema.parse({
        groups: [{ group: "rewards", alwaysOn: false, in_app: true, email: false, telegram: true }],
      }).groups[0]?.group,
    ).toBe("rewards");
    expect(
      notificationSettingsBodySchema.safeParse({
        group: "rewards",
        channel: "email",
        enabled: true,
      }).success,
    ).toBe(true);
    expect(
      notificationSettingsBodySchema.safeParse({
        group: "telegram",
        channel: "email",
        enabled: true,
      }).success,
    ).toBe(false);
  });
});
