import { BotState, ReasonCode } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { botActions } from "../bot-actions";

const t = (k: string) => k;
const bot = (state: string, reasonCode: string | null = null) =>
  ({ id: "b1", state, reasonCode }) as Parameters<typeof botActions>[0];

describe("botActions", () => {
  it("renews the key instead of resuming a key-paused bot", () => {
    const a = botActions(bot(BotState.paused, ReasonCode.apiKeyUnusable), t);
    expect(a.primary).toEqual({ href: "/settings", label: "renewKey" });
    expect(a.more.map((m) => m.label)).toEqual(["open", "edit"]);
  });

  it("resumes a key-paused bot once the current key is active again (renewed)", () => {
    const paused = bot(BotState.paused, ReasonCode.apiKeyUnusable);
    expect(botActions(paused, t, "active").primary).toEqual({ href: "/agent/b1", label: "resume" });
    expect(botActions(paused, t, "unusable").primary.label).toBe("renewKey");
    expect(botActions(paused, t, "expired").primary.label).toBe("renewKey");
  });

  it("resumes other paused bots, with Edit in the menu", () => {
    const a = botActions(bot(BotState.paused, ReasonCode.builderFeeRevoked), t);
    expect(a.primary.label).toBe("resume");
    expect(a.more.map((m) => m.label)).toEqual(["edit"]);
  });

  it("gives drafts and stopped bots a single action", () => {
    expect(botActions(bot(BotState.draft), t)).toEqual({
      primary: { href: "/bots/b1/edit", label: "continue" },
      more: [],
    });
    expect(botActions(bot(BotState.stopped), t).more).toEqual([]);
  });

  it("#472: news bots open in Signal Research instead of Edit / Continue", () => {
    const news = (state: string) =>
      ({ id: "b1", state, reasonCode: null, strategy: "news_signal" }) as Parameters<
        typeof botActions
      >[0];
    const href = "/signal-research?bots=mainnet&bot=b1&settings=1";
    const running = botActions(news(BotState.running), t, null, "Open in Signal Research");
    expect(running.primary).toEqual({ href: "/agent/b1", label: "open" });
    expect(running.more).toEqual([{ href, label: "Open in Signal Research" }]);
    expect(botActions(news(BotState.draft), t, null, "Open in Signal Research")).toEqual({
      primary: { href, label: "Open in Signal Research" },
      more: [],
    });
    expect(
      botActions(news(BotState.paused), t, null, "Open in Signal Research").more.map((m) => m.href),
    ).toEqual([href]);
    // Không có nhãn (gọi cũ) hay chiến lược khác: giữ Edit như trước.
    expect(botActions(bot(BotState.running), t, null, "Open in Signal Research").more).toEqual([
      { href: "/bots/b1/edit", label: "edit" },
    ]);
  });
});
