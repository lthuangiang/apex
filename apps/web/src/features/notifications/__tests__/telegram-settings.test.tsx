// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { NotificationsTab } from "../../settings/components/notifications-tab";
import { formatCountdown, maskEmail, telegramGroupsOn } from "../telegram";

// Settings › Notifications với kênh Telegram (artboard NT-Settings / NT-Connect, DEC-170).

const TOKEN = "T".repeat(43);
const AXE_TIMEOUT = 15_000;

interface FakeServer {
  link: Record<string, unknown> | "disabled";
  createExpiresInMs: number;
  calls: { method: string; path: string }[];
}

const server: FakeServer = vi.hoisted(() => ({
  link: { status: "not_connected" },
  createExpiresInMs: 10 * 60 * 1000,
  calls: [],
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const groups = ["botErrors", "risk", "keyFee", "fills", "daily", "copyTrading"].map((group) => ({
    group,
    alwaysOn: group === "botErrors",
    in_app: !["fills", "daily"].includes(group),
    email: !["fills", "daily", "copyTrading"].includes(group),
    telegram: !["fills", "copyTrading"].includes(group),
  }));
  return {
    ...real,
    api: (method: string, path: string) => {
      server.calls.push({ method, path });
      if (path === "/api/v1/notifications/settings") return Promise.resolve({ groups });
      if (path === "/api/v1/notifications") return Promise.resolve({ items: [], unread: 0 });
      if (path === "/api/v1/telegram/link") {
        if (server.link === "disabled") return Promise.reject(new real.ApiError("NOT_FOUND", 404));
        if (method === "GET") return Promise.resolve(server.link);
        if (method === "POST") {
          const expiresAt = new Date(Date.now() + server.createExpiresInMs).toISOString();
          server.link = { status: "pending", expiresAt };
          return Promise.resolve({
            deepLink: `https://t.me/desklabsbot?start=${TOKEN}`,
            expiresAt,
          });
        }
        server.link = { status: "not_connected" };
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    },
  };
});
vi.mock("@/lib/queries", () => ({
  useMe: () => ({ data: { email: "mai.nguyen@gmail.com", timezone: "UTC" } }),
  useFeatures: () => ({ data: { aiDesk: true } }),
  useNotifications: () => ({ data: { items: [], unread: 0 } }),
}));
// QR thật cần canvas; ở đây chỉ cần một data URL.
vi.mock("qrcode", () => ({
  default: { toDataURL: () => Promise.resolve("data:image/png;base64,AAAA") },
}));

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <NotificationsTab />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

async function expectNoAxeViolations() {
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

beforeEach(() => {
  server.link = { status: "not_connected" };
  server.createExpiresInMs = 10 * 60 * 1000;
  server.calls = [];
});
afterEach(() => {
  cleanup();
});

describe("helpers", () => {
  it("formats the countdown, masks the email, lists Telegram groups in order", () => {
    expect(formatCountdown(581_000)).toBe("9:41");
    expect(formatCountdown(-5)).toBe("0:00");
    expect(maskEmail("mai.nguyen@gmail.com")).toBe("mai•••@gmail.com");
    expect(maskEmail("ab@x.io")).toBe("ab•••@x.io");
    expect(
      telegramGroupsOn(
        [
          { group: "daily", telegram: true },
          { group: "botErrors", telegram: true },
          { group: "copyTrading", telegram: true },
          { group: "fills", telegram: false },
        ],
        false,
      ),
    ).toEqual(["botErrors", "daily"]);
  });
});

describe("Where we reach you / What we tell you", () => {
  it(
    "shows the three channels and a Telegram column; Bot problems is locked on",
    async () => {
      renderTab();
      expect(await screen.findByRole("button", { name: "Connect Telegram" })).toBeInTheDocument();
      expect(screen.getByText("mai•••@gmail.com")).toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "Telegram" })).toBeInTheDocument();
      const locked = await screen.findByRole("switch", {
        name: "Bot problems, Telegram, always on",
      });
      expect(locked).toBeDisabled();
      expect(locked).toBeChecked();
      expect(screen.getByRole("switch", { name: "✦ Morning brief, Telegram" })).toBeChecked();
      expect(
        screen.getByRole("switch", { name: "Traders you follow, Telegram" }),
      ).not.toBeChecked();
      // Email của Traders you follow không có (DEC-163): "—", không phải switch.
      expect(screen.queryByRole("switch", { name: "Traders you follow, Email" })).toBeNull();
      expect(screen.getByText(/Wallet addresses and keys are never sent/)).toBeInTheDocument();
      await expectNoAxeViolations();
    },
    AXE_TIMEOUT,
  );

  it("hides Telegram while the server has it off", async () => {
    server.link = "disabled";
    renderTab();
    expect(await screen.findByText("Telegram · Coming soon")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("columnheader", { name: "Telegram" })).toBeNull();
    });
    expect(screen.queryByRole("button", { name: "Connect Telegram" })).toBeNull();
  });
});

describe("Connect Telegram", () => {
  it(
    "opens Step 1 with the deep link and QR, then turns to Connected when the backend says so",
    async () => {
      const user = userEvent.setup({ delay: null });
      renderTab();
      await user.click(await screen.findByRole("button", { name: "Connect Telegram" }));
      const dialog = await screen.findByRole("dialog", { name: "Connect Telegram" });
      expect(within(dialog).getByText("Step 1 of 2")).toBeInTheDocument();
      expect(within(dialog).getByRole("link", { name: "Open Telegram" })).toHaveAttribute(
        "href",
        `https://t.me/desklabsbot?start=${TOKEN}`,
      );
      expect(
        await within(dialog).findByRole("img", {
          name: "QR code that opens DeskLabs Bot in Telegram",
        }),
      ).toBeInTheDocument();
      expect(within(dialog).getByRole("status")).toHaveTextContent(/Link works for (10:00|9:5\d)/);
      expect(
        server.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/telegram/link"),
      ).toHaveLength(1);
      await expectNoAxeViolations();

      // Người dùng bấm Start trong Telegram: lần poll kế tiếp (2 s) thấy active.
      server.link = {
        status: "active",
        username: "mai_trades",
        connectedAt: new Date().toISOString(),
      };
      const done = await screen.findByRole(
        "dialog",
        { name: "Telegram connected" },
        { timeout: 5_000 },
      );
      expect(within(done).getByText("Step 2 of 2")).toBeInTheDocument();
      expect(within(done).getByText("@mai_trades")).toBeInTheDocument();
      expect(within(done).getByText("✦ Morning brief at 08:00")).toBeInTheDocument();
      expect(within(done).queryByText("Traders you follow")).toBeNull();
      // "Send a test message" có ở N3.
      expect(within(done).queryByRole("button", { name: /Send a test/ })).toBeNull();
      await user.click(within(done).getByRole("button", { name: "Done" }));
      expect(await screen.findByText("@mai_trades")).toBeInTheDocument();
    },
    AXE_TIMEOUT,
  );

  it("shows Link expired with Get a new link once the 10 minutes are up", async () => {
    server.createExpiresInMs = -1;
    const user = userEvent.setup({ delay: null });
    renderTab();
    await user.click(await screen.findByRole("button", { name: "Connect Telegram" }));
    const dialog = await screen.findByRole("dialog", { name: "That link timed out" });
    expect(within(dialog).getByText("Link expired")).toBeInTheDocument();
    server.createExpiresInMs = 10 * 60 * 1000;
    await user.click(within(dialog).getByRole("button", { name: "Get a new link" }));
    expect(await screen.findByRole("dialog", { name: "Connect Telegram" })).toBeInTheDocument();
  });
});

describe("Show link again", () => {
  const posts = () =>
    server.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/telegram/link");

  it("reopens the same link after the dialog was closed, without a new POST", async () => {
    const user = userEvent.setup({ delay: null });
    renderTab();
    await user.click(await screen.findByRole("button", { name: "Connect Telegram" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect Telegram" });
    const href = within(dialog).getByRole("link", { name: "Open Telegram" }).getAttribute("href");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await user.click(await screen.findByRole("button", { name: "Show link again" }));
    const again = await screen.findByRole("dialog", { name: "Connect Telegram" });
    expect(within(again).getByRole("link", { name: "Open Telegram" })).toHaveAttribute(
      "href",
      href ?? "",
    );
    expect(posts()).toHaveLength(1);
  });

  it("after a reload (no link in memory) makes one new link and opens it", async () => {
    server.link = {
      status: "pending",
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };
    const user = userEvent.setup({ delay: null });
    renderTab();
    await user.click(await screen.findByRole("button", { name: "Show link again" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect Telegram" });
    expect(within(dialog).getByRole("link", { name: "Open Telegram" })).toHaveAttribute(
      "href",
      `https://t.me/desklabsbot?start=${TOKEN}`,
    );
    expect(posts()).toHaveLength(1);
    // Link mới: đếm lại từ 10 phút.
    expect(await within(dialog).findByText(/Link works for (10:00|9:5\d)/)).toBeInTheDocument();
  });
});

describe("Telegram card states", () => {
  it("connected: Disconnect asks first, then calls DELETE", async () => {
    server.link = {
      status: "active",
      username: "mai_trades",
      connectedAt: "2026-11-12T03:00:00Z",
    };
    const user = userEvent.setup({ delay: null });
    renderTab();
    expect(await screen.findByText("@mai_trades")).toBeInTheDocument();
    expect(screen.getByText(/since Nov 12/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const confirm = await screen.findByRole("dialog", { name: "Disconnect Telegram?" });
    expect(server.calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(confirm).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => {
      expect(server.calls.some((c) => c.method === "DELETE")).toBe(true);
    });
    expect(await screen.findByRole("button", { name: "Connect Telegram" })).toBeInTheDocument();
  });

  it("blocked: explains and offers Connect again", async () => {
    server.link = {
      status: "blocked",
      username: "mai_trades",
      connectedAt: "2026-11-01T03:00:00Z",
      blockedAt: "2026-11-10T03:00:00Z",
    };
    renderTab();
    expect(await screen.findByText("Paused · bot blocked")).toBeInTheDocument();
    expect(screen.getByText(/alerts stopped on Nov 10/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect again" })).toBeInTheDocument();
  });

  it("waiting (dialog closed): shows the time left and Cancel removes the link", async () => {
    server.link = {
      status: "pending",
      expiresAt: new Date(Date.now() + 9 * 60 * 1000 + 41_000).toISOString(),
    };
    const user = userEvent.setup({ delay: null });
    renderTab();
    expect(await screen.findByText("Waiting for Telegram…")).toBeInTheDocument();
    expect(screen.getByText(/This link works for 9:4\d more/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(server.calls.some((c) => c.method === "DELETE")).toBe(true);
    });
  });
});
