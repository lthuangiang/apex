// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { MCP_DRAFT_CONFIG, MCP_RATE_LIMITS } from "@drift/shared";
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

// Trang "Connect DeskLabs to Claude" (MCP M6, W7; UI mới docs/mockups/landing-mcp/McpPage).

vi.mock("../components/landing/landing-stats", () => ({ LandingStatsStrip: () => null }));
// next/font chỉ chạy khi build (SWC); trong vitest chỉ cần tên class.
vi.mock("../landing-fonts", () => ({ LANDING_FONTS: "" }));

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
      limits.getByText(`${String(MCP_DRAFT_CONFIG.ttlMs / 3_600_000)} hours`),
    ).toBeInTheDocument();
    expect(limits.getByText(String(MCP_DRAFT_CONFIG.maxOpen))).toBeInTheDocument();
    // Launch app: chưa đăng nhập thì sang Sign in.
    expect(screen.getAllByRole("link", { name: "Launch app" })[0]).toHaveAttribute(
      "href",
      "/signin",
    );
    await expectNoAxeViolations();
  }, 15_000);

  it("uses the landing look: default light, theme toggle, Launch app only, no axe violations in dark", async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = wrap(<ClaudeGuidePage serverUrl={URL_} signedIn />);
    const shell = container.querySelector(".landing");
    expect(shell).toHaveAttribute("data-theme", "light");
    const nav = screen.getByRole("navigation", { name: "Guide sections" });
    expect(within(nav).queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(within(nav).getByRole("link", { name: "Launch app" })).toHaveAttribute("href", "/");
    expect(within(nav).getByRole("link", { name: "FAQ" })).toHaveAttribute("href", "#faq");
    await user.click(screen.getByRole("button", { name: "Switch to dark" }));
    expect(shell).toHaveAttribute("data-theme", "dark");
    expect(screen.getByRole("button", { name: "Switch to light" })).toBeInTheDocument();
    await expectNoAxeViolations();
  }, 15_000);

  it("starts dark when the cookie says so", () => {
    const { container } = wrap(
      <ClaudeGuidePage serverUrl={URL_} signedIn={false} initialTheme="dark" />,
    );
    expect(container.querySelector(".landing")).toHaveAttribute("data-theme", "dark");
  });

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
    // Terminal nằm dưới các bước (artboard McpPage), câu bước 1 nói "below".
    const panel = screen.getByRole("tabpanel");
    const steps = within(panel).getByRole("list");
    const terminal = within(panel).getByText("Terminal").closest("figure");
    if (terminal === null) throw new Error("terminal missing");
    expect(steps.compareDocumentPosition(terminal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      within(panel).getByText(/^Run the command below in your terminal\./),
    ).toBeInTheDocument();
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
  it("links the Claude section, the FAQ and the footer to /claude", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<LandingPage serverUrl={URL_} />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Ask Claude about your bots" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect in 2 minutes" })).toHaveAttribute(
      "href",
      "/claude#connect",
    );
    expect(screen.getByRole("link", { name: "See what it can do" })).toHaveAttribute(
      "href",
      "/claude#what",
    );
    expect(screen.getByLabelText("Server address")).toHaveValue(URL_);
    // FAQ về Claude (mở câu hỏi đó) và footer dẫn tới /claude.
    await user.click(screen.getByRole("button", { name: /Can I use DeskLabs with Claude\?/ }));
    const links = screen.getAllByRole("link").filter((a) => a.getAttribute("href") === "/claude");
    expect(links.map((a) => a.textContent.trim())).toEqual(
      expect.arrayContaining(["Connect Claude", "See how to connect"]),
    );
  });
});
