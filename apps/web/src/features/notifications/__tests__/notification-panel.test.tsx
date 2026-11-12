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
import {
  MobileNotificationsButton,
  NotificationBell,
  NotificationPanel,
} from "../components/notification-panel";

// Panel chuông (docs/NOTIFICATIONS.md mục 7, artboard NT-InApp).

const BOT = "6f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const { ARCHIVED_BOT } = vi.hoisted(() => ({
  ARCHIVED_BOT: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
}));
const now = new Date();
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

const { noonZone } = vi.hoisted(() => ({
  noonZone: () => {
    // Etc/GMT-X = UTC+X (dấu ngược). X trong khoảng -12..+12.
    const x = 12 - new Date().getUTCHours();
    return x === 0 ? "UTC" : `Etc/GMT${x > 0 ? "-" : "+"}${String(Math.abs(x))}`;
  },
}));

const state = vi.hoisted(() => ({
  list: { items: [] as unknown[], unread: 0 },
  calls: [] as { method: string; path: string; idempotencyKey: string | undefined }[],
}));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: (method: string, path: string, _schema: unknown, opts?: { idempotencyKey?: string }) => {
    state.calls.push({ method, path, idempotencyKey: opts?.idempotencyKey });
    if (path === "/api/v1/notifications") return Promise.resolve(structuredClone(state.list));
    // Danh sách mặc định bỏ bot đã archive; `?archived=true` có cả bot đó (như listBots ở api).
    if (path === "/api/v1/bots")
      return Promise.resolve({ items: [{ id: BOT, name: "BTC Volume Farm" }] });
    if (path === "/api/v1/bots?archived=true")
      return Promise.resolve({
        items: [
          { id: BOT, name: "BTC Volume Farm" },
          { id: ARCHIVED_BOT, name: "ETH Grid" },
        ],
      });
    // Server giả: đánh dấu đã đọc như markRead() ở api.
    const m = /^\/api\/v1\/notifications\/([^/]+)\/read$/.exec(path);
    if (method === "POST" && m !== null) {
      const items = state.list.items as { id: string; readAt: string | null }[];
      for (const n of items)
        if (n.readAt === null && (m[1] === "all" || n.id === m[1]))
          n.readAt = new Date().toISOString();
      state.list.unread = items.filter((n) => n.readAt === null).length;
    }
    return Promise.resolve(null);
  },
}));
vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  // Chọn múi giờ mà giờ địa phương lúc chạy test là khoảng giữa trưa, để "vài phút trước" luôn là Today
  // và "3 ngày trước" luôn là Earlier, dù test chạy lúc nửa đêm UTC.
  useMe: () => ({ data: { timezone: noonZone() } }),
  useFeatures: () => ({ data: { aiDesk: true } }),
}));
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

// Test có axe chạy chậm trên runner CI 2 vCPU khi các package test song song (~0.6 s ở máy, có lúc > 5 s trên CI),
// nên có timeout riêng như dialogs.test.tsx (#21). Timeout chung giữ nguyên.
const AXE_TIMEOUT = 15_000;

async function expectNoAxeViolations(root: Element = document.body) {
  const results = await axe.run(root, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

beforeEach(() => {
  state.calls = [];
  state.list = {
    unread: 3,
    items: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        type: "bot_paused",
        data: { botId: BOT, reasonCode: "RISK_DAILY_LOSS" },
        createdAt: minutesAgo(1),
        readAt: null,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        type: "unknown_order",
        data: { botId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        createdAt: minutesAgo(2),
        readAt: null,
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        type: "key_fee",
        data: {},
        createdAt: minutesAgo(3),
        readAt: null,
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        type: "risk_alert",
        data: {},
        createdAt: daysAgo(3),
        readAt: daysAgo(3),
      },
      {
        // Bot đã archive, dừng đúng kế hoạch: có tên, ở All, không ở Needs you.
        id: "55555555-5555-4555-8555-555555555555",
        type: "bot_stopped",
        data: { botId: ARCHIVED_BOT, reasonCode: "TAKE_PROFIT" },
        createdAt: minutesAgo(4),
        readAt: null,
      },
    ],
  };
});

afterEach(() => {
  cleanup();
});

describe("NotificationPanel", () => {
  it(
    "groups by Today / Earlier and words rows from the bot's real name",
    async () => {
      wrap(<NotificationPanel variant="popover" onNavigate={() => undefined} />);
      expect(await screen.findByText("BTC Volume Farm paused")).toBeInTheDocument();
      expect(
        screen.getByText("Daily loss limit reached. Open orders were kept."),
      ).toBeInTheDocument();
      // Không tìm thấy tên bot thì dùng nhãn chung, không đoán tên.
      expect(screen.getByText("Order result unknown · not retried")).toBeInTheDocument();
      const today = screen.getByRole("region", { name: "Today" });
      const earlier = screen.getByRole("region", { name: "Earlier" });
      expect(within(today).getAllByRole("link")).toHaveLength(4);
      // Bot đã archive vẫn có tên (review PR #24 điểm 1).
      expect(screen.getByText("ETH Grid stopped")).toBeInTheDocument();
      expect(screen.getByText("Take profit reached.")).toBeInTheDocument();
      expect(within(earlier).getByText("Risk limit reached")).toBeInTheDocument();
      const paused = screen.getByRole("link", { name: /BTC Volume Farm paused/ });
      expect(paused).toHaveAttribute("href", `/agent/${BOT}`);
      expect(paused).toHaveTextContent("Review →");
      await expectNoAxeViolations();
    },
    AXE_TIMEOUT,
  );

  it("Needs you shows only unread real incidents, not a planned finish", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<NotificationPanel variant="popover" onNavigate={() => undefined} />);
    const needs = await screen.findByRole("tab", { name: "Needs you · 2" });
    await user.click(needs);
    expect(needs).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getAllByRole("link")).toHaveLength(2);
    expect(within(panel).queryByText("SoDEX access changed")).toBeNull();
    expect(within(panel).queryByText("ETH Grid stopped")).toBeNull();
    // Phím mũi tên chuyển tab (mẫu tablist).
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "All" })).toHaveFocus();
  });

  it("clicking a row marks it read with an Idempotency-Key, then navigates", async () => {
    const user = userEvent.setup({ delay: null });
    const onNavigate = vi.fn();
    wrap(<NotificationPanel variant="popover" onNavigate={onNavigate} />);
    await user.click(await screen.findByRole("link", { name: /BTC Volume Farm paused/ }));
    const call = state.calls.find((c) => c.method === "POST");
    expect(call?.path).toBe("/api/v1/notifications/11111111-1111-4111-8111-111111111111/read");
    expect(call?.idempotencyKey).toBeTruthy();
    expect(onNavigate).toHaveBeenCalled();
  });

  it("Mark all read calls the existing all/read endpoint and hides itself", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<NotificationPanel variant="popover" onNavigate={() => undefined} />);
    await user.click(await screen.findByRole("button", { name: "Mark all read" }));
    expect(state.calls.some((c) => c.path === "/api/v1/notifications/all/read")).toBe(true);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull();
    });
  });

  it("shows the empty state, never a zero", async () => {
    state.list = { items: [], unread: 0 };
    wrap(<NotificationPanel variant="popover" onNavigate={() => undefined} />);
    expect(await screen.findByText("You're all caught up.")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Needs you" })).toBeInTheDocument();
  });

  it("links to settings and the full list", async () => {
    wrap(<NotificationPanel variant="popover" onNavigate={() => undefined} />);
    expect(await screen.findByRole("link", { name: "Notification settings" })).toHaveAttribute(
      "href",
      "/settings?tab=notifications",
    );
    expect(screen.getByRole("link", { name: "See all" })).toHaveAttribute(
      "href",
      "/settings?tab=notifications#all-notifications",
    );
  });
});

describe("NotificationBell (desktop)", () => {
  it(
    "opens the panel instead of going to Settings; Escape closes and returns focus",
    async () => {
      const user = userEvent.setup({ delay: null });
      wrap(<NotificationBell unread={3} />);
      const bell = screen.getByRole("button", { name: "Notifications, 3 unread" });
      expect(bell).toHaveAttribute("aria-expanded", "false");
      await user.click(bell);
      expect(bell).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
      await screen.findByText("BTC Volume Farm paused");
      await expectNoAxeViolations();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(bell).toHaveFocus();
    },
    AXE_TIMEOUT,
  );
});

describe("MobileNotificationsButton (390)", () => {
  it(
    "opens a full-screen sheet with the same panel",
    async () => {
      const user = userEvent.setup({ delay: null });
      wrap(<MobileNotificationsButton unread={3} />);
      await user.click(screen.getByRole("button", { name: "Notifications, 3 unread" }));
      const sheet = await screen.findByRole("dialog", { name: "Notifications" });
      expect(await within(sheet).findByText("BTC Volume Farm paused")).toBeInTheDocument();
      await expectNoAxeViolations();
    },
    AXE_TIMEOUT,
  );
});
