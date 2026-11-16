// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { OrderView } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { OrdersPage } from "../components/orders-page";

// BD-02 Execution & Orders (docs/mockups/bd02-decisions Orders / OrdersFiltered / MobileOrders): mở từ pill Result.

const BOT = "11111111-1111-4111-8111-111111111111";
const state = vi.hoisted(() => ({ calls: [] as string[], replace: vi.fn() }));

const order = (clOrdId: string, minutesAgo: number, status: OrderView["status"]): OrderView => ({
  id: `00000000-0000-4000-8000-${clOrdId.padStart(12, "0")}`,
  botId: "11111111-1111-4111-8111-111111111111",
  clOrdId,
  market: "ETH-USD",
  side: "buy",
  type: "limit",
  price: "1824.6",
  size: "0.0109",
  filledSize: status === "filled" ? "0.0109" : "0",
  status,
  rejectCode: null,
  rejectMessage: null,
  submittedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});
const counts = {
  open: 0,
  partiallyFilled: 0,
  filledToday: 0,
  rejectedToday: 0,
  lastRejectCode: null,
  lastRejectMessage: null,
};

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: (_m: string, url: string) => {
    state.calls.push(url);
    if (url.startsWith("/api/v1/bots")) return Promise.resolve({ items: [] });
    if (url.includes("order=old-1"))
      return Promise.resolve({ items: [order("old-1", 60 * 24 * 40, "cancelled")], counts });
    return Promise.resolve({
      items: [order("a-1", 1, "cancelled"), order("b-2", 2, "filled"), order("c-3", 3, "open")],
      counts,
    });
  },
}));
vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMe: () => ({ data: undefined }),
  useNotifications: () => ({ data: undefined }),
  useFeatures: () => ({ data: undefined }),
}));
vi.mock("@/lib/markets", () => ({
  useMarketNames: () => ({ market: (m: string) => m, priceDigits: () => 1, qtyDigits: () => 4 }),
}));
vi.mock("@/components/not-connected", () => ({
  useSodexMissing: () => false,
  NotConnected: () => null,
}));
vi.mock("@/components/workspace-shell", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  WorkspaceShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
// jsdom không có scrollIntoView.
Element.prototype.scrollIntoView = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: state.replace }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

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

afterEach(() => {
  cleanup();
  state.calls = [];
});

describe("Execution & Orders opened from Decisions (BD-02)", () => {
  it("highlights the order on the loaded page and moves focus to its row", async () => {
    wrap(<OrdersPage botId={BOT} order="b-2" decision="Bid pulled" at="2026-11-16T07:42:51Z" />);
    const table = await screen.findByRole("table");
    await waitFor(() => {
      expect(within(table).getByText("From Decisions")).toBeInTheDocument();
    });
    const row = within(table).getByText("From Decisions").closest("tr");
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row).toHaveAttribute("tabindex", "-1");
    expect(document.activeElement?.hasAttribute("data-from-decisions")).toBe(true);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Showing the order from Decisions: Bid pulled · 14:42:51");
    expect(within(banner).getByRole("link", { name: "← Back to decisions" })).toHaveAttribute(
      "href",
      `/agent/${BOT}#decisions-title`,
    );
    expect(screen.queryByRole("button", { name: "Clear order filter" })).toBeNull();
    const r = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("filters to the order when it is not on the loaded page, with a chip to clear", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<OrdersPage botId={BOT} order="old-1" decision="Bid pulled" at="2026-11-16T07:42:51Z" />);
    await waitFor(() => {
      expect(state.calls).toContain(`/api/v1/orders?botId=${BOT}&order=old-1`);
    });
    expect(await screen.findByText(/This order is older than the loaded page/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Showing 1 order.")).toBeInTheDocument();
    });
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Clear order filter" }));
    expect(state.replace).toHaveBeenCalledWith(`/orders?botId=${BOT}`, { scroll: false });
    expect(screen.queryByRole("status")).toBeNull();
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(4);
  });
});
