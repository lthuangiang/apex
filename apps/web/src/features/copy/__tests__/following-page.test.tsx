// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { FollowingPage } from "../components/following-page";

// Following làm cho đủ (W4, báo cáo test B7): bảng Recent changes theo trang ("Load more"), lọc theo trader (aria-pressed),
// thẻ Alert preview theo mức cảnh báo (artboard WhaleWatch).

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";
const CURSOR = "1800000000000.11111111-1111-4111-8111-111111111111";

const ev = (address: string, coin: string, at: string) => ({
  address,
  coin,
  market: `${coin}-USD`,
  kind: "open",
  side: "long",
  positionAfter: "1",
  notional: "50000",
  positionNotional: "50000",
  price: "100",
  realized: null,
  at,
  seenAfterMs: 1000,
});

interface TestState {
  paths: string[];
}
const state: TestState = vi.hoisted(() => ({ paths: [] }));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (_method: string, path: string) => {
      state.paths.push(path);
      if (path === "/api/v1/following")
        return Promise.resolve({
          limit: 5,
          checkedEveryMs: 120000,
          traders: [
            {
              address: A,
              displayName: null,
              lastEventAt: null,
              copying: false,
              newMarkets: [],
              alertLevel: "positions",
            },
            {
              address: B,
              displayName: null,
              lastEventAt: null,
              copying: false,
              newMarkets: [],
              alertLevel: "off",
            },
            {
              address: C,
              displayName: null,
              lastEventAt: null,
              copying: true,
              newMarkets: [],
              alertLevel: "big_moves",
            },
          ],
          events: [],
          bigMoveAlerts: true,
          bigMoveMinUsd: "100000",
        });
      if (path === "/api/v1/following/events")
        return Promise.resolve({
          events: [
            ev(A, "BTC", "2026-11-13T10:00:00.000Z"),
            ev(B, "ETH", "2026-11-13T09:00:00.000Z"),
          ],
          nextCursor: CURSOR,
        });
      if (path === `/api/v1/following/events?cursor=${encodeURIComponent(CURSOR)}`)
        return Promise.resolve({
          events: [ev(A, "SOL", "2026-11-12T10:00:00.000Z")],
          nextCursor: null,
        });
      if (path === `/api/v1/following/events?trader=${B}`)
        return Promise.resolve({
          events: [ev(B, "ETH", "2026-11-13T09:00:00.000Z")],
          nextCursor: null,
        });
      return new Promise(() => undefined);
    },
  };
});
vi.mock("@/components/workspace", () => ({
  Workspace: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageHead: ({ title, action }: { title: string; action?: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {action}
    </header>
  ),
}));
vi.mock("@/lib/queries", () => ({ useFeatures: () => ({ data: { aiDesk: true } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined }) }));

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

const rows = () =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[3]?.textContent);

beforeEach(() => {
  state.paths = [];
});
afterEach(() => {
  cleanup();
});

describe("Following (W4)", () => {
  it("loads Recent changes 50 at a time with Load more, until there is no more", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<FollowingPage />);
    await screen.findByRole("table");
    expect(rows()).toEqual(["BTC", "ETH"]);
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => {
      expect(rows()).toEqual(["BTC", "ETH", "SOL"]);
    });
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("filters the table with trader chips (aria-pressed), and All traders clears it; the card links to the profile", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<FollowingPage />);
    await screen.findByRole("table");
    const chips = within(screen.getByRole("group", { name: "Show changes by" }));
    const all = chips.getByRole("button", { name: "All traders" });
    const pickB = chips.getByRole("button", { name: "0xbbbb…bbbb" });
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(pickB).toHaveAttribute("aria-pressed", "false");
    await user.click(pickB);
    expect(pickB).toHaveAttribute("aria-pressed", "true");
    expect(all).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => {
      expect(rows()).toEqual(["ETH"]);
    });
    expect(state.paths).toContain(`/api/v1/following/events?trader=${B}`);
    await user.click(all);
    expect(pickB).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => {
      expect(rows()).toEqual(["BTC", "ETH"]);
    });
    // Avatar + địa chỉ ở cột trái là link sang hồ sơ (không còn chữ "Profile").
    expect(screen.getByRole("link", { name: /^0xbbbb…bbbb/})).toHaveAttribute(
      "href",
      `/traders/${B}`,
    );
    expect(screen.queryByText("Profile")).not.toBeInTheDocument();
  });

  it("previews alerts for the chosen level, marked as an example, with no axe violations", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<FollowingPage />);
    const preview = await screen.findByRole("region", { name: "Alert preview" });
    // Trader đầu (mức positions): big move + tin vị thế, ghi rõ là ví dụ.
    expect(within(preview).getByText("Example")).toBeInTheDocument();
    expect(within(preview).getByText("0xaaaa…aaaa made a big move")).toBeInTheDocument();
    expect(within(preview).getByText("0xaaaa…aaaa opened a short on ETH")).toBeInTheDocument();
    // Mức Off.
    await user.click(screen.getByRole("button", { name: "0xbbbb…bbbb" }));
    expect(within(preview).getByText(/^Alerts for 0xbbbb…bbbb are off\./)).toBeInTheDocument();
    // Đang copy: tin follow tạm dừng.
    await user.click(screen.getByRole("button", { name: "0xcccc…cccc" }));
    expect(within(preview).getByText(/^You’re copying this trader/)).toBeInTheDocument();
    expect(within(preview).getByRole("link", { name: "View trader" })).toHaveAttribute(
      "href",
      `/traders/${C}`,
    );
    const r = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }, 15_000);
});
