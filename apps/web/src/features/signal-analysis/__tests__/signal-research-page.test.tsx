// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { researchClassifiersSchema, researchVersionsSchema } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import messages from "../../../../messages/en.json";
import { SignalResearchPage } from "../components/signal-research-page";

import { RESEARCH_SUMMARY, RESEARCH_TRADES } from "./research-fixtures";
import { BASELINE, CLASSIFIERS, V4, VERSIONS } from "./versions-fixtures";

// Signal Research BETA (#423; mockup docs/mockups/signal-research/menu-beta.html): cùng component với trang team, người dùng
// test không thấy ô Claude cost / độ trễ theo chặng, version của team chỉ xem, có My versions, nhãn tester hiện riêng.

const MINE_ID = "00000000-0000-4000-8000-000000000012";
const state = vi.hoisted(
  (): { flag: boolean | undefined; role: "user" | "team"; calls: string[] } => ({
    flag: true,
    role: "user",
    calls: [],
  }),
);

vi.mock("@/features/account/market-hours-time", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/account/market-hours-time")>();
  return { ...real, browserTimeZone: () => "Asia/Ho_Chi_Minh" };
});
vi.mock("@/lib/queries", () => ({
  useFeatures: () => ({
    data: state.flag === undefined ? undefined : { signalResearch: state.flag },
  }),
  useMe: () => ({ data: { id: "u", email: "t@drift.test", role: state.role } }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/use-media", () => ({
  useMediaQuery: () => false,
  BELOW_LG: "(max-width: 1023px)",
}));
vi.mock("@/components/workspace", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Workspace: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageHead: ({
    title,
    badge,
    subtitle,
    action,
  }: {
    title: string;
    badge?: ReactNode;
    subtitle: ReactNode;
    action?: ReactNode;
  }) => (
    <header>
      <h1>
        {title}
        {badge}
      </h1>
      <p>{subtitle}</p>
      {action}
    </header>
  ),
}));

const MINE = { ...V4, id: MINE_ID, number: 12, name: "BTC only", owner: "me" as const };
const TESTER_VERSIONS = researchVersionsSchema.parse({
  ...VERSIONS,
  items: [MINE, ...VERSIONS.items],
  running: 1,
  versionsTried: 2,
  extraCheck: false,
});
const TESTER_CLASSIFIERS = researchClassifiersSchema.parse({
  ...CLASSIFIERS,
  items: CLASSIFIERS.items.map((r, i) =>
    i === 0 ? { ...r, testers: { labeled: 3, compared: 2, agree: 1, agreePct: 50 } } : r,
  ),
});

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (method: string, path: string, schema: z.ZodType) => {
      state.calls.push(`${method} ${path}`);
      const p = new URL(path, "http://x").pathname;
      const tester = state.role === "user";
      if (p.endsWith("/signal-research/versions"))
        return Promise.resolve(schema.parse(tester ? TESTER_VERSIONS : VERSIONS));
      if (p.endsWith("/signal-research/classifiers"))
        return Promise.resolve(schema.parse(TESTER_CLASSIFIERS));
      if (p.endsWith("/signal-research/summary"))
        return Promise.resolve(
          schema.parse(
            tester
              ? {
                  ...RESEARCH_SUMMARY,
                  sources: [],
                  funnel:
                    RESEARCH_SUMMARY.funnel === null
                      ? null
                      : { ...RESEARCH_SUMMARY.funnel, claudeCost: null, claudeCostPerDay: null },
                }
              : RESEARCH_SUMMARY,
          ),
        );
      if (p.endsWith("/signal-research/trades"))
        return Promise.resolve(schema.parse(RESEARCH_TRADES));
      if (p.endsWith("/signal-research/articles"))
        return Promise.resolve(
          schema.parse({ items: [], nextCursor: null, total: 0, totalInRange: 0 }),
        );
      if (p.endsWith("/signal-research/latency") && tester)
        return Promise.reject(new real.ApiError("FORBIDDEN", 403));
      return Promise.reject(new real.ApiError("NOT_FOUND", 404));
    },
  };
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SignalResearchPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.flag = true;
  state.role = "user";
  state.calls = [];
  window.history.replaceState(null, "", "/signal-research");
});
afterEach(() => {
  cleanup();
});

async function noViolations() {
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
}

describe("Signal Research page (BETA, #423)", { timeout: 20_000 }, () => {
  it("without the flag the route is Not found", () => {
    state.flag = false;
    expect(() => wrap()).toThrow("NEXT_NOT_FOUND");
  });

  it("tester: same page as the team, BETA title, no Claude cost and no latency card", async () => {
    wrap();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Signal ResearchBETA");
    expect(
      screen.getByText(
        "Crypto news turned into signals, tested with paper trades before any real money.",
      ),
    ).toBeInTheDocument();
    await screen.findByText("From headline to trade", {}, { timeout: 5_000 });
    expect(screen.getByRole("heading", { name: "Is it working?" })).toBeInTheDocument();
    expect(screen.queryByText("Claude cost")).toBeNull();
    expect(screen.queryByText("Where the time goes")).toBeNull();
    // Không bao giờ gọi endpoint chỉ team.
    expect(state.calls.some((c) => c.includes("/latency"))).toBe(false);
    await noViolations();
  });

  it("team on the BETA route still sees the Claude cost", async () => {
    state.role = "team";
    wrap();
    expect(await screen.findByText("Claude cost", {}, { timeout: 5_000 })).toBeInTheDocument();
  });

  it("version picker: Team versions · view only, then My versions with the owner's running count", async () => {
    wrap();
    const picker = await screen.findByRole("combobox", { name: "Version" }, { timeout: 5_000 });
    const groups = picker.querySelectorAll("optgroup");
    expect([...groups].map((g) => g.label)).toEqual([
      "Team versions · view only",
      "My versions · 1 of 3 running",
    ]);
    const mine = within(groups[1] as HTMLElement).getAllByRole("option");
    expect(mine.map((o) => o.textContent)).toEqual(["My · BTC only (v12)"]);
    const team = within(groups[0] as HTMLElement).getAllByRole("option");
    expect(team.map((o) => o.textContent)).toContain(`Baseline (v${String(BASELINE.number)})`);
  });

  it("team versions are view only, My versions keep Pause / Stop; tester labels show separately", async () => {
    const user = userEvent.setup({ delay: null });
    wrap();
    await user.click(
      await screen.findByRole("button", { name: "Manage versions" }, { timeout: 5_000 }),
    );
    const own = await screen.findByRole("article", { name: "News bot v12 · BTC only" });
    expect(within(own).getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(within(own).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    const base = screen.getByRole("article", { name: "News bot v3 · Baseline" });
    expect(within(base).queryByRole("button", { name: "Pause" })).toBeNull();
    expect(within(base).queryByRole("button", { name: "Stop" })).toBeNull();
    // Vẫn chép được version của team thành version của mình.
    expect(within(base).getByRole("button", { name: "Copy to new version" })).toBeInTheDocument();
    const testers = await screen.findByTestId("sr-tester-labels");
    expect(testers).toHaveTextContent(
      "Test users: 3 labels, not counted · agree with the team on 1 of 2 (50%)",
    );
    await noViolations();
  });
});
