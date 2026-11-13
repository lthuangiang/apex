import { describe, expect, it } from "vitest";

import {
  ALERT_GLOBAL_PER_SEC,
  NORMAL_GLOBAL_PER_SEC,
  reserveSend,
  subjectFor,
  TELEGRAM_ALERT_SUBJECT,
  TELEGRAM_SUBJECT,
  type Counter,
} from "../src/telegram";
import { renderTelegram, type RenderRow } from "../src/telegram-render";

// Nội dung tin Telegram và giới hạn gửi (docs/NOTIFICATIONS.md mục 5, 6; DEC-170). Không cần Postgres.

const APP = "https://desklabs.test";
const BOT = "6f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const row = (
  type: RenderRow["type"],
  data: Record<string, unknown> = {},
  botName: string | null = "BTC Volume Farm",
): RenderRow => ({
  type,
  data,
  botName,
});

describe("renderTelegram: one event", () => {
  it("bot paused: title, reason, one URL button to the Trading Agent", () => {
    const m = renderTelegram(
      [row("bot_paused", { botId: BOT, reasonCode: "RISK_DAILY_LOSS" })],
      APP,
    );
    expect(m.text).toBe(
      "🔴 <b>BTC Volume Farm paused</b>\nDaily loss limit reached. Open orders were kept.",
    );
    expect(m.button).toEqual({ text: "Review in DeskLabs", url: `${APP}/agent/${BOT}` });
  });

  it("escapes the bot name so it can't become a tag or link", () => {
    const m = renderTelegram(
      [row("bot_stopped", { botId: BOT, reasonCode: "STOP_LOSS" }, `<a href="x">Evil & Co</a>`)],
      APP,
    );
    expect(m.text).toContain('&lt;a href="x"&gt;Evil &amp; Co&lt;/a&gt;');
    expect(m.text).not.toContain("<a ");
  });

  it("fake-money bots say so and open AI Desk (DEC-105)", () => {
    const m = renderTelegram(
      [row("bot_paused", { botId: BOT, paper: true, reasonCode: "STOP_LOSS" })],
      APP,
    );
    expect(m.text).toBe(
      "🧪 <b>Fake-money test BTC Volume Farm paused</b>\nNo real money was used.",
    );
    expect(m.button.url).toBe(`${APP}/desk`);
  });

  it("unknown order, risk and key/fee go to the right screen", () => {
    expect(renderTelegram([row("unknown_order", { botId: BOT })], APP)).toEqual({
      text: "⚠️ <b>Order result unknown · BTC Volume Farm</b>\nSoDEX didn't confirm an order. DeskLabs won't resend it until SoDEX confirms.",
      button: { text: "Open Trading Agent", url: `${APP}/agent/${BOT}` },
    });
    const risk = renderTelegram(
      [row("risk_alert", { kind: "max_drawdown", drawdownPct: "12.5" })],
      APP,
    );
    expect(risk.text).toBe(
      "🛡 <b>Risk limit reached</b>\nYour drawdown limit was hit. Running bots were paused.",
    );
    expect(risk.button.url).toBe(`${APP}/risk`);
    expect(renderTelegram([row("key_fee")], APP).button.url).toBe(`${APP}/settings`);
  });

  it("uses 'A bot' when the name is unknown, never an id", () => {
    const m = renderTelegram([row("bot_paused", { botId: BOT }, null)], APP);
    expect(m.text).toBe("🔴 <b>A bot paused</b>\nOpen orders were kept.");
    expect(m.text).not.toContain(BOT);
  });

  it("never sends wallet addresses, keys or secrets from the payload", () => {
    const m = renderTelegram(
      [
        row("leader_big_move", {
          address: "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db",
          coin: "BTC",
          apiKey: "secret-key",
        }),
      ],
      APP,
    );
    expect(m.text).not.toMatch(/0x[0-9a-fA-F]{8,}/);
    expect(m.text).not.toContain("secret");
    expect(m.text).toBe("👤 <b>A trader you follow made a big move</b>\nMarket: BTC.");
  });
});

describe("renderTelegram: follow position alerts (DEC-TBD-follow-alerts)", () => {
  it("says what changed without the trader's wallet address", () => {
    const m = renderTelegram(
      [
        row(
          "leader_position",
          {
            address: "0x84b2b687df7c99702e887849f8d99bfb0fed12f2",
            coin: "NEAR",
            kind: "open",
            side: "short",
          },
          null,
        ),
      ],
      APP,
    );
    expect(m.text).toBe(
      "👤 <b>A trader you follow opened a short on NEAR</b>\nFollowing only. Nothing was copied.",
    );
    expect(m.text).not.toMatch(/0x[0-9a-fA-F]{4,}/);
    expect(m.button).toEqual({ text: "Open Following", url: `${APP}/following` });
    const closed = renderTelegram(
      [row("leader_position", { coin: "ARB", kind: "close", side: "short" }, null)],
      APP,
    );
    expect(closed.text).toContain("closed their short on ARB");
  });
});

describe("renderTelegram: merged (mục 5)", () => {
  it("3 bots paused for the same reason → one line", () => {
    const m = renderTelegram(
      [
        row("bot_paused", { botId: BOT, reasonCode: "BUILDER_FEE_REVOKED" }),
        row("bot_paused", { botId: "b2", reasonCode: "BUILDER_FEE_REVOKED" }, "ETH Grid"),
        row("bot_paused", { botId: "b3", reasonCode: "BUILDER_FEE_REVOKED" }, "SOL DCA"),
      ],
      APP,
    );
    expect(m.text).toBe("🔴 <b>3 bots paused: builder fee approval is 0.</b>");
    expect(m.button).toEqual({ text: "Review in DeskLabs", url: `${APP}/agent` });
  });

  it("mixed bot problems → a list, capped with +N more", () => {
    const rows = [
      row("bot_paused", { reasonCode: "STOP_LOSS" }, "A1"),
      row("unknown_order", {}, "A2"),
      row("bot_stopped", {}, "A3"),
      row("bot_paused", { reasonCode: "RISK_DAILY_LOSS" }, "A4"),
      row("bot_paused", { reasonCode: "ORDER_REJECTED" }, "A5"),
      row("bot_paused", { reasonCode: "STOP_LOSS" }, "A6"),
      row("bot_paused", { reasonCode: "STOP_LOSS" }, "A7"),
    ];
    const m = renderTelegram(rows, APP);
    const lines = m.text.split("\n");
    expect(lines[0]).toBe("🔴 <b>7 bot problems</b>");
    expect(lines[1]).toBe("• 🔴 A1 paused");
    expect(lines.at(-1)).toBe("+2 more");
    expect(lines).toHaveLength(1 + 5 + 1);
  });
});

describe("rate limits (mục 6)", () => {
  function memoryCounter(): Counter {
    const m = new Map<string, number>();
    return {
      incr(key) {
        const v = (m.get(key) ?? 0) + 1;
        m.set(key, v);
        return Promise.resolve(v);
      },
    };
  }

  it("lets one message per second through to a chat", async () => {
    const c = memoryCounter();
    const t = 1_700_000_000_250;
    expect(await reserveSend(c, 42, true, t)).toBe(0);
    expect(await reserveSend(c, 42, true, t + 100)).toBe(650);
    expect(await reserveSend(c, 43, true, t + 100)).toBe(0);
    expect(await reserveSend(c, 42, true, t + 1_000)).toBe(0);
  });

  it("keeps headroom for bot problems in the global budget", async () => {
    const c = memoryCounter();
    const t = 1_700_000_000_000;
    for (let i = 0; i < NORMAL_GLOBAL_PER_SEC; i += 1)
      expect(await reserveSend(c, i, false, t)).toBe(0);
    expect(await reserveSend(c, 1000, false, t)).toBeGreaterThan(0);
    // Bot problems vẫn còn chỗ tới 30/giây.
    let urgentOk = 0;
    for (let i = 0; i < 20; i += 1)
      if ((await reserveSend(c, 2000 + i, true, t)) === 0) urgentOk += 1;
    expect(urgentOk).toBe(ALERT_GLOBAL_PER_SEC - NORMAL_GLOBAL_PER_SEC - 1);
  });

  it("sends bot problems on the priority subject", () => {
    expect(subjectFor("bot_paused")).toBe(TELEGRAM_ALERT_SUBJECT);
    expect(subjectFor("unknown_order")).toBe(TELEGRAM_ALERT_SUBJECT);
    expect(subjectFor("risk_alert")).toBe(TELEGRAM_SUBJECT);
    expect(subjectFor("daily_summary")).toBe(TELEGRAM_SUBJECT);
  });
});
