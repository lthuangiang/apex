// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { EDGES, FLOW_IDS, FLOWS, NODE_IDS, nodesOf, pointAt } from "../architecture-map";
import { ArchitecturePage } from "../components/architecture-page";

// System Architecture Diagram (team): luồng đổi được, bước đánh số, chi tiết container, chỉ team.

const me = vi.hoisted((): { role: "team" | "user" } => ({ role: "team" }));

vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMe: () => ({ data: { role: me.role } }),
}));
vi.mock("@/components/workspace", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Workspace: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ArchitecturePage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  me.role = "team";
  window.history.replaceState(null, "", "/");
});

describe("architecture map data", () => {
  const arch = messages.architecture as unknown as {
    nodes: Record<string, { label: string; sub: string; facts: Record<string, string> }>;
    flows: Record<
      string,
      { title: string; steps: Record<string, { title: string; body: string }> }
    >;
  };

  it("has copy for every node and exactly one copy entry per step of every flow", () => {
    for (const id of NODE_IDS) expect(arch.nodes[id]?.label, id).toBeTruthy();
    for (const f of FLOW_IDS) {
      expect(Object.keys(arch.flows[f]?.steps ?? {}), f).toHaveLength(FLOWS[f].length);
    }
  });

  it("keeps every edge inside the drawing and ends it at its two icons", () => {
    for (const [id, e] of Object.entries(EDGES)) {
      for (const [x, y] of e.pts) {
        expect(x, id).toBeGreaterThanOrEqual(0);
        expect(x, id).toBeLessThanOrEqual(1140);
        expect(y, id).toBeGreaterThanOrEqual(0);
        expect(y, id).toBeLessThanOrEqual(780);
      }
    }
    expect(
      pointAt(
        [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
        0.5,
      ),
    ).toEqual([10, 0]);
  });

  it("dims what a flow does not touch", () => {
    const used = nodesOf("watch");
    expect(used.has("hyperliquid")).toBe(true);
    expect(used.has("signer")).toBe(false);
  });
});

describe("System Architecture Diagram page", () => {
  it("opens on Bot trades by itself, switches flows and shows container details", async () => {
    const user = userEvent.setup({ delay: null });
    wrap();
    expect(
      screen.getAllByRole("heading", { level: 1, name: "System Architecture Diagram" }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Bot trades by itself/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const steps = () =>
      within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem");
    expect(steps()).toHaveLength(FLOWS.auto.length);

    await user.click(screen.getByRole("button", { name: /Copy bot/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Copy bot" })).toBeInTheDocument();
    expect(steps()).toHaveLength(FLOWS.copy.length);
    expect(window.location.hash).toBe("#copy");

    await user.click(screen.getByRole("button", { name: "signer" }));
    expect(screen.getByRole("heading", { level: 3, name: "signer" })).toBeInTheDocument();
    expect(screen.getByText("secure (internal: true)")).toBeInTheDocument();

    const r = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }, 20_000);

  it("opens the flow named in the link", () => {
    window.history.replaceState(null, "", "/admin/architecture#watch");
    wrap();
    expect(screen.getByRole("button", { name: /Watch wallet/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows nothing but a message to non-team users", () => {
    me.role = "user";
    wrap();
    expect(
      screen.getByText("System Architecture Diagram is for the DeskLabs team only."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "DeskLabs containers and Docker networks" }),
    ).toBeNull();
  });
});
