// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ArchitectureMap } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { codeParts, edgesOf, nodesOf, pointAt } from "../architecture-map";
import { ArchitecturePage } from "../components/architecture-page";

// System Architecture Diagram (team): nội dung chỉ đến từ api (role team). Ở đây dùng một bản đồ giả nhỏ; web không
// chứa nội dung thật.

const MAP: ArchitectureMap = {
  width: 400,
  height: 300,
  groups: [{ zone: "core", label: "Zone A", x: 10, y: 10, w: 380, h: 280 }],
  notes: [{ x: 200, y: 280, text: "Note A", boxed: false }],
  nodes: [
    { id: "a", x: 60, y: 80, icon: "user", tone: "ext", label: "Alpha", sub: "a-sub", facts: [] },
    {
      id: "b",
      x: 200,
      y: 80,
      icon: "cpu",
      tone: "app",
      label: "Beta",
      sub: "b-sub",
      facts: [{ label: "Role", value: "Does beta things." }],
    },
    { id: "c", x: 330, y: 200, icon: "db", tone: "db", label: "Gamma", sub: "c-sub", facts: [] },
  ],
  edges: [
    {
      id: "ab",
      from: "a",
      to: "b",
      points: [
        [88, 70],
        [172, 70],
      ],
    },
    {
      id: "bc",
      from: "b",
      to: "c",
      points: [
        [200, 132],
        [200, 190],
        [302, 190],
      ],
    },
  ],
  legend: [{ tone: "app", label: "Service" }],
  flows: [
    {
      id: "one",
      kind: "HTTP",
      title: "Flow one",
      lead: "Lead one",
      steps: [
        {
          edge: "ab",
          back: false,
          node: null,
          title: "Step A",
          body: "Calls <code>user.<id>.></code>",
        },
        { edge: null, back: false, node: "b", title: "Step B", body: "" },
      ],
    },
    {
      id: "two",
      kind: "JOB",
      title: "Flow two",
      lead: "Lead two",
      steps: [
        { edge: "bc", back: false, node: null, title: "Step C", body: "" },
        { edge: "bc", back: true, node: null, title: "Step D", body: "" },
      ],
    },
  ],
  defaultFlow: "one",
};

const state = vi.hoisted((): { forbidden: boolean } => ({ forbidden: false }));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: () =>
      state.forbidden ? Promise.reject(new real.ApiError("FORBIDDEN", 403)) : Promise.resolve(MAP),
  };
});
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
  state.forbidden = false;
  window.history.replaceState(null, "", "/");
});

describe("architecture map helpers", () => {
  it("finds the icons and step numbers of a flow", () => {
    const [one, two] = MAP.flows;
    if (one === undefined || two === undefined) throw new Error("fixture");
    expect([...nodesOf(MAP, one)].sort()).toEqual(["a", "b"]);
    expect(edgesOf(two)).toEqual([{ edge: "bc", steps: [1, 2], back: true }]);
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

  it("splits <code> parts without treating the rest as HTML", () => {
    expect(codeParts("Calls <code>user.<id>.></code> now")).toEqual([
      { code: false, text: "Calls " },
      { code: true, text: "user.<id>.>" },
      { code: false, text: " now" },
    ]);
  });
});

describe("System Architecture Diagram page", () => {
  it("draws the map from the API, switches flows and shows icon details", async () => {
    const user = userEvent.setup({ delay: null });
    wrap();
    const steps = () =>
      within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem");
    await waitFor(() => {
      expect(steps()).toHaveLength(2);
    });
    expect(screen.getByRole("button", { name: /Flow one/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("user.<id>.>").tagName).toBe("CODE");

    await user.click(screen.getByRole("button", { name: /Flow two/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Flow two" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#two");

    await user.click(screen.getByRole("button", { name: "Beta" }));
    expect(screen.getByRole("heading", { level: 3, name: "Beta" })).toBeInTheDocument();
    expect(screen.getByText("Does beta things.")).toBeInTheDocument();

    // color-contrast tắt vì jsdom không tính được màu; cặp màu của trang được kiểm ở packages/ui tokens.test.ts.
    const r = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }, 20_000);

  it("selects an icon and pins a step with the keyboard", async () => {
    const user = userEvent.setup({ delay: null });
    wrap();
    const beta = await screen.findByRole("button", { name: "Beta" });
    beta.focus();
    await user.keyboard("{Enter}");
    expect(beta).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { level: 3, name: "Beta" })).toBeInTheDocument();

    const gamma = screen.getByRole("button", { name: "Gamma" });
    gamma.focus();
    await user.keyboard(" ");
    expect(gamma).toHaveAttribute("aria-pressed", "true");
    expect(beta).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("heading", { level: 3, name: "Gamma" })).toBeInTheDocument();

    const step = screen.getByRole("button", { name: /Step A/ });
    expect(step).toHaveAttribute("aria-pressed", "false");
    step.focus();
    await user.keyboard("{Enter}");
    expect(step).toHaveAttribute("aria-pressed", "true");
    await user.keyboard(" ");
    expect(step).toHaveAttribute("aria-pressed", "false");
  });

  it("opens the flow named in the link", async () => {
    window.history.replaceState(null, "", "/admin/architecture#two");
    wrap();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Flow two/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  });

  it("shows only a message when the API says the user is not on the team", async () => {
    state.forbidden = true;
    wrap();
    expect(await screen.findByText("This page is for the DeskLabs team only.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "DeskLabs system diagram" })).toBeNull();
  });
});
