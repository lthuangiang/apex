// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { DeskAiAnswer } from "@drift/shared";
import { act, cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { Answer, greetingAt, ThinkingTurn } from "../components/desk-ai";

// Desk AI (DEC-164/165): câu mẫu khi LLM tắt / hết lượt / ngoài phạm vi chỉ dùng số từ fact; lời LLM hiện nguyên văn.

const show = (answer: DeskAiAnswer) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <Answer answer={answer} />
    </NextIntlClientProvider>,
  );
const goal = (key: "goal_limit" | "goal_used", value: string) => ({
  id: key,
  key,
  bot: null,
  value,
  unit: "usdc" as const,
  source: "goals",
});

afterEach(() => {
  cleanup();
});

describe("Desk AI answer", () => {
  it("shows the model's words as they are", () => {
    show({ kind: "text", text: "Mostly fees, not bad guesses.", facts: [] });
    expect(screen.getByText("Mostly fees, not bad guesses.")).toBeInTheDocument();
  });

  it("answers the safety template with the user's own limit", () => {
    show({
      kind: "template",
      key: "safety",
      params: {},
      facts: [goal("goal_limit", "500"), goal("goal_used", "75")],
    });
    expect(
      screen.getByText(
        "Yes, within limits you set. DeskLabs can only place trades: it can't withdraw or move funds. The most you've agreed to lose is 500 USDC; you've used 75.",
      ),
    ).toBeInTheDocument();
  });

  it("lists the real numbers when the model can't answer, never a made-up one", () => {
    show({
      kind: "template",
      key: "fallback",
      params: {},
      facts: [
        {
          id: "bot_net:a",
          key: "bot_net",
          bot: "ETH Farm",
          value: "-10.09",
          unit: "usdc",
          source: "bot_state",
        },
        {
          id: "bot_stop_pct:a",
          key: "bot_stop_pct",
          bot: "ETH Farm",
          value: "4.761905",
          unit: "pct",
          source: "config",
        },
      ],
    });
    expect(screen.getByText("ETH Farm · profit so far")).toBeInTheDocument();
    expect(screen.getByText("−10.09 USDC")).toBeInTheDocument();
    expect(screen.getByText("4.76%")).toBeInTheDocument();
  });

  it("refuses price predictions and says when the daily limit is reached", () => {
    show({ kind: "template", key: "out_of_scope", params: {}, facts: [] });
    expect(screen.getByText(/can't predict prices/)).toBeInTheDocument();
    cleanup();
    show({ kind: "template", key: "quota", params: { limit: 20 }, facts: [] });
    expect(
      screen.getByText("You've asked 20 questions today. I'll answer more tomorrow."),
    ).toBeInTheDocument();
  });
});

describe("morning brief greeting", () => {
  it("follows the viewer's local time", () => {
    expect(greetingAt(new Date(2026, 10, 12, 8, 0))).toBe("morning");
    expect(greetingAt(new Date(2026, 10, 12, 13, 30))).toBe("afternoon");
    expect(greetingAt(new Date(2026, 10, 12, 22, 5))).toBe("evening");
  });

  it("writes the brief with that greeting", () => {
    show({ kind: "template", key: "brief", params: { count: 1, bot: "Futures Grid" }, facts: [] });
    const word = { morning: "Good morning", afternoon: "Good afternoon", evening: "Good evening" }[
      greetingAt(new Date())
    ];
    expect(
      screen.getByText(`${word}. One thing needs you today: Futures Grid.`),
    ).toBeInTheDocument();
  });
});

describe("thinking indicator", () => {
  it("shows the question at once and says what Desk AI is doing while the answer is slow", () => {
    vi.useFakeTimers();
    try {
      render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <ul>
            <ThinkingTurn question="Why did I lose money?" />
          </ul>
        </NextIntlClientProvider>,
      );
      expect(screen.getByText("Why did I lose money?")).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("Thinking…");
      act(() => {
        vi.advanceTimersByTime(3_500);
      });
      expect(screen.getByRole("status")).toHaveTextContent("Looking at your bots…");
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.getByRole("status")).toHaveTextContent("Writing the answer…");
      act(() => {
        vi.advanceTimersByTime(7_000);
      });
      expect(screen.getByRole("status")).toHaveTextContent("Double-checking the numbers…");
    } finally {
      vi.useRealTimers();
    }
  });
});
