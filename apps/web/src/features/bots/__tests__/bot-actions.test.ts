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
});
