import { describe, expect, it } from "vitest";

import {
  actionOf,
  badgeText,
  isIncident,
  isQuiet,
  mergeToast,
  needsYou,
  newAlerts,
  splitByDay,
  targetOf,
  type NotificationItem,
} from "../model";

const BOT = "6f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

function n(
  id: string,
  type: NotificationItem["type"],
  createdAt: string,
  extra: Partial<NotificationItem> = {},
): NotificationItem {
  return { id, type, data: {}, createdAt, readAt: null, ...extra };
}

describe("needsYou", () => {
  it("keeps only unread bot problems and risk", () => {
    const items = [
      n("a", "bot_paused", "2026-11-12T03:00:00Z"),
      n("b", "risk_alert", "2026-11-12T03:00:00Z"),
      n("c", "unknown_order", "2026-11-12T03:00:00Z", { readAt: "2026-11-12T04:00:00Z" }),
      n("d", "key_fee", "2026-11-12T03:00:00Z"),
      n("e", "daily_summary", "2026-11-12T03:00:00Z"),
      n("f", "bot_stopped", "2026-11-12T03:00:00Z"),
    ];
    expect(needsYou(items).map((x) => x.id)).toEqual(["a", "b", "f"]);
  });
});

describe("isIncident / isQuiet (DEC-TBD-inapp-needs-you)", () => {
  const at = "2026-11-12T03:00:00Z";
  it("treats real problems as incidents", () => {
    for (const reasonCode of [
      "RISK_DAILY_LOSS",
      "STOP_LOSS",
      "BUILDER_FEE_REVOKED",
      "EMERGENCY_HALT",
    ])
      expect(isIncident(n("a", "bot_paused", at, { data: { reasonCode } }))).toBe(true);
    expect(isIncident(n("a", "bot_stopped", at))).toBe(true);
    expect(isIncident(n("a", "unknown_order", at))).toBe(true);
    expect(isIncident(n("a", "risk_alert", at))).toBe(true);
  });

  it("does not treat a planned finish as an incident", () => {
    for (const reasonCode of ["BUDGET_DONE", "MAX_CYCLES", "TAKE_PROFIT"]) {
      const x = n("a", "bot_stopped", at, { data: { reasonCode } });
      expect(isIncident(x)).toBe(false);
      expect(isQuiet(x)).toBe(true);
    }
  });

  it("does not treat fake-money bots as incidents, whatever the reason", () => {
    const x = n("a", "bot_paused", at, { data: { paper: true, reasonCode: "RISK_DAILY_LOSS" } });
    expect(isIncident(x)).toBe(false);
    expect(isQuiet(x)).toBe(true);
    expect(isIncident(n("a", "unknown_order", at, { data: { paper: true } }))).toBe(false);
  });

  it("other groups are neither incidents nor quiet alerts", () => {
    expect(isIncident(n("a", "key_fee", at))).toBe(false);
    expect(isQuiet(n("a", "key_fee", at))).toBe(false);
  });

  it("Needs you and toasts skip planned finishes and fake money", () => {
    const items = [
      n("real", "bot_paused", at, { data: { reasonCode: "RISK_DAILY_LOSS" } }),
      n("budget", "bot_stopped", at, { data: { reasonCode: "BUDGET_DONE" } }),
      n("cycles", "bot_stopped", at, { data: { reasonCode: "MAX_CYCLES" } }),
      n("tp", "bot_stopped", at, { data: { reasonCode: "TAKE_PROFIT" } }),
      n("paper", "bot_paused", at, { data: { paper: true, reasonCode: "STOP_LOSS" } }),
    ];
    expect(needsYou(items).map((x) => x.id)).toEqual(["real"]);
    const first = newAlerts(null, []);
    expect(newAlerts(first.seen, items).fresh.map((x) => x.id)).toEqual(["real"]);
  });
});

describe("splitByDay", () => {
  it("splits by the calendar day in the user's time zone, not UTC", () => {
    // 2026-11-12 08:00 ở Hồ Chí Minh = 01:00 UTC. 23:30 UTC hôm trước = 06:30 cùng ngày ở HCM.
    const now = new Date("2026-11-12T01:00:00Z");
    const items = [
      n("today", "bot_paused", "2026-11-11T23:30:00Z"),
      n("earlier", "bot_paused", "2026-11-11T16:59:00Z"),
    ];
    const hcm = splitByDay(items, now, "Asia/Ho_Chi_Minh");
    expect(hcm.today.map((x) => x.id)).toEqual(["today"]);
    expect(hcm.earlier.map((x) => x.id)).toEqual(["earlier"]);
    const utc = splitByDay(items, now, "UTC");
    expect(utc.today).toEqual([]);
    expect(utc.earlier.map((x) => x.id)).toEqual(["today", "earlier"]);
  });
});

describe("targetOf", () => {
  it("opens the matching screen", () => {
    const at = "2026-11-12T01:00:00Z";
    expect(targetOf(n("a", "bot_paused", at, { data: { botId: BOT } }), true)).toBe(
      `/agent/${BOT}`,
    );
    expect(targetOf(n("a", "unknown_order", at), false)).toBe("/agent");
    expect(targetOf(n("a", "risk_alert", at), false)).toBe("/risk");
    expect(targetOf(n("a", "key_fee", at), false)).toBe("/settings");
    expect(targetOf(n("a", "daily_summary", at), true)).toBe("/desk");
    expect(targetOf(n("a", "daily_summary", at), false)).toBe("/");
    expect(targetOf(n("a", "leader_big_move", at), true)).toBe("/following");
  });

  it("sends fake-money bots to AI Desk, never to Trading Agent", () => {
    const paper = n("a", "bot_paused", "2026-11-12T01:00:00Z", {
      data: { botId: BOT, paper: true },
    });
    expect(targetOf(paper, true)).toBe("/desk");
  });

  it("does not let a crafted bot id change the path", () => {
    const bad = n("a", "bot_paused", "2026-11-12T01:00:00Z", { data: { botId: "../settings" } });
    expect(targetOf(bad, false)).toBe("/agent/..%2Fsettings");
  });
});

describe("actionOf", () => {
  it("uses Review for problems, See AI Desk for the brief, Open otherwise", () => {
    expect(actionOf({ type: "bot_paused" }, false)).toBe("review");
    expect(actionOf({ type: "risk_alert" }, false)).toBe("review");
    expect(actionOf({ type: "unknown_order" }, false)).toBe("open");
    expect(actionOf({ type: "daily_summary" }, true)).toBe("seeDesk");
    expect(actionOf({ type: "daily_summary" }, false)).toBe("open");
  });
});

describe("newAlerts", () => {
  const at = "2026-11-12T01:00:00Z";
  it("does not toast what was already there on the first load", () => {
    const r = newAlerts(null, [n("a", "bot_paused", at)]);
    expect(r.fresh).toEqual([]);
    expect([...r.seen]).toEqual(["a"]);
  });

  it("toasts only new unread bot problems and risk", () => {
    const first = newAlerts(null, [n("a", "bot_paused", at)]);
    const r = newAlerts(first.seen, [
      n("b", "risk_alert", at),
      n("c", "key_fee", at),
      n("d", "bot_stopped", at, { readAt: at }),
      n("a", "bot_paused", at),
    ]);
    expect(r.fresh.map((x) => x.id)).toEqual(["b"]);
    expect(r.seen.has("c")).toBe(true);
  });
});

describe("mergeToast", () => {
  it("keeps one toast with newest first and no duplicates", () => {
    const at = "2026-11-12T01:00:00Z";
    const merged = mergeToast(
      [n("a", "bot_paused", at), n("b", "bot_paused", at)],
      [n("c", "risk_alert", at), n("a", "bot_paused", at)],
    );
    expect(merged.map((x) => x.id)).toEqual(["c", "a", "b"]);
  });
});

describe("badgeText", () => {
  it("hides at zero and caps at 9+", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(3)).toBe("3");
    expect(badgeText(12)).toBe("9+");
  });
});
