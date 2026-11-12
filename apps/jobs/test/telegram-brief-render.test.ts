import { describe, expect, it } from "vitest";

import { renderTelegram } from "../src/telegram-render";

// Morning brief qua Telegram (N4, DEC-194): lời Desk AI hoặc câu mẫu, luôn escape, nút "Open AI Desk".

const APP = "https://desklabs.test";
const brief = (data: Record<string, unknown>) =>
  renderTelegram([{ type: "daily_summary", data, botName: null }], APP);

describe("renderTelegram: morning brief", () => {
  it("sends Desk AI's words, escaped, with one button to AI Desk", () => {
    const m = brief({
      localDate: "2026-11-13",
      text: "Good morning. <b>ETH Grid</b> & co are fine.",
    });
    expect(m.text).toBe(
      "✦ <b>Good morning</b>\nGood morning. &lt;b&gt;ETH Grid&lt;/b&gt; &amp; co are fine.",
    );
    expect(m.button).toEqual({ text: "Open AI Desk", url: `${APP}/desk` });
  });

  it("falls back to the web brief template, with the bot name escaped", () => {
    expect(brief({ localDate: "2026-11-13", count: 0, bot: "" }).text).toBe(
      "✦ <b>Good morning</b>\nGood morning. Nothing needs you today.",
    );
    expect(brief({ localDate: "2026-11-13", count: 1, bot: "<BTC>" }).text).toBe(
      "✦ <b>Good morning</b>\nGood morning. One thing needs you today: &lt;BTC&gt;.",
    );
    expect(brief({ localDate: "2026-11-13", count: 3, bot: "ETH Grid" }).text).toBe(
      "✦ <b>Good morning</b>\nGood morning. 3 things need you today, starting with ETH Grid.",
    );
    // Payload cũ không có lời hay số việc.
    expect(brief({}).text).toBe("✦ <b>Good morning</b>\nYour morning brief is ready in DeskLabs.");
  });
});
