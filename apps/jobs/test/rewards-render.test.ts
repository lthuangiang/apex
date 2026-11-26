import { describe, expect, it } from "vitest";

import { emailText } from "../src/notify";
import { renderTelegram } from "../src/telegram-render";

// #558 (DEC-398): tin Telegram / email của nhóm `rewards`. Câu đã duyệt (plan-558 NEW COPY 19–22, 30); không bao giờ có
// địa chỉ ví hay token.

const APP = "https://desklabs.test";
const one = (
  type: Parameters<typeof renderTelegram>[0][number]["type"],
  data: Record<string, unknown>,
) => renderTelegram([{ type, data, botName: null }], APP);

describe("rewards Telegram messages", () => {
  it("claimable boxes (template approved on #558)", () => {
    // "🎁 3 new Blind Boxes to claim" / "Claim them on Rewards." / [ Open Rewards ].
    expect(one("rewards_claimable", { count: 3 }).text).toBe(
      "🎁 <b>3 new Blind Boxes to claim</b>\nClaim them on Rewards.",
    );
    expect(one("rewards_claimable", { count: 1 }).text).toContain("1 new Blind Box to claim");
    expect(one("rewards_claimable", { count: 3 }).button).toEqual({
      text: "Open Rewards",
      url: `${APP}/rewards?tab=boxes`,
    });
    expect(one("rewards_claimable", {}).text).toContain("New Blind Boxes to claim");
  });

  it("received boxes, with the level as SoDEX names it (escaped)", () => {
    expect(
      one("rewards_box_received", { count: 1, levels: [{ level: "Rare", count: 1 }] }).text,
    ).toBe("🎁 <b>You received a Rare box</b>");
    expect(
      one("rewards_box_received", { count: 1, levels: [{ level: "<b>x", count: 1 }] }).text,
    ).toContain("&lt;b&gt;x");
    expect(
      one("rewards_box_received", { count: 1, levels: [{ level: null, count: 1 }] }).text,
    ).toBe("🎁 <b>You received a box</b>");
    expect(one("rewards_box_received", { count: 4, levels: [] }).text).toBe(
      "🎁 <b>You received 4 boxes</b>",
    );
  });

  it("weekly draw: winning tickets when known, otherwise prize received", () => {
    expect(one("rewards_draw_won", { round: 10, boxes: 2, wins: 1, tickets: 27 }).text).toBe(
      "🎉 <b>1 of your 27 tickets won</b>\nWeekly draw · Round 10",
    );
    expect(one("rewards_draw_won", { round: 10, boxes: 1, wins: 1, tickets: 1 }).text).toContain(
      "1 of your 1 ticket won",
    );
    expect(one("rewards_draw_won", { round: null, boxes: 1, wins: null, tickets: null }).text).toBe(
      "🎉 <b>Weekly draw prize received</b>",
    );
  });

  it("paused alerts link to Rewards to sign in again", () => {
    const r = one("rewards_watch_paused", { reason: "expired" });
    expect(r.text).toBe(
      "⏸ <b>New box alerts paused</b>\nYour rewards sign-in expired. Sign in again to turn them back on.",
    );
    expect(r.button.url).toBe(`${APP}/rewards`);
  });
});

describe("rewards emails", () => {
  it("use the approved subjects and no amounts or addresses", () => {
    expect(emailText("rewards_claimable", { count: 2 }, null).subject).toBe(
      "DeskLabs: new SoDEX reward boxes",
    );
    expect(emailText("rewards_box_received", { count: 1 }, null).subject).toBe(
      "DeskLabs: new SoDEX reward boxes",
    );
    expect(emailText("rewards_draw_won", {}, null).subject).toBe("DeskLabs: weekly draw result");
    expect(emailText("rewards_watch_paused", {}, null).subject).toBe(
      "DeskLabs: rewards alerts paused",
    );
  });
});
