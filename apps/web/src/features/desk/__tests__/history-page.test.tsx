// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { HistoryPage } from "../components/history-page";

// Desk AI › History (artboard B-History, DEC-TBD-history-open): mỗi cuộc trò chuyện là nút có mũi tên, mở ra các lượt
// hỏi / trả lời có giờ; Delete history phải qua hộp xác nhận.

const state = vi.hoisted(() => ({
  calls: [] as { method: string; path: string }[],
}));

vi.mock("@/components/workspace", () => ({
  Workspace: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageHead: ({ title }: { title: string }) => <h1>{title}</h1>,
  Card: ({ title, children }: { title?: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));

const today = "2026-11-13";
const turn = (id: string, question: string | null, text: string, at: string) => ({
  id,
  kind: question === null ? "brief" : "question",
  question,
  answer: { kind: "text", text, facts: [] },
  createdAt: at,
});

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: (method: string, path: string) => {
    state.calls.push({ method, path });
    if (path === "/api/v1/desk/ai/history" && method === "GET")
      return Promise.resolve({
        questionsToday: 2,
        limit: 20,
        conversations: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            kind: "chat",
            title: "Why did I lose money on ETH Volume Farm?",
            localDate: today,
            createdAt: "2026-11-13T01:14:00Z",
            turns: [
              turn(
                "a1111111-1111-4111-8111-111111111111",
                "Why did I lose money on ETH Volume Farm?",
                "Mostly fees, not bad guesses.",
                "2026-11-13T01:14:00Z",
              ),
              turn(
                "a2222222-2222-4222-8222-222222222222",
                "What should I change?",
                "Use limit orders only.",
                "2026-11-13T01:16:00Z",
              ),
            ],
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            kind: "brief",
            title: "",
            localDate: "2026-11-10",
            createdAt: "2026-11-10T01:00:00Z",
            turns: [
              turn(
                "b1111111-1111-4111-8111-111111111111",
                null,
                "Good morning. Nothing needs you today.",
                "2026-11-10T01:00:00Z",
              ),
            ],
          },
        ],
      });
    if (path === "/api/v1/desk/record")
      return Promise.resolve({
        counts: { helped: 0, madeWorse: 0, noClearEffect: 0, measuring: 0 },
        rows: [],
      });
    if (path === "/api/v1/desk/ai/history" && method === "DELETE")
      return Promise.resolve({ deleted: 2 });
    return new Promise(() => undefined);
  },
}));

const show = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <HistoryPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  state.calls = [];
});
afterEach(() => {
  cleanup();
});

describe("History page", () => {
  it("opens a conversation to show its questions and answers, and closes it again", async () => {
    const user = userEvent.setup({ delay: null });
    show();
    const row = await screen.findByRole("button", {
      name: /Why did I lose money on ETH Volume Farm\?/,
    });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Mostly fees, not bad guesses.")).not.toBeInTheDocument();

    await user.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    const turns = document.getElementById(row.getAttribute("aria-controls") ?? "");
    if (turns === null) throw new Error("turn list not found");
    const list = within(turns);
    // Hai lượt, đúng thứ tự, mỗi lượt có giờ; câu hỏi là bong bóng nền accent như panel Desk AI.
    expect(list.getAllByRole("listitem")).toHaveLength(2);
    expect(list.getByText("What should I change?")).toHaveClass("bg-accent", "text-white");
    expect(list.getByText("Mostly fees, not bad guesses.")).toBeInTheDocument();
    expect(list.getByText("Use limit orders only.")).toBeInTheDocument();
    expect(turns.querySelectorAll("time")).toHaveLength(2);
    // Cuộc khác vẫn đóng.
    expect(screen.queryByText("Good morning. Nothing needs you today.")).not.toBeInTheDocument();

    await user.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Mostly fees, not bad guesses.")).not.toBeInTheDocument();
  });

  it("groups Today and Earlier and names the morning brief", async () => {
    show();
    expect(await screen.findByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Earlier")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Morning brief/ })).toBeInTheDocument();
  });

  it("deletes the history only after the confirmation dialog", async () => {
    const user = userEvent.setup({ delay: null });
    show();
    await user.click(await screen.findByRole("button", { name: "Delete history" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete your Desk AI history?" });
    expect(state.calls.some((c) => c.method === "DELETE")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(state.calls.some((c) => c.method === "DELETE")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Delete history" }));
    const again = await screen.findByRole("dialog", { name: "Delete your Desk AI history?" });
    await user.click(within(again).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(state.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    });
  });
});
