import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MetricCard } from "../components/metric-card";
import { PnLValue } from "../components/pnl-value";
import { expectNoAxeViolations } from "../test/axe";

describe("PnLValue", () => {
  it("shows sign, arrow and tone for positive values", () => {
    render(<PnLValue value="1234.5" locale="en-US" missingLabel="Not available" suffix=" USDC" />);
    const el = screen.getByText(/1,234.5/);
    expect(el).toHaveTextContent("▲+1,234.5 USDC");
    expect(el).toHaveAttribute("data-sign", "positive");
  });

  it("shows a down arrow for losses", () => {
    render(<PnLValue value="-12.345" locale="en-US" missingLabel="Not available" />);
    const el = screen.getByText(/12.35/);
    expect(el).toHaveTextContent("▼-12.35");
    expect(el).toHaveAttribute("data-sign", "negative");
  });

  it("renders a real zero without arrow", () => {
    render(<PnLValue value="0" locale="en-US" missingLabel="Not available" />);
    expect(screen.getByText("0")).toHaveAttribute("data-sign", "zero");
  });

  it("never shows 0 when the backend sent nothing", () => {
    render(<PnLValue value={null} locale="en-US" missingLabel="Not available" />);
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});

describe("MetricCard", () => {
  const base = { label: "Net PnL", emptyLabel: "Not available" };

  it("shows a skeleton while loading", async () => {
    const { container } = render(<MetricCard {...base} status="loading" />);
    expect(container.querySelector("section")).toHaveAttribute("aria-busy", "true");
    await expectNoAxeViolations();
  });

  it("shows the empty label instead of 0", async () => {
    render(<MetricCard {...base} status="empty" />);
    expect(screen.getByText("Not available")).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it("shows an error with retry", async () => {
    const onRetry = vi.fn();
    render(
      <MetricCard
        {...base}
        status="error"
        errorLabel="Could not load"
        retryLabel="Retry"
        onRetry={onRetry}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load");
    await expectNoAxeViolations();
  });

  it("shows the value with a stale badge", async () => {
    render(
      <MetricCard
        {...base}
        status="ready"
        value="+120.00 USDC"
        stale={{ label: "Stale", updatedAt: { dateTime: "2026-10-26T14:02:09Z", text: "2:02 PM" } }}
      />,
    );
    expect(screen.getByText("+120.00 USDC")).toBeInTheDocument();
    expect(screen.getByText("Stale")).toBeInTheDocument();
    await expectNoAxeViolations();
  });
});
