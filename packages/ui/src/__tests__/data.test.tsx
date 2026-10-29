import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ActivityTimeline } from "../components/activity-timeline";
import { DataTable } from "../components/data-table";
import type { DataStatus } from "../lib/data-state";
import { expectNoAxeViolations } from "../test/axe";

interface Row {
  id: string;
  market: string;
  size: string;
}

const rows: Row[] = [
  { id: "1", market: "BTC-PERP", size: "0.010" },
  { id: "2", market: "ETH-PERP", size: "1.500" },
];

const regionProps = {
  label: "Orders",
  empty: { title: "No orders yet" },
  error: { title: "Could not load orders", retryLabel: "Retry", onRetry: vi.fn() },
};

function renderTable(status: DataStatus, stale = false) {
  return render(
    <DataTable<Row>
      {...regionProps}
      status={status}
      {...(stale ? { stale: { label: "Stale" } } : {})}
      caption="Open orders"
      rows={rows}
      getRowKey={(r) => r.id}
      columns={[
        { key: "market", header: "Market", cell: (r) => r.market },
        { key: "size", header: "Size", cell: (r) => r.size, numeric: true },
      ]}
    />,
  );
}

describe("DataTable", () => {
  it("shows a busy skeleton while loading", async () => {
    renderTable("loading");
    expect(screen.getByRole("region", { name: "Orders" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it("shows the empty state", async () => {
    renderTable("empty");
    expect(screen.getByText("No orders yet")).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it("shows the error state with retry", async () => {
    renderTable("error");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(regionProps.error.onRetry).toHaveBeenCalled();
    await expectNoAxeViolations();
  });

  it("renders rows inside a focusable scroll region with a stale badge", async () => {
    renderTable("ready", true);
    expect(screen.getByRole("table", { name: "Open orders" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByRole("region", { name: "Open orders" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByText("Stale")).toBeInTheDocument();
    await expectNoAxeViolations();
  });
});

describe("ActivityTimeline", () => {
  it("renders items in order with time and tone label", async () => {
    render(
      <ActivityTimeline
        {...regionProps}
        label="Decisions & actions"
        status="ready"
        items={[
          {
            id: "a",
            at: { dateTime: "2026-10-26T14:02:09Z", text: "2:02 PM" },
            title: "Placed buy order",
          },
          {
            id: "b",
            at: { dateTime: "2026-10-26T14:03:00Z", text: "2:03 PM" },
            title: "Order result unknown",
            tone: "unknown",
            toneLabel: "Unknown",
          },
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveTextContent("Unknown");
    await expectNoAxeViolations();
  });

  it.each(["loading", "empty", "error"] as const)("handles the %s state", async (status) => {
    render(<ActivityTimeline {...regionProps} status={status} items={[]} />);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    await expectNoAxeViolations();
  });
});
