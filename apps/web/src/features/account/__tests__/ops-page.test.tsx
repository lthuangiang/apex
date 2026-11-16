// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { TeamOpsBot, TeamOpsView } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { OpsPage, opsQueryKey } from "../components/ops-page";

// Trang Bot Monitor (tên cũ Ops; docs/mockups/ops): ô tóm tắt, tab, mở dòng, bộ lọc Show + URL, rỗng / lỗi / cũ / 403,
// axe ở 1440 (bảng) và 390 (thẻ). Số thiếu → "Not available" / "n/a", không bao giờ 0.

const env = vi.hoisted(() => ({
  mode: "ok",
  mobile: false,
  search: "",
  calls: [] as string[],
  replaced: [] as string[],
}));
vi.mock("@/components/workspace", () => ({
  Workspace: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageHead: ({
    title,
    subtitle,
    action,
  }: {
    title: string;
    subtitle: ReactNode;
    action?: ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      <div>{subtitle}</div>
      {action}
    </header>
  ),
  Card: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("@/features/bots", () => ({
  useStateLabel: () => (b: { state: string }) => ({ state: b.state, label: b.state }),
}));
vi.mock("@/lib/use-media", () => ({ BELOW_LG: "", useMediaQuery: () => env.mobile }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(env.search),
  useRouter: () => ({
    replace: (url: string) => {
      env.replaced.push(url);
    },
  }),
}));
vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    ApiError,
    api: (_m: string, path: string) => {
      env.calls.push(path);
      if (env.mode === "forbidden") return Promise.reject(new ApiError("FORBIDDEN"));
      if (env.mode === "error") return Promise.reject(new ApiError("INTERNAL"));
      return Promise.resolve(env.mode === "empty" ? emptyView : view(path));
    },
  };
});

const NOW = new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const U = "01a1d823-0000-7000-8000-0000000000aa";

const mm = (over: Partial<TeamOpsBot>): TeamOpsBot => ({
  botId: "01a1d823-0000-7000-8000-00000000d50d",
  userId: U,
  name: "SOL quotes",
  strategy: "volume_maker",
  market: "SOL-USD",
  state: "running",
  reasonCode: null,
  createdAt: ago(2 * 86_400_000),
  stopAt: null,
  health: "healthy",
  reasons: [],
  costPerMillion: "182.4",
  costScope: "day",
  volumeHour: "412300",
  volumeDay: "9840000",
  makerSharePct: "96.1",
  smartQuoting: true,
  requestsPerMinute: "48.2",
  maxQuoteGapSec: "3.1",
  positionCutsDay: 0,
  positionCutsHour: 0,
  untrackedCancels: 0,
  positionPct: "41",
  alert: null,
  vb: null,
  log: [],
  ...over,
});

const problem = mm({
  name: "SOL quotes",
  health: "problem",
  reasons: [
    {
      code: "alert_active",
      invariant: "P1",
      at: ago(3_600_000),
      detail: "position 1,180 USDC over limit 1,050 USDC",
    },
  ],
  positionPct: "112",
  alert: { invariant: "P1", status: "active", at: ago(3_600_000), detail: "x" },
  log: [
    { at: ago(60_000), name: "Position cut", why: "Closed 5.2 at market.", alert: null },
    { at: ago(3_600_000), name: "P1", why: "position over limit", alert: "failing" },
  ],
});
const basic = mm({
  botId: "01a1d823-0000-7000-8000-00000000d50e",
  name: "BTC basic quotes",
  smartQuoting: false,
  requestsPerMinute: null,
  maxQuoteGapSec: null,
  volumeHour: null,
  costPerMillion: null,
});
const vb = mm({
  botId: "01a1d823-0000-7000-8000-00000000d50f",
  name: "ETH taker run",
  strategy: "volume_farm",
  market: "ETH-USD",
  health: "check",
  reasons: [{ code: "rejects", count: 1, at: ago(3_600_000) }],
  smartQuoting: null,
  requestsPerMinute: null,
  maxQuoteGapSec: null,
  positionPct: null,
  vb: {
    rounds: 302,
    roundsWon: 148,
    avgNet: "-1.92",
    entriesPostOnly: 0,
    entriesMarket: 302,
    takerAfter: 0,
    exits: {
      takeProfit: 88,
      earlyProfit: 41,
      holdEnded: 120,
      maxHold: 30,
      botStop: 12,
      sodexStop: 11,
    },
    waits: { counterTrend: 0, spread: 0, sideways: 0, stale: 0, belowMinimum: 0, blockedHour: 0 },
    marketRejects: 1,
  },
});

const strat = {
  running: 4,
  paused: 1,
  stopping: 1,
  stoppedDay: 0,
  volumeHour: "715600",
  volumeDay: "20720000",
  costPerMillion: "249.89",
  makerSharePct: "94",
  rounds: 0,
  roundsWonPct: null,
};
const summary: TeamOpsView["summary"] = {
  total: {
    ...strat,
    running: 7,
    volumeHour: "1210000",
    volumeDay: "34400000",
    costPerMillion: "278.42",
  },
  volume_maker: strat,
  volume_farm: {
    ...strat,
    running: 3,
    volumeHour: null,
    costPerMillion: null,
    rounds: 645,
    roundsWonPct: "52",
  },
  alerts: [{ botId: problem.botId, name: "SOL quotes", invariant: "P1" }],
  alertBots: 1,
  problem: 1,
  check: 1,
};
function view(path: string): TeamOpsView {
  const all = path.includes("show=all");
  return {
    checkedAt: NOW,
    show: all ? "all" : "active",
    summary,
    attention: [problem, vb],
    bots: all ? [basic] : [problem, vb, basic],
    counts: all ? { volume_maker: 51, volume_farm: 3 } : { volume_maker: 2, volume_farm: 1 },
    page: all ? { strategy: "volume_maker", page: 1, pageSize: 50, total: 51 } : null,
  };
}
const emptyView: TeamOpsView = {
  checkedAt: NOW,
  show: "active",
  summary: {
    total: {
      ...strat,
      running: 0,
      paused: 0,
      stopping: 0,
      volumeHour: null,
      volumeDay: null,
      costPerMillion: null,
      makerSharePct: null,
    },
    volume_maker: strat,
    volume_farm: strat,
    alerts: [],
    alertBots: 0,
    problem: 0,
    check: 0,
  },
  attention: [],
  bots: [],
  counts: { volume_maker: 0, volume_farm: 0 },
  page: null,
};

const show = (client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <OpsPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

// jsdom không tính được màu thật: tắt color-contrast như các test axe khác.
const AXE = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
  rules: { "color-contrast": { enabled: false } },
};

afterEach(() => {
  Object.assign(env, { mode: "ok", mobile: false, search: "", calls: [], replaced: [] });
  cleanup();
});

describe("Bot Monitor page", () => {
  it("shows the six summary tiles with real numbers, and the i button explains each", async () => {
    const user = userEvent.setup({ delay: null });
    show();
    expect(
      await screen.findByRole("heading", { name: "Bot Monitor", level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByText("7 running")).toBeInTheDocument();
    expect(screen.getByText("1 paused · 1 stopping · 0 stopped in 24 h")).toBeInTheDocument();
    expect(screen.getByText("$1.21M")).toBeInTheDocument();
    expect(screen.getByText("$34.40M")).toBeInTheDocument();
    expect(screen.getByText("$278.42")).toBeInTheDocument();
    // Volume Builder không có volume 1 giờ: "Not available", không phải $0.
    expect(
      screen.getByText("Market Making $715.6K · Volume Builder Not available"),
    ).toBeInTheDocument();
    expect(screen.getByText("P1 on SOL quotes")).toBeInTheDocument();
    expect(screen.getByText("1 Problem · 1 Check")).toBeInTheDocument();
    const info = screen.getByRole("button", { name: "How cost per $1m, 24 h is counted" });
    expect(info).toHaveAttribute("aria-expanded", "false");
    await user.click(info);
    expect(info).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Same formula as Market hours\./)).toBeInTheDocument();
    // Look at these first: Problem trước, câu lý do theo giờ trình duyệt.
    const attn = screen.getByRole("region", { name: "Look at these first" });
    expect(
      within(attn)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining("P1 has been failing since"),
      expect.stringContaining("1 market entry refused at"),
    ]);
  });

  it("shows n/a for bots without Smart quoting and Not available for missing numbers", async () => {
    show();
    const table = await screen.findByRole("table", { name: "Market Making bots" });
    const row = within(table).getByText("BTC basic quotes").closest("tr");
    if (row === null) throw new Error("row missing");
    expect(within(row).getAllByText("n/a")).toHaveLength(2);
    expect(within(row).getAllByText("Smart quoting off")).toHaveLength(2);
    expect(within(row).getAllByText("Not available").length).toBeGreaterThanOrEqual(2);
    expect(within(row).getByRole("link", { name: "User ··000000aa" })).toHaveAttribute(
      "href",
      `/admin/users/${U}`,
    );
  });

  it("switches strategy tabs and keeps the tab on the URL", async () => {
    const user = userEvent.setup({ delay: null });
    show();
    const mmTab = await screen.findByRole("tab", { name: /Market Making/ });
    expect(mmTab).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: /Volume Builder/ }));
    expect(screen.getByRole("tab", { name: /Volume Builder/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const table = screen.getByRole("table", { name: "Volume Builder bots" });
    expect(within(table).getByText("ETH taker run")).toBeInTheDocument();
    expect(within(table).getByText("0 · 302")).toBeInTheDocument();
    expect(within(table).getByText("49% won")).toBeInTheDocument();
    expect(within(table).getByText("−1.92 USDC")).toBeInTheDocument();
    expect(env.replaced.at(-1)).toBe("/admin/bot-monitor?tab=vb");
    // Cột i ghi cách tính vào vùng live.
    await user.click(screen.getByRole("button", { name: "How Market rejects (24h) is computed" }));
    expect(screen.getByText(/3 in a row pauses the bot/)).toBeInTheDocument();
  });

  it("expands one row with why it got its label and its last decisions and alerts", async () => {
    const user = userEvent.setup({ delay: null });
    show();
    const btn = await screen.findByRole("button", { name: "Show details for SOL quotes" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    await user.click(btn);
    const hide = screen.getByRole("button", { name: "Hide details for SOL quotes" });
    expect(hide).toHaveAttribute("aria-expanded", "true");
    const panel = document.getElementById(hide.getAttribute("aria-controls") ?? "");
    if (panel === null) throw new Error("details missing");
    expect(within(panel).getByText("Why it’s labelled Problem")).toBeInTheDocument();
    expect(
      within(panel).getByText(
        /P1 has been failing since .*: position 1,180 USDC over limit 1,050 USDC\./,
      ),
    ).toBeInTheDocument();
    expect(within(panel).getByText("Alert · P1 failing")).toBeInTheDocument();
    expect(within(panel).getByText("Position cut")).toBeInTheDocument();
    // Chỉ mở một dòng mỗi lần.
    await user.click(screen.getByRole("button", { name: "Show details for BTC basic quotes" }));
    expect(screen.getByRole("button", { name: "Show details for SOL quotes" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText("Nothing over a threshold.")).toBeInTheDocument();
  });

  it("switches to All bots with paging and search, and keeps it on the URL", async () => {
    const user = userEvent.setup({ delay: null });
    show();
    await user.click(await screen.findByRole("button", { name: "All bots" }));
    expect(screen.getByRole("button", { name: "All bots" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(env.replaced.at(-1)).toBe("/admin/bot-monitor?show=all");
    await waitFor(() => {
      expect(env.calls.at(-1)).toBe("/api/v1/admin/ops?show=all&strategy=volume_maker&page=1");
    });
    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search bots" }), "BTC{Enter}");
    expect(env.replaced.at(-1)).toBe("/admin/bot-monitor?show=all&q=BTC");
    await waitFor(() => {
      expect(env.calls.at(-1)).toBe(
        "/api/v1/admin/ops?show=all&strategy=volume_maker&page=1&q=BTC",
      );
    });
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(env.replaced.at(-1)).toBe("/admin/bot-monitor?show=all&q=BTC&page=2");
  });

  it("reads the filter from the URL on load", async () => {
    env.search = "show=all&tab=vb&q=ETH&page=2";
    show();
    await waitFor(() => {
      expect(env.calls[0]).toBe("/api/v1/admin/ops?show=all&strategy=volume_farm&page=2&q=ETH");
    });
    expect(screen.getByRole("searchbox", { name: "Search bots" })).toHaveValue("ETH");
  });

  it("says so when no volume bot ran, with real zero counts and Not available amounts", async () => {
    env.mode = "empty";
    show();
    expect(
      await screen.findByText("No Market Making or Volume Builder bots ran in the last 24 hours."),
    ).toBeInTheDocument();
    expect(screen.getByText("0 running")).toBeInTheDocument();
    expect(screen.getAllByText("Not available").length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText("0 bots")).toHaveLength(2);
  });

  it("shows its own error when the first load fails", { timeout: 15_000 }, async () => {
    env.mode = "error";
    show();
    // Trang tự thử lại 2 lần (trừ 403) trước khi báo lỗi.
    const alert = await screen.findByRole("alert", undefined, { timeout: 10_000 });
    expect(within(alert).getByText("Couldn’t load Bot Monitor.")).toBeInTheDocument();
    expect(
      within(alert).getByText("No bot was changed. Try again in a moment."),
    ).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it(
    "keeps the last data and marks it stale when a refresh fails",
    { timeout: 15_000 },
    async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(opsQueryKey("active", "volume_maker", "", 1), {
        ...view(""),
        checkedAt: ago(2 * 60_000),
      });
      env.mode = "error";
      show(client);
      expect(
        await screen.findByText(
          /Couldn’t refresh at .*\. Showing data from .* \(2 min old\)\. We’ll try again in 30 s\./,
          undefined,
          {
            timeout: 10_000,
          },
        ),
      ).toBeInTheDocument();
      expect(screen.getAllByText("SOL quotes").length).toBeGreaterThan(0);
      expect(screen.queryByText(/Data is more than 5 min old/)).toBeNull();
    },
  );

  it("turns the stale bar red after 5 minutes", { timeout: 15_000 }, async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(opsQueryKey("active", "volume_maker", "", 1), {
      ...view(""),
      checkedAt: ago(6 * 60_000),
    });
    env.mode = "error";
    show(client);
    expect(
      await screen.findByText(
        "Data is more than 5 min old. Don’t rely on it for live decisions.",
        undefined,
        {
          timeout: 10_000,
        },
      ),
    ).toBeInTheDocument();
  });

  it("tells non-team users the page is for the team and offers no refresh", async () => {
    env.mode = "forbidden";
    show();
    expect(
      await screen.findByText("Bot Monitor is for the DeskLabs team only."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });

  it("has no accessibility violations at 1440 (table, row open)", async () => {
    const user = userEvent.setup({ delay: null });
    show();
    await user.click(await screen.findByRole("button", { name: "Show details for SOL quotes" }));
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }, 20_000);

  it("has no accessibility violations at 390 (cards with 44 px Details buttons)", async () => {
    env.mobile = true;
    const user = userEvent.setup({ delay: null });
    show();
    const list = await screen.findByRole("list", { name: "Market Making bots" });
    const details = within(list).getAllByRole("button", { name: "Details" });
    for (const b of details) expect(b.className).toContain("min-h-11");
    const first = details[0];
    if (first === undefined) throw new Error("no card");
    await user.click(first);
    expect(within(list).getByRole("button", { name: "Hide details" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Active" }).className).toContain("min-h-11");
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }, 20_000);
});
