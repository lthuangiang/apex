// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { ConnectedApps } from "../components/connected-apps";

// Settings › Connected apps dẫn tới trang hướng dẫn /claude (MCP M6, W7; mockup ConnectedApps.dc.html).

const state: { items: unknown[] } = vi.hoisted(() => ({ items: [] }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: () => Promise.resolve({ items: state.items }),
}));

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  state.items = [];
});

describe("Connected apps › How to connect Claude", () => {
  it("offers the guide when no app is connected", async () => {
    wrap(<ConnectedApps />);
    expect(await screen.findByText("No apps connected yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "How to connect Claude" })).toHaveAttribute(
      "href",
      "/claude",
    );
  });

  it("links to the guide under the list when apps are connected", async () => {
    state.items = [
      {
        clientId: "c1",
        name: "Claude",
        host: "claude.ai",
        scopes: ["read"],
        connectedAt: "2026-11-13T08:00:00.000Z",
        lastUsedAt: null,
      },
    ];
    wrap(<ConnectedApps />);
    expect(await screen.findByRole("button", { name: "Revoke" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "How to connect Claude →" })).toHaveAttribute(
      "href",
      "/claude",
    );
  });
});
