// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import messages from "../../../../messages/en.json";
import { McpStats } from "../components/stats-mcp";

// Mục "Claude (MCP)" ở Stats (DEC-225): số đếm thật; không có lượt gọi trong 24h thì tỷ lệ hiện
// "Not available" (không phải 0%) và bảng theo tool có câu trống.

const wrap = (node: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );

afterEach(cleanup);

describe("MCP stats", () => {
  it("shows Not available for rates when there were no calls, never 0%", async () => {
    const { container } = wrap(
      <McpStats
        status="ready"
        mcp={{
          connectedUsers: 3,
          calls24h: 0,
          byTool24h: [],
          deniedPct24h: null,
          rateLimitedPct24h: null,
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Claude (MCP)" })).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getAllByText("Not available")).toHaveLength(2);
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.getByText("No MCP calls in the last 24 hours.")).toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("lists calls by tool with errors", async () => {
    const { container } = wrap(
      <McpStats
        status="ready"
        mcp={{
          connectedUsers: 1,
          calls24h: 4,
          byTool24h: [
            { tool: "list_bots", calls: 3, errors: 1 },
            { tool: "get_bot", calls: 1, errors: 0 },
          ],
          deniedPct24h: "16.7",
          rateLimitedPct24h: "0",
        }}
      />,
    );
    expect(screen.getByText("16.7%")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Tool" })).toBeInTheDocument();
    expect(within(table).getByText("list_bots")).toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
