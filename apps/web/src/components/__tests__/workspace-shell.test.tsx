// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../messages/en.json";
import { WorkspaceShell } from "../workspace-shell";

// Thứ tự sidebar và menu More (DEC-181; Trading Agent vẫn thứ 3, DEC-108).

const flags = vi.hoisted(() => ({ aiDesk: true, signalResearch: false }));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: () => Promise.resolve({ items: [] }),
}));
vi.mock("@/lib/queries", () => ({
  NOTIFICATIONS_KEY: ["notifications"],
  useFeatures: () => ({
    data: { aiDesk: flags.aiDesk, signalResearch: flags.signalResearch },
  }),
  useMe: () => ({ data: undefined }),
  useSodexConnection: () => ({ data: undefined, isSuccess: false, dataUpdatedAt: 0 }),
  useNotifications: () => ({ data: undefined }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("../sign-out", () => ({ SignOutButton: () => null }));

function renderShell(isTeam: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <WorkspaceShell current="overview" isTeam={isTeam}>
          <p>page</p>
        </WorkspaceShell>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const linkNames = (root: HTMLElement) =>
  within(root)
    .getAllByRole("link")
    .map((a) => a.textContent.trim());

afterEach(() => {
  cleanup();
});

describe("WorkspaceShell sidebar order", () => {
  it("puts Copy Trading at the end of the main block, right before TEAM", () => {
    flags.aiDesk = true;
    renderShell(true);
    const nav = screen.getAllByRole("navigation", { name: "Main" })[0];
    if (nav === undefined) throw new Error("sidebar nav missing");
    expect(linkNames(nav)).toEqual([
      "Overview",
      "Portfolio",
      "Trading Agent",
      "AI Desk",
      "Strategy Lab",
      "Execution & Orders",
      "Risk Center",
      "Find traders",
      "Following",
      "Builder Revenue",
      "Users",
      "Platform Stats",
      "Bot Monitor",
      "Market hours",
      "System Architecture Diagram",
      "SoDEX Debugger",
      "Signal Analysis",
      "Settings",
    ]);
  });

  it("without AI Desk: no Copy Trading, AI Analyst after Risk Center", () => {
    flags.aiDesk = false;
    renderShell(false);
    const nav = screen.getAllByRole("navigation", { name: "Main" })[0];
    if (nav === undefined) throw new Error("sidebar nav missing");
    expect(linkNames(nav)).toEqual([
      "Overview",
      "Portfolio",
      "Trading Agent",
      "Strategy Lab",
      "Execution & Orders",
      "Risk Center",
      "AI Analyst",
      "Settings",
    ]);
  });

  it("the mobile More sheet uses the same order; Settings and TEAM keep their place", async () => {
    flags.aiDesk = true;
    const user = userEvent.setup({ delay: null });
    renderShell(true);
    await user.click(screen.getByRole("button", { name: "More" }));
    const sheet = await screen.findByRole("dialog", { name: "More" });
    expect(linkNames(sheet)).toEqual([
      "Portfolio",
      "Execution & Orders",
      "Risk Center",
      "Find traders",
      "Following",
      "Settings",
      "Builder Revenue",
      "Users",
      "Platform Stats",
      "Bot Monitor",
      "Market hours",
      "System Architecture Diagram",
      "SoDEX Debugger",
      "Signal Analysis",
    ]);
  }, 15_000);

  it("the mobile bottom bar shows AI Desk instead of Portfolio when AI Desk is on", () => {
    const bottomBar = () => {
      const nav = screen
        .getAllByRole("navigation")
        .find((n) => within(n).queryByRole("button", { name: "More" }) !== null);
      if (nav === undefined) throw new Error("bottom bar missing");
      return linkNames(nav);
    };
    flags.aiDesk = true;
    renderShell(false);
    expect(bottomBar()).toEqual(["Home", "AI Desk", "Agent", "Strategy"]);
    cleanup();
    flags.aiDesk = false;
    renderShell(false);
    expect(bottomBar()).toEqual(["Home", "Portfolio", "Agent", "Strategy"]);
    flags.aiDesk = true;
  });
});

describe("Signal Research (BETA, #423)", () => {
  afterEach(() => {
    flags.signalResearch = false;
  });

  it("is hidden without the flag", () => {
    flags.aiDesk = true;
    flags.signalResearch = false;
    renderShell(false);
    const nav = screen.getAllByRole("navigation", { name: "Main" })[0];
    if (nav === undefined) throw new Error("sidebar nav missing");
    expect(linkNames(nav).some((n) => n.startsWith("Signal Research"))).toBe(false);
    expect(screen.queryByText("BETA")).toBeNull();
  });

  it("with the flag: right after AI Desk, with a BETA tag, linking outside /admin", () => {
    flags.aiDesk = true;
    flags.signalResearch = true;
    renderShell(false);
    const nav = screen.getAllByRole("navigation", { name: "Main" })[0];
    if (nav === undefined) throw new Error("sidebar nav missing");
    const names = linkNames(nav);
    expect(names.slice(3, 5)).toEqual(["AI Desk", "Signal ResearchBETA"]);
    const link = within(nav).getByRole("link", { name: /Signal Research/ });
    expect(link).toHaveAttribute("href", "/signal-research");
    expect(within(link).getByText("BETA")).toBeInTheDocument();
  });

  it("is in the mobile More sheet right after the AI Desk slot", async () => {
    flags.aiDesk = true;
    flags.signalResearch = true;
    const user = userEvent.setup({ delay: null });
    renderShell(false);
    await user.click(screen.getByRole("button", { name: "More" }));
    const sheet = await screen.findByRole("dialog", { name: "More" });
    expect(linkNames(sheet).slice(0, 2)).toEqual(["Portfolio", "Signal ResearchBETA"]);
  });
});
