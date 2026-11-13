import { describe, expect, it } from "vitest";

import { intentOf, templateFacts, type DeskAiFact } from "../desk/ai";

// Câu mẫu của Desk AI chỉ hiện số liên quan tới câu hỏi (DEC-193).

const bot = (id: string, name: string, state: string, net: string | null): DeskAiFact[] => [
  {
    id: `bot_state:${id}`,
    key: "bot_state",
    bot: name,
    value: state,
    unit: "text",
    source: "bot_state",
  },
  ...(net === null
    ? []
    : [
        {
          id: `bot_net:${id}`,
          key: "bot_net" as const,
          bot: name,
          value: net,
          unit: "usdc" as const,
          source: "bot_state",
        },
      ]),
  { id: `bot_fees:${id}`, key: "bot_fees", bot: name, value: "1.2", unit: "usdc", source: "fills" },
  {
    id: `bot_leverage:${id}`,
    key: "bot_leverage",
    bot: name,
    value: "10",
    unit: "x",
    source: "config",
  },
];
const goal: DeskAiFact = {
  id: "goal_limit",
  key: "goal_limit",
  bot: null,
  value: "500",
  unit: "usdc",
  source: "goals",
};
const facts = [
  ...bot("a", "Futures Grid", "paused", "-5.03"),
  ...bot("b", "BTC", "archived", "-40"),
  ...bot("c", "ETH DCA", "running", "2"),
  ...bot("d", "SOL Grid", "stopped", "-0.5"),
  ...bot("e", "NVDA MM", "stopped", null),
  goal,
];
const bots = (fs: DeskAiFact[]) => [...new Set(fs.map((f) => f.bot))];

describe("templateFacts", () => {
  it("keeps only the bot the question names", () => {
    expect(bots(templateFacts("Why did my futures grid lose money?", facts))).toEqual([
      "Futures Grid",
    ]);
  });

  it("names an archived bot only when asked about it", () => {
    expect(bots(templateFacts("How did BTC do?", facts))).toEqual(["BTC"]);
    expect(bots(templateFacts("How are my bots?", facts))).not.toContain("BTC");
  });

  it("shows at most 3 bots, biggest profit or loss first, never goal or quota facts", () => {
    const out = templateFacts("How are my bots?", facts);
    expect(bots(out)).toEqual(["Futures Grid", "ETH DCA", "SOL Grid"]);
    expect(out.some((f) => f.bot === null)).toBe(false);
  });

  it("shows state, profit and fees only, for any question", () => {
    const out = templateFacts("Why did I lose money?", facts);
    expect(new Set(out.map((f) => f.key))).toEqual(new Set(["bot_state", "bot_net", "bot_fees"]));
    expect(new Set(templateFacts("How are my bots?", facts).map((f) => f.key))).toEqual(
      new Set(["bot_state", "bot_net", "bot_fees"]),
    );
    expect(new Set(out.map((f) => f.key))).toEqual(new Set(["bot_state", "bot_net", "bot_fees"]));
  });

  it("reads loss questions as their own intent", () => {
    expect(intentOf("Why did I lose money?")).toBe("loss");
    expect(intentOf("Is my money safe?")).toBe("safety");
  });
});
