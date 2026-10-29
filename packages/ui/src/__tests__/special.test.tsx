import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AppShell, ShellHeaderExtras } from "../components/app-shell";
import { BacktestPanel, type BacktestPanelProps } from "../components/backtest-panel";
import { ChecklistRow } from "../components/checklist-row";
import { PageHeader } from "../components/page-header";
import { WalletSignaturePreview } from "../components/wallet-signature-preview";
import { expectNoAxeViolations } from "../test/axe";

describe("ChecklistRow", () => {
  it("exposes status as text and shows a fix link on failure", async () => {
    render(
      <ChecklistRow
        status="fail"
        statusLabel="Failed"
        label="Builder fee approved"
        detail="Approval is 0"
        fix={{ label: "Approve", href: "/settings" }}
      />,
    );
    expect(screen.getByText("Builder fee approved")).toHaveTextContent(
      "Failed: Builder fee approved",
    );
    expect(screen.getByRole("link", { name: "Approve" })).toHaveAttribute("href", "/settings");
    await expectNoAxeViolations();
  });

  it("hides the fix link when the check passes", () => {
    render(
      <ChecklistRow
        status="pass"
        statusLabel="Passed"
        label="Builder fee approved"
        fix={{ label: "Approve", href: "/settings" }}
      />,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("WalletSignaturePreview", () => {
  it("lists the fields the wallet will sign", async () => {
    render(
      <WalletSignaturePreview
        title="You will sign"
        action="AddAPIKeyWithBuilder"
        fields={[
          { label: "maxFeeRate", value: "50", emphasis: true },
          { label: "name", value: "DRIFT" },
        ]}
        note="Withdraw or transfer: never"
      />,
    );
    expect(screen.getByText("AddAPIKeyWithBuilder")).toBeInTheDocument();
    expect(screen.getByText("maxFeeRate").nextSibling).toHaveTextContent("50");
    expect(screen.getByText("Withdraw or transfer: never")).toBeInTheDocument();
    await expectNoAxeViolations();
  });
});

describe("BacktestPanel", () => {
  const base: BacktestPanelProps = {
    title: "Backtest",
    disclaimer: "Simulation on past prices. Not a forecast.",
    status: "empty",
    runLabel: "Run backtest",
    onRun: vi.fn(),
    emptyTitle: "Not run yet",
    errorTitle: "Backtest failed",
    missingLabel: "Not available",
  };

  it("always shows the disclaimer and runs on click", async () => {
    const onRun = vi.fn();
    render(<BacktestPanel {...base} onRun={onRun} />);
    expect(screen.getByText(base.disclaimer)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Run backtest" }));
    expect(onRun).toHaveBeenCalledOnce();
    await expectNoAxeViolations();
  });

  it("shows progress and locks the button while running", async () => {
    render(
      <BacktestPanel
        {...base}
        status="loading"
        progress={{ label: "Simulating", percent: 42.4 }}
      />,
    );
    expect(screen.getByRole("progressbar", { name: "Simulating" })).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
    expect(screen.getByRole("button", { name: "Run backtest" })).toBeDisabled();
    await expectNoAxeViolations();
  });

  it("shows an error state", async () => {
    render(<BacktestPanel {...base} status="error" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Backtest failed");
    await expectNoAxeViolations();
  });

  it("shows metrics, missing values and stale badge", async () => {
    render(
      <BacktestPanel
        {...base}
        status="ready"
        metrics={[
          { label: "Net PnL", value: "+12.40 USDC" },
          { label: "Max drawdown", value: null },
        ]}
        stale={{ label: "Parameters changed" }}
      />,
    );
    expect(screen.getByText("+12.40 USDC")).toBeInTheDocument();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.getByText("Parameters changed")).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it("explains why backtest is unavailable", async () => {
    render(<BacktestPanel {...base} unavailableReason="Backtest unavailable for this market" />);
    const button = screen.getByRole("button", { name: "Run backtest" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Backtest unavailable for this market");
    await expectNoAxeViolations();
  });
});

describe("AppShell and PageHeader", () => {
  it("renders landmarks, skip link and the current nav item", async () => {
    render(
      <AppShell
        brand={<span>DRIFT</span>}
        navLabel="Main"
        skipLinkLabel="Skip to content"
        navItems={[
          { key: "overview", label: "Overview", href: "/", icon: <svg />, current: true },
          { key: "lab", label: "Strategy Lab", href: "/bots", icon: <svg /> },
        ]}
      >
        <PageHeader title="Overview" description="Your bots at a glance" />
      </AppShell>,
    );
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main");
    const current = screen.getAllByRole("link", { name: "Overview" });
    expect(current.every((l) => l.getAttribute("aria-current") === "page")).toBe(true);
    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it("splits secondary nav items and renders header extras in the page header", () => {
    render(
      <AppShell
        brand="DRIFT"
        navLabel="Main"
        skipLinkLabel="Skip to content"
        headerExtras={<span>SoDEX connected</span>}
        sidebarFooter={<span>Emergency</span>}
        navItems={[
          { key: "overview", label: "Overview", href: "/", icon: <svg />, current: true },
          {
            key: "settings",
            label: "Settings",
            href: "/settings",
            icon: <svg />,
            group: "secondary",
          },
        ]}
      >
        <PageHeader title="Overview" />
      </AppShell>,
    );
    const header = screen.getByRole("banner");
    expect(header).toHaveTextContent("SoDEX connected");
    expect(screen.getByText("Emergency")).toBeInTheDocument();
    const [desktopNav] = screen.getAllByRole("navigation", { name: "Main" });
    expect(desktopNav?.querySelectorAll("ul")).toHaveLength(2);
  });

  it("mobile nav shows a featured item and a More sheet with the remaining pages", async () => {
    const item = (key: string, label: string) => ({ key, label, href: `/${key}`, icon: <svg /> });
    render(
      <AppShell
        brand="DRIFT"
        navLabel="Main"
        skipLinkLabel="Skip to content"
        navItems={[item("home", "Overview")]}
        mobileNav={{
          items: [item("home", "Home"), item("agent", "Agent")],
          featuredKey: "agent",
          more: {
            label: "More",
            icon: <svg />,
            items: [{ ...item("risk", "Risk Center"), current: true }],
          },
        }}
      >
        <p>content</p>
      </AppShell>,
    );
    expect(screen.getByRole("link", { name: "Agent" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Risk Center" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const sheet = screen.getByRole("dialog", { name: "More" });
    expect(within(sheet).getByRole("link", { name: "Risk Center" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("renders nothing for header extras outside AppShell", () => {
    const { container } = render(<ShellHeaderExtras />);
    expect(container).toBeEmptyDOMElement();
  });

  it("uses a custom link renderer", () => {
    render(
      <AppShell
        brand="DRIFT"
        navLabel="Main"
        skipLinkLabel="Skip to content"
        navItems={[{ key: "lab", label: "Strategy Lab", href: "/bots", icon: <svg /> }]}
        renderLink={({ children, ...props }) => (
          <a {...props} data-custom="yes">
            {children}
          </a>
        )}
      >
        <p>Body</p>
      </AppShell>,
    );
    expect(screen.getAllByRole("link", { name: "Strategy Lab" })[0]).toHaveAttribute(
      "data-custom",
      "yes",
    );
  });
});
