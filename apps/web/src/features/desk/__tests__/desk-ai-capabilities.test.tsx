// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { DeskAiAnswer } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { Answer, DeskAiPanel } from "../components/desk-ai";

// Desk AI nói rõ làm được gì (W6, câu chữ PM duyệt): khối khi khung chat trống, link mở sheet, câu ngoài phạm vi có
// hai câu ví dụ là nút gửi.

interface TestState {
  asked: { body: unknown }[];
}
const state: TestState = vi.hoisted(() => ({ asked: [] }));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (_method: string, path: string, _s: unknown, opts?: { body?: unknown }) => {
      if (path === "/api/v1/desk/ai/brief")
        return Promise.resolve({
          available: true,
          conversationId: null,
          turn: null,
          questionsLeft: 20,
          llm: true,
        });
      if (path === "/api/v1/desk/ai/ask") {
        state.asked.push({ body: opts?.body });
        return Promise.resolve({
          conversationId: "22222222-2222-4222-8222-222222222222",
          questionsLeft: 19,
          turn: {
            id: `33333333-3333-4333-8333-33333333333${String(state.asked.length)}`,
            kind: "question",
            question: (opts?.body as { question: string }).question,
            answer: { kind: "template", key: "out_of_scope", params: {}, facts: [] },
            createdAt: "2026-11-13T08:00:00.000Z",
          },
        });
      }
      return new Promise(() => undefined);
    },
  };
});
vi.mock("../components/paper-result", () => ({ PaperResults: () => null }));
vi.mock("../components/new-bot-chat", () => ({ NewBotChat: () => null }));

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

async function expectNoAxeViolations() {
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

beforeEach(() => {
  state.asked = [];
});
afterEach(() => {
  cleanup();
});

const BLOCK = "How your bots are doing, and why they made or lost money";

describe("Desk AI capabilities (W6)", () => {
  it("shows what Desk AI can help with while the chat is empty, and hides it after the first question", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<DeskAiPanel />);
    expect(await screen.findByText("I can help with")).toBeInTheDocument();
    expect(screen.getByText(BLOCK)).toBeInTheDocument();
    expect(
      screen.getByText(
        "I can’t predict prices, tell you which coin to buy or sell, or change anything for you. I only use your DeskLabs data and SoDEX prices.",
      ),
    ).toBeInTheDocument();
    await expectNoAxeViolations();
    await user.type(
      screen.getByRole("textbox", { name: "Ask Desk AI…" }),
      "Which coin should I buy?",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Which coin should I buy?");
    expect(screen.queryByText(BLOCK)).not.toBeInTheDocument();
  }, 15_000);

  it("opens the same list with the daily limit from the footer link; Esc closes it and focus returns", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<DeskAiPanel />);
    const link = await screen.findByRole("button", { name: "What can Desk AI do?" });
    link.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "I can help with" });
    expect(within(dialog).getByText(BLOCK)).toBeInTheDocument();
    expect(within(dialog).getByText("20 questions a day.")).toBeInTheDocument();
    // Focus nằm trong sheet.
    expect(dialog.contains(document.activeElement)).toBe(true);
    await expectNoAxeViolations();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(link).toHaveFocus();
  }, 15_000);

  it("offers the two example questions as buttons that send exactly that question", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<DeskAiPanel />);
    await user.type(
      await screen.findByRole("textbox", { name: "Ask Desk AI…" }),
      "Will BTC go up?",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    const example = await screen.findByRole("button", { name: "“How’s ETH today?”" });
    await user.click(example);
    await waitFor(() => {
      expect(state.asked.at(-1)?.body).toMatchObject({ question: "How’s ETH today?" });
    });
    const [bots] = screen.getAllByRole("button", { name: "“How are my bots doing?”" });
    if (bots === undefined) throw new Error("example button missing");
    await user.click(bots);
    await waitFor(() => {
      expect(state.asked.at(-1)?.body).toMatchObject({ question: "How are my bots doing?" });
    });
  });

  it("keeps the examples as plain text where there is no chat to send from", () => {
    const answer: DeskAiAnswer = { kind: "template", key: "out_of_scope", params: {}, facts: [] };
    wrap(<Answer answer={answer} />);
    expect(screen.getByText(/^Try:/)).toHaveTextContent(
      "Try: “How are my bots doing?” or “How’s ETH today?”",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
