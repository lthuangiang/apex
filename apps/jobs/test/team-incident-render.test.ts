import { describe, expect, it } from "vitest";

import { renderTelegram, type RenderRow } from "../src/telegram-render";

// Tin sự cố tiền thật cho team (#241): mức độ + loại, nơi xảy ra (bot id rút gọn), số liệu, link trang bot / SoDEX Debugger /
// Bot Monitor. Không bao giờ email, ví đầy đủ, key, tên bot.

const BOT = "0b5c1f9e-4a7d-4f00-9c3e-12ab34cd56ef";
const BASE = "https://desklabs.test/";

const incident = (data: Record<string, unknown>): RenderRow => ({
  type: "team_incident",
  data,
  botName: null,
});

describe("team incident message", () => {
  it("writes a critical position mismatch with the bot, numbers and links", () => {
    const r = renderTelegram(
      [
        incident({
          kind: "position_mismatch",
          severity: "critical",
          botId: BOT,
          strategy: "volume_farm",
          market: "BTC-USD",
          detail: "real 5 vs ledger 2 · cause trades",
        }),
      ],
      BASE,
    );
    expect(r.text).toBe(
      [
        "🚨 CRITICAL · <b>Position doesn't match</b>",
        "Volume Builder · BTC-USD · bot ··34cd56ef",
        "real 5 vs ledger 2 · cause trades",
        `<a href="https://desklabs.test/agent/${BOT}">Bot page</a> · <a href="https://desklabs.test/admin/sodex-debugger?botId=${BOT}">SoDEX Debugger</a> · <a href="https://desklabs.test/admin/bot-monitor">Bot Monitor</a>`,
      ].join("\n"),
    );
    expect(r.button).toEqual({
      text: "Open Bot Monitor",
      url: "https://desklabs.test/admin/bot-monitor",
    });
  });

  it("writes a warning without a bot and opens the SoDEX Debugger on errors for SoDEX problems", () => {
    const r = renderTelegram(
      [
        incident({
          kind: "sodex_errors",
          severity: "warning",
          botId: null,
          strategy: null,
          market: null,
          detail: "18 of 140 REST calls failed in 10 min (13%) · most: /perps/orders",
        }),
      ],
      BASE,
    );
    expect(r.text).toBe(
      [
        "⚠️ WARNING · <b>SoDEX errors spiking</b>",
        "18 of 140 REST calls failed in 10 min (13%) · most: /perps/orders",
        '<a href="https://desklabs.test/admin/bot-monitor">Bot Monitor</a>',
      ].join("\n"),
    );
    expect(r.button.url).toBe("https://desklabs.test/admin/sodex-debugger?show=errors");
  });

  it("writes the cleared position as info", () => {
    const r = renderTelegram(
      [
        incident({
          kind: "position_matched",
          botId: BOT,
          market: "ETH-USD",
          detail: "real 1 matches the ledger",
        }),
      ],
      BASE,
    );
    expect(r.text.split("\n")[0]).toBe("✅ INFO · <b>Position matches again</b>");
  });

  it("escapes data and never builds a link from something that is not a bot id", () => {
    const r = renderTelegram(
      [
        incident({
          kind: "late_fill",
          botId: 'x" onclick="evil',
          market: "<b>X</b>",
          detail: "a < b & c",
        }),
      ],
      BASE,
    );
    expect(r.text).toContain("&lt;b&gt;X&lt;/b&gt;");
    expect(r.text).toContain("a &lt; b &amp; c");
    expect(r.text).not.toContain("onclick");
    expect(r.text).not.toContain("/agent/");
  });

  it("merges incidents into one message, keeping each bot link", () => {
    const rows = [
      incident({
        kind: "paused_errors",
        botId: BOT,
        market: "BTC-USD",
        detail: "API_KEY_UNUSABLE",
      }),
      incident({ kind: "tick_slow", detail: "4 slow ticks in 10 min" }),
    ];
    const r = renderTelegram(rows, BASE);
    expect(r.text).toBe(
      [
        "🚨 <b>2 incidents</b>",
        `• 🚨 CRITICAL · Bot paused by errors · BTC-USD · bot ··${BOT.slice(-8)} · API_KEY_UNUSABLE · <a href="https://desklabs.test/agent/${BOT}">Bot page</a>`,
        "• ⚠️ WARNING · Engine ticks slow · 4 slow ticks in 10 min",
      ].join("\n"),
    );
  });

  it("writes the daily digest, worst first, or says there were none", () => {
    const r = renderTelegram(
      [
        {
          type: "team_incident_digest",
          data: { tick_slow: 3, position_mismatch: 2, position_matched: 2, close_failed: 0 },
          botName: null,
        },
      ],
      BASE,
    );
    expect(r.text).toBe(
      [
        "📋 <b>Daily incidents · last 24 h</b>",
        "• 2 × Position doesn't match (critical)",
        "• 3 × Engine ticks slow (warning)",
        "• 2 × Position matches again (info)",
      ].join("\n"),
    );
    expect(
      renderTelegram([{ type: "team_incident_digest", data: {}, botName: null }], BASE).text,
    ).toBe("📋 <b>Daily incidents · last 24 h</b>\nNo incidents in the last 24 h.");
  });
});
