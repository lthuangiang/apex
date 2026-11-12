// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";

// AI Desk B+ PR 4b: ✦ "Ask about this" gửi đúng ngữ cảnh và chỉ hiện khi bật AI Desk; tạo bot qua chat chỉ dẫn tới
// thử tiền ảo; kết quả tiền ảo chỉ báo khi đủ ngày và mở luồng "Use real money" hiện có.

const calls: { method: string; path: string; body: unknown }[] = [];
const state = vi.hoisted(() => ({ aiDesk: true, verdict: "made" }));
const answer = {
  conversationId: "00000000-0000-4000-8000-000000000009",
  questionsLeft: 19,
  turn: {
    id: "00000000-0000-4000-8000-00000000000a",
    kind: "question",
    question: "q",
    answer: { kind: "text", text: "The bot skipped because the price moved away.", facts: [] },
    createdAt: "2026-11-12T00:00:00.000Z",
  },
};
const paperBot = {
  id: "00000000-0000-4000-8000-0000000000b1",
  name: "Spot Grid · ETH",
  strategy: "spot_grid",
  market: "vETH_vUSDC",
  state: "running",
  mode: "paper",
};
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: (
    method: string,
    path: string,
    schema: { parse: (x: unknown) => unknown },
    o?: { body?: unknown },
  ) => {
    calls.push({ method, path, body: o?.body });
    if (path === "/api/v1/desk/ai/ask") return Promise.resolve(answer);
    if (path === "/api/v1/goals") return Promise.resolve({ goals: null });
    if (path === "/api/v1/reco/plan")
      return Promise.resolve({ best: null, notSuggested: [], notes: [] });
    if (path === "/api/v1/desk/bots")
      return Promise.resolve({ notes: [], paper: [{ bot: paperBot, day: 7, net: "2.4" }] });
    if (path.startsWith("/api/v1/desk/paper/"))
      return Promise.resolve({
        bot: paperBot,
        day: 7,
        capital: "300",
        net: "2.4",
        fills: 41,
        verdict: state.verdict,
        hold: { asset: "ETH", amount: "-1.1", changePct: "-0.4" },
      });
    return new Promise(() => undefined);
  },
}));
vi.mock("@/lib/queries", () => ({
  useFeatures: () => ({ data: { aiDesk: state.aiDesk } }),
  useSodexConnection: () => ({ data: null }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { AskAboutThis } = await import("../components/ask-about-this");
const { NewBotChat } = await import("../components/new-bot-chat");
const { PaperResults } = await import("../components/paper-result");

let qc: QueryClient;
const wrap = (node: ReactNode) => (
  <QueryClientProvider client={qc}>
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>
  </QueryClientProvider>
);
beforeEach(() => {
  calls.length = 0;
  state.aiDesk = true;
  state.verdict = "made";
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => {
  cleanup();
});

const ctx = {
  kind: "decision" as const,
  botId: "00000000-0000-4000-8000-000000000001",
  eventId: "00000000-0000-4000-8000-000000000002",
};

describe("✦ Ask about this", () => {
  it("opens without asking, then asks once with the decision as context when the chip is tapped", async () => {
    render(wrap(<AskAboutThis context={ctx} subtitle="Skipped entry · 14:02 · BTC Farm" />));
    fireEvent.click(screen.getByRole("button", { name: "Ask Desk AI about this" }));
    expect(await screen.findByText("About this decision")).toBeInTheDocument();
    // Mở sheet: không gọi API, không tốn lượt.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.path === "/api/v1/desk/ai/ask")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Explain this decision" }));
    expect(
      await screen.findByText("The bot skipped because the price moved away."),
    ).toBeInTheDocument();
    const asks = calls.filter((c) => c.path === "/api/v1/desk/ai/ask");
    expect(asks).toHaveLength(1);
    expect(asks[0]?.body).toMatchObject({ question: "Explain this decision", context: ctx });
    expect(screen.getByText("About this decision")).toBeInTheDocument();
  });

  it("is not shown when AI Desk is off for the account", () => {
    state.aiDesk = false;
    render(wrap(<AskAboutThis context={ctx} />));
    expect(screen.queryByRole("button", { name: "Ask Desk AI about this" })).toBeNull();
  });
});

describe("new bot in chat", () => {
  it("asks the three questions, maps 'Not sure' to a steady goal, and never offers real money", async () => {
    render(wrap(<NewBotChat />));
    fireEvent.click(await screen.findByRole("button", { name: "Not sure, you pick" }));
    fireEvent.click(screen.getByRole("button", { name: "Some · 10%" }));
    fireEvent.change(screen.getByLabelText("Amount in USDC"), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === "/api/v1/reco/plan")).toBe(true);
    });
    const plan = calls.find((c) => c.path === "/api/v1/reco/plan");
    expect(plan?.body).toMatchObject({
      context: "desk",
      goals: { goal: "steady", maxDrop: "10", capital: "300" },
    });
    expect(screen.queryByText(/real money/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Change something" })).toBeInTheDocument();
  });
});

describe("fake-money result", () => {
  it("reports a finished test with simulated numbers and opens the existing real-money flow", async () => {
    render(wrap(<PaperResults />));
    expect(
      await screen.findByText(/Your fake-money test of Spot Grid · ETH has run for 7 days\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Use real money" })).toHaveAttribute(
      "href",
      `/desk/paper/${paperBot.id}/go-live`,
    );
    expect(screen.getByText(/41 simulated trades/)).toBeInTheDocument();
  });

  it("says nothing while it's too early to judge", async () => {
    state.verdict = "too_early";
    render(wrap(<PaperResults />));
    await waitFor(() => {
      expect(calls.some((c) => c.path.startsWith("/api/v1/desk/paper/"))).toBe(true);
    });
    expect(screen.queryByRole("link", { name: "Use real money" })).toBeNull();
  });
});
