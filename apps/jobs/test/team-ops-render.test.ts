import { describe, expect, it } from "vitest";

import { MERGED_LINES, renderTelegram, type RenderRow } from "../src/telegram-render";

// Tin báo team (DEC-184): một dòng mỗi sự kiện, gộp cùng loại với tối đa 5 dòng rồi "+N more", nút mở trang Users.

const signup = (i: number): RenderRow => ({
  type: "team_signup",
  data: { email: `u${String(i)}···@gmail.com` },
  botName: null,
});

describe("team ops message", () => {
  it("writes a signup and a SoDEX connection on one line each", () => {
    expect(renderTelegram([signup(1)], "https://desklabs.test/").text).toBe(
      "🆕 <b>New signup</b> · u1···@gmail.com",
    );
    const connected = renderTelegram(
      [
        {
          type: "team_sodex_connected",
          data: { email: "gi···@gmail.com", wallet: "0x3e9a…11fd" },
          botName: null,
        },
      ],
      "https://desklabs.test",
    );
    expect(connected.text).toBe("🔗 <b>SoDEX connected</b> · gi···@gmail.com · 0x3e9a…11fd");
    expect(connected.button).toEqual({
      text: "Open Users",
      url: "https://desklabs.test/admin/users",
    });
  });

  it("leaves out the amount when the engine could not tell it, never writing 0", () => {
    const r = renderTelegram(
      [
        {
          type: "team_bot_started",
          data: {
            email: "gi···@gmail.com",
            botName: "TWAP",
            strategy: "twap",
            market: "BTC-USD",
            capital: null,
            capitalAsset: null,
          },
          botName: null,
        },
      ],
      "https://desklabs.test",
    );
    expect(r.text).toBe("▶️ <b>Bot started</b> · gi···@gmail.com · TWAP · TWAP · BTC-USD");
  });

  it("merges events of one kind into a short list with +N more", () => {
    const rows = Array.from({ length: MERGED_LINES + 2 }, (_, i) => signup(i));
    const r = renderTelegram(rows, "https://desklabs.test");
    const lines = r.text.split("\n");
    expect(lines[0]).toBe(`🆕 <b>${String(rows.length)} new signups</b>`);
    expect(lines).toHaveLength(1 + MERGED_LINES + 1);
    expect(lines.at(-1)).toBe("+2 more");
    expect(r.button.url).toBe("https://desklabs.test/admin/users");
  });

  it("writes the MCP alerts with the approved sentences and an Open Stats button", () => {
    const one = (type: RenderRow["type"], data: Record<string, unknown>) =>
      renderTelegram([{ type, data, botName: null }], "https://desklabs.test");
    const errors = one("team_mcp_tool_errors", {
      calls: 25,
      errors: 5,
      pct: "20",
      tool: "get_bot",
    });
    expect(errors.text).toBe(
      "MCP tools failing: 5 of 25 calls failed in the last 5 minutes (20%). Most failures: get_bot.",
    );
    expect(errors.button).toEqual({ text: "Open Stats", url: "https://desklabs.test/admin/stats" });
    expect(one("team_mcp_introspect_failing", { failures: 12 }).text).toBe(
      "MCP can't check tokens: 12 failures in the last 5 minutes. Claude users see 'temporarily unavailable'.",
    );
    expect(one("team_mcp_daily_limit", { count: 1, emails: "he···@example.com" }).text).toBe(
      "MCP daily limit reached by 1 user: he···@example.com.",
    );
    expect(
      one("team_mcp_daily_limit", { count: 2, emails: "he···@example.com, se···@example.com" })
        .text,
    ).toBe("MCP daily limit reached by 2 users: he···@example.com, se···@example.com.");
  });
});
