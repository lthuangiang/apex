// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { NotificationToasts, resetToastMemory, TOAST_MS } from "../components/notification-toast";

// Toast (docs/NOTIFICATIONS.md mục 7): chỉ Bot problems và Risk, 8 s, không ẩn khi hover/focus, 1 toast, gộp.

const BOT = "6f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const state: { data: unknown } = vi.hoisted(() => ({ data: undefined }));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: () => Promise.resolve({ items: [{ id: BOT, name: "BTC Volume Farm" }] }),
}));
vi.mock("@/lib/queries", () => ({
  useNotifications: () => ({ data: state.data }),
  useFeatures: () => ({ data: { aiDesk: true } }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const at = "2026-11-12T03:42:00Z";
const item = (id: string, type: string, data: Record<string, unknown> = {}) => ({
  id,
  type,
  data,
  createdAt: at,
  readAt: null,
});

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <NotificationToasts />
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
  const r = render(tree());
  return {
    push: (items: unknown[]) => {
      state.data = { items, unread: items.length };
      r.rerender(tree());
    },
  };
}

beforeEach(() => {
  resetToastMemory();
  state.data = undefined;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("NotificationToasts", () => {
  it("keeps an assertive live region and does not toast what was there on first load", () => {
    const s = setup();
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "assertive");
    s.push([item("a", "bot_paused", { botId: BOT })]);
    expect(region).toBeEmptyDOMElement();
  });

  it("toasts a new bot problem and hides it after 8 s", async () => {
    const s = setup();
    s.push([]);
    s.push([item("a", "bot_paused", { botId: BOT, reasonCode: "RISK_DAILY_LOSS" })]);
    expect(await screen.findByText("BTC Volume Farm paused")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute("href", `/agent/${BOT}`);
    act(() => {
      vi.advanceTimersByTime(TOAST_MS + 50);
    });
    expect(screen.queryByText("BTC Volume Farm paused")).toBeNull();
  });

  it("does not toast other groups", () => {
    const s = setup();
    s.push([]);
    s.push([item("k", "key_fee"), item("f", "fill"), item("d", "daily_summary")]);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("stays while hovered or focused", async () => {
    const s = setup();
    s.push([]);
    s.push([item("r", "risk_alert")]);
    const title = await screen.findByText("Risk limit reached");
    const card = title.closest("div.pointer-events-auto");
    if (card === null) throw new Error("toast card missing");
    fireEvent.mouseEnter(card);
    act(() => {
      vi.advanceTimersByTime(TOAST_MS * 2);
    });
    expect(screen.getByText("Risk limit reached")).toBeInTheDocument();
    fireEvent.mouseLeave(card);
    act(() => {
      screen.getByRole("button", { name: "Dismiss" }).focus();
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_MS * 2);
    });
    expect(screen.getByText("Risk limit reached")).toBeInTheDocument();
  });

  it("shows one merged toast when several alerts arrive", async () => {
    const s = setup();
    s.push([]);
    s.push([item("a", "bot_paused", { botId: BOT }), item("b", "bot_stopped")]);
    s.push([
      item("c", "risk_alert"),
      item("a", "bot_paused", { botId: BOT }),
      item("b", "bot_stopped"),
    ]);
    expect(await screen.findByText("3 alerts need you")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Dismiss" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "See all" })).toHaveAttribute(
      "href",
      "/settings?tab=notifications#all-notifications",
    );
  });

  it("Dismiss closes it", async () => {
    const s = setup();
    s.push([]);
    s.push([item("u", "unknown_order")]);
    await screen.findByText("Order result unknown · not retried");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});
