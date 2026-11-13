// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { MCP_DRAFT_LIMITS, MCP_RATE_LIMITS } from "@drift/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { redirectFor } from "../../../proxy";
import { ClaudeGuidePage } from "../components/claude-guide-page";
import { LandingPage } from "../components/landing-page";
import { mcpServerUrl } from "../mcp-url";

// Trang "Connect DeskLabs to Claude" (MCP M6, W7; mockup docs/mockups/mcp-guide).

vi.mock("../components/live-book", () => ({ LiveBook: () => null }));
vi.mock("../components/landing-stats", () => ({ LandingStats: () => null }));

const URL_ = "https://mcp.example.test/mcp";
const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );

async function expectNoAxeViolations() {
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

afterEach(() => {
  cleanup();
});

describe("/claude route and server address", () => {
  it("is public", () => {
    expect(redirectFor("/claude", false)).toBeNull();
    expect(redirectFor("/claude", true)).toBeNull();
  });

  it("builds the server address from MCP_PUBLIC_URL, with the production default", () => {
    expect(mcpServerUrl(undefined)).toBe("https://mcp.desklabs.xyz/mcp");
    expect(mcpServerUrl("")).toBe("https://mcp.desklabs.xyz/mcp");
    expect(mcpServerUrl("not a url")).toBe("https://mcp.desklabs.xyz/mcp");
    expect(mcpServerUrl("https://mcp.localhost/")).toBe("https://mcp.localhost/mcp");
    expect(mcpServerUrl("javascript:alert(1)")).toBe("https://mcp.desklabs.xyz/mcp");
  });
});

describe("Connect DeskLabs to Claude", () => {
  it("shows the configured server address and real limits, and has no axe violations", async () => {
    wrap(<ClaudeGuidePage serverUrl={URL_} signedIn={false} />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Ask Claude about your bots" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Server address" })).toHaveValue(URL_);
    expect(
      screen.getByText(new RegExp(`paste ${URL_.replace(/\./g, "\\.")} and press Continue`)),
    ).toBeInTheDocument();
    const box = screen.getByRole("heading", { name: "Limits" }).parentElement;
    if (box === null) throw new Error("Limits box missing");
    const limits = within(box);
    expect(limits.getByText(String(MCP_RATE_LIMITS.perTokenPerMinute))).toBeInTheDocument();
    expect(
      limits.getByText(MCP_RATE_LIMITS.perUserPerDay.toLocaleString("en-US")),
    ).toBeInTheDocument();
    expect(
      limits.getByText(`${String(MCP_DRAFT_LIMITS.ttlMs / 3_600_000)} hours`),
    ).toBeInTheDocument();
    expect(limits.getByText(String(MCP_DRAFT_LIMITS.maxOpenPerUser))).toBeInTheDocument();
    // Launch app: chưa đăng nhập thì sang Sign in.
    expect(screen.getAllByRole("link", { name: "Launch app" })[0]).toHaveAttribute(
      "href",
      "/signin",
    );
    await expectNoAxeViolations();
  }, 15_000);

  it("switches tabs with the arrow keys and shows the Claude Code command", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<ClaudeGuidePage serverUrl={URL_} signedIn />);
    const web = screen.getByRole("tab", { name: "Claude app (web, desktop, mobile)" });
    const code = screen.getByRole("tab", { name: "Claude Code" });
    expect(web).toHaveAttribute("aria-selected", "true");
    expect(code).toHaveAttribute("tabindex", "-1");
    web.focus();
    await user.keyboard("{ArrowRight}");
    expect(code).toHaveAttribute("aria-selected", "true");
    expect(code).toHaveFocus();
    expect(
      screen.getByText(`claude mcp add --transport http --scope user desklabs ${URL_}`),
    ).toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", code.id);
    await user.keyboard("{ArrowLeft}");
    expect(web).toHaveFocus();
    expect(screen.getByText("Good to know")).toBeInTheDocument();
    await user.keyboard("{End}");
    expect(code).toHaveFocus();
  });

  it("opens and closes FAQ answers with aria-expanded", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<ClaudeGuidePage serverUrl={URL_} signedIn={false} />);
    const first = screen.getByRole("button", { name: "Is it safe to connect?" });
    const second = screen.getByRole("button", {
      name: "Does Claude see my real-money and practice bots the same way?",
    });
    expect(first).toHaveAttribute("aria-expanded", "true");
    expect(second).toHaveAttribute("aria-expanded", "false");
    await user.click(second);
    expect(second).toHaveAttribute("aria-expanded", "true");
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(/^No\. Practice \(paper\) bots/)).toBeVisible();
    await user.click(second);
    expect(second).toHaveAttribute("aria-expanded", "false");
  });

  it("copies the server address and announces Copied", async () => {
    const user = userEvent.setup({ delay: null });
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    wrap(<ClaudeGuidePage serverUrl={URL_} signedIn={false} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(URL_);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    });
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent("Copied");
  });
});

describe("Ways in from the landing page (W7)", () => {
  it("links the Ask from Claude card, the FAQ and the footer to /claude", () => {
    wrap(<LandingPage />);
    expect(screen.getByRole("heading", { level: 3, name: "Ask from Claude" })).toBeInTheDocument();
    const links = screen.getAllByRole("link").filter((a) => a.getAttribute("href") === "/claude");
    expect(links.map((a) => a.textContent.trim())).toEqual(
      expect.arrayContaining(["Connect Claude", "See how to connect"]),
    );
    expect(links.length).toBeGreaterThanOrEqual(3);
  });
});
