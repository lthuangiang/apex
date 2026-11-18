// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import messages from "../../../../messages/en.json";
import { SignalAnalysisPage } from "../components/signal-analysis-page";

import { ALL, MM, MM_DETAIL, MM_FILLS, VB, VB_DETAIL, VB_ENTRIES } from "./fixtures";

// Signal Analysis (team): mọi số đến từ API; ở đây API giả trả fixture đã qua đúng zod schema của web.

type Mode = "ok" | "forbidden" | "error" | "empty" | "pending" | "thin" | "timeout" | "slow30";
const state = vi.hoisted((): { mode: Mode; paths: string[] } => ({ mode: "ok", paths: [] }));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (_method: string, path: string, schema: z.ZodType) => {
      state.paths.push(path);
      if (state.mode === "forbidden") return Promise.reject(new real.ApiError("FORBIDDEN", 403));
      if (state.mode === "error") return Promise.reject(new real.ApiError("INTERNAL_ERROR", 500));
      if (state.mode === "pending") return new Promise(() => undefined);
      const url = new URL(path, "http://x");
      if (state.mode === "timeout" && url.searchParams.get("range") === "30d")
        return Promise.reject(new real.ApiError("ANALYSIS_TIMEOUT", 503));
      if (state.mode === "slow30" && url.searchParams.get("range") === "30d")
        return new Promise(() => undefined);
      if (url.pathname.endsWith("/mm") && url.searchParams.get("range") === "14d")
        return Promise.resolve(schema.parse({ ...MM, range: "14d", markets: ["BTC-USD"] }));
      if (url.pathname.endsWith("/mm/quantiles"))
        return Promise.resolve(
          schema.parse({
            p25: [0.4, -1.2, -2.1, -2.9, -3.8, -5.6],
            p75: [1.2, 1.4, 1.6, 1.9, 2.4, 3.6],
          }),
        );
      const p = url.pathname;
      const empty = state.mode === "empty";
      const thin = state.mode === "thin";
      if (p.endsWith("/all"))
        return Promise.resolve(
          schema.parse(
            empty
              ? { ...ALL, total: { ...ALL.total, fills: 0 } }
              : thin
                ? { ...ALL, total: { ...ALL.total, fills: 22, thin: true } }
                : ALL,
          ),
        );
      if (p.endsWith("/vb")) return Promise.resolve(schema.parse(VB));
      if (p.endsWith("/vb/entries")) return Promise.resolve(schema.parse(VB_ENTRIES));
      if (p.includes("/vb/entries/")) return Promise.resolve(schema.parse(VB_DETAIL));
      if (p.endsWith("/mm")) return Promise.resolve(schema.parse(MM));
      if (p.endsWith("/mm/fills")) return Promise.resolve(schema.parse(MM_FILLS));
      return Promise.resolve(schema.parse(MM_DETAIL));
    },
  };
});
vi.mock("@/components/workspace", async (importOriginal) => ({
  ...(await importOriginal<object>()),
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
      <p>{subtitle}</p>
      {action}
    </header>
  ),
}));

const intlErrors: string[] = [];
function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider
        locale="en"
        messages={messages}
        timeZone="UTC"
        onError={(e) => {
          intlErrors.push(e.message);
        }}
      >
        <SignalAnalysisPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  state.mode = "ok";
  state.paths = [];
  intlErrors.length = 0;
  window.history.replaceState(null, "", "/admin/signal-analysis");
});
afterEach(() => {
  cleanup();
});

async function noViolations() {
  // color-contrast tắt vì jsdom không tính được màu; cặp màu token được kiểm ở packages/ui.
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
}

describe("Signal Analysis page", { timeout: 30_000 }, () => {
  it("All tab: KPIs, MM + VB only, accounts by account id, Not available for missing values", async () => {
    wrap();
    expect(await screen.findByText("Last 7 days · 2.00M USDC volume")).toBeInTheDocument();
    const sum = screen.getByRole("region", { name: /Last 7 days · 2.00M USDC volume/ });
    expect(within(sum).getByText("Net cost / $1M (negative = net gain)")).toBeInTheDocument();
    expect(within(sum).getAllByText("$222").length).toBeGreaterThan(0);
    // Chỉ hai chiến lược, không Copy Trade / Futures Grid.
    expect(screen.queryByText(/Copy Trade|Futures Grid/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Volume Builder").length).toBeGreaterThan(0);
    // Account, không email.
    expect(screen.getAllByText("Account ··7c21e0b4").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/@/);
    // Kỳ trước thiếu → "Not available", không phải $0.
    expect(screen.getAllByText("vs before: Not available").length).toBeGreaterThan(0);
    // Hiệu "vs previous" lấy nguyên từ API (vsPrev), web không tự trừ.
    expect(screen.getAllByText(/▼ \$23 vs previous 7 days/).length).toBeGreaterThan(0);
    // Múi giờ trình duyệt + nút Show in UTC (cùng kiểu Market hours).
    expect(screen.getByText(/Times in your time zone: /)).toBeInTheDocument();
    const utc = screen.getByRole("button", { name: "Show in UTC" });
    await userEvent.click(utc);
    expect(screen.getByText("Times in UTC")).toBeInTheDocument();
    await waitFor(() => {
      expect(state.paths.some((p) => p.includes("tz=UTC"))).toBe(true);
    });
    expect(screen.getByText("Read only")).toBeInTheDocument();
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("VB tab: summary, suggestion with Needs approval, hidden thin lead, breakdown, entry detail", async () => {
    wrap();
    await userEvent.click(await screen.findByRole("tab", { name: /Volume Builder/ }));
    expect(await screen.findByText("Last 7 days · 1,284 entries")).toBeInTheDocument();
    expect(
      screen.getByText("Don’t enter after a fast move in the signal’s direction"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Needs approval").length).toBeGreaterThan(0);
    expect(screen.getByText(/1 lead hidden/)).toBeInTheDocument();
    // 10 s / 30 s không có giá theo giây → Not available.
    const mk = screen.getByRole("table", { name: "Markout after the fill, in bp" });
    expect(within(mk).getAllByText("Not available").length).toBeGreaterThan(0);
    const bd = screen.getByRole("table", { name: "Results by Regime" });
    expect(within(bd).getByText("Very volatile")).toBeInTheDocument();
    expect(within(bd).getAllByText("Thin sample").length).toBe(1);
    await userEvent.click(screen.getByRole("tab", { name: "Exit reason" }));
    expect(screen.getByRole("table", { name: "Results by Exit reason" })).toBeInTheDocument();
    expect(screen.getByText("Stop on SoDEX")).toBeInTheDocument();
    await noViolations();
    await userEvent.click(await screen.findByRole("button", { name: /\d\d:\d\d:\d\d/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Signal at entry")).toBeInTheDocument();
    expect(within(dialog).getByText("Volume acceleration")).toBeInTheDocument();
    expect(within(dialog).getByText("What-if")).toBeInTheDocument();
    expect(within(dialog).getByText(/Enter long: score 0.69/)).toBeInTheDocument();
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("MM tab: waterfall, suggestion, levels with fill rate, cuts, breakdown collapsed, fill detail", async () => {
    window.history.replaceState(null, "", "/admin/signal-analysis?tab=mm");
    wrap();
    expect(await screen.findByText("Last 7 days · 18,420 quote fills")).toBeInTheDocument();
    expect(screen.getByText("−$90 earned")).toBeInTheDocument();
    expect(screen.getByText("Default Where to quote to 1 step back")).toBeInTheDocument();
    expect(screen.getByText(/position cuts \(14 cuts\)/)).toBeInTheDocument();
    const lv = screen.getByRole("table", { name: "By quote level, bp per fill at 1 min" });
    expect(within(lv).getByText("4.1%")).toBeInTheDocument();
    expect(within(lv).getAllByText("Not available").length).toBe(1);
    // Breakdown mặc định chỉ "Where to quote".
    expect(
      screen.getByRole("table", { name: "Market Making fills by Where to quote" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Binance clamp" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show all groupings" }));
    await userEvent.click(screen.getByRole("tab", { name: "Binance clamp" }));
    expect(screen.getByText("Clamp hit")).toBeInTheDocument();
    await noViolations();
    const fills = screen.getByRole("table", { name: "Market Making fills" });
    await userEvent.click(within(fills).getByRole("button", { name: /09:12:41|\d\d:12:41/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("The quote at the fill")).toBeInTheDocument();
    expect(within(dialog).getByText("Not hit · 1.4 bp inside the limit")).toBeInTheDocument();
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("shows loading, error with retry, empty and thin sample states", async () => {
    state.mode = "pending";
    const a = wrap();
    expect(await screen.findByText("Loading fills…")).toBeInTheDocument();
    a.unmount();
    state.mode = "error";
    const b = wrap();
    // Lỗi 500 được thử lại một lần (như mặc định của app) rồi mới hiện trạng thái lỗi.
    expect(
      await screen.findByText("Couldn’t load the analysis", {}, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    b.unmount();
    state.mode = "empty";
    const c = wrap();
    expect(await screen.findByText("No fills on live bots in this range")).toBeInTheDocument();
    c.unmount();
    state.mode = "thin";
    wrap();
    expect(await screen.findByText("Thin sample: 22 fills.")).toBeInTheDocument();
  });

  it("tells people outside the team the page is team only", async () => {
    state.mode = "forbidden";
    wrap();
    expect(
      await screen.findByText("Signal Analysis is for the DeskLabs team only."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("a range that times out shows its own state; Show 7 days keeps the other filters", async () => {
    state.mode = "timeout";
    window.history.replaceState(null, "", "/admin/signal-analysis?tab=mm");
    wrap();
    await screen.findByText("Last 7 days · 18,420 quote fills");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Market" }), "ETH-USD");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Time" }), "30d");
    expect(await screen.findByText("This range took too long to load")).toBeInTheDocument();
    expect(screen.getByText("Try a shorter range. Filters stay as they are.")).toBeInTheDocument();
    // Không tự thử lại khi timeout: đúng một request cho kỳ 30 ngày.
    expect(state.paths.filter((p) => p.includes("/mm?") && p.includes("range=30d"))).toHaveLength(
      1,
    );
    await noViolations();
    await userEvent.click(screen.getByRole("button", { name: "Show 7 days" }));
    await waitFor(() => {
      expect(screen.queryByText("This range took too long to load")).not.toBeInTheDocument();
    });
    const last = [...state.paths].reverse().find((p) => p.includes("/mm?")) ?? "";
    expect(last).toContain("range=7d");
    expect(last).toContain("market=ETH-USD");
    // p25 / p75 từ endpoint riêng.
    expect(await screen.findAllByText("−2.9 to +1.9")).not.toHaveLength(0);
  });

  it("while a new range loads, the old numbers keep their own range label, dimmed with Loading…", async () => {
    state.mode = "slow30";
    window.history.replaceState(null, "", "/admin/signal-analysis?tab=mm");
    wrap();
    await screen.findByText("Last 7 days · 18,420 quote fills");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Time" }), "30d");
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    // Tiêu đề vẫn theo dữ liệu đang hiện (7 ngày), không theo bộ lọc mới (30 ngày).
    expect(screen.getByText("Last 7 days · 18,420 quote fills")).toBeInTheDocument();
    expect(screen.queryByText(/Last 30 days ·/)).not.toBeInTheDocument();
    expect(screen.getByText("Loading…").closest("[aria-busy]")).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("keeps the selected market listed when the new range has no fills for it", async () => {
    window.history.replaceState(null, "", "/admin/signal-analysis?tab=mm");
    wrap();
    await screen.findByText("Last 7 days · 18,420 quote fills");
    const market = screen.getByRole("combobox", { name: "Market" });
    await userEvent.selectOptions(market, "ETH-USD");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Time" }), "14d");
    await screen.findByText("Last 14 days · 18,420 quote fills");
    expect(
      within(market).getByRole("option", { name: "ETH-USD (no fills in this range)" }),
    ).toBeInTheDocument();
    expect(market).toHaveValue("ETH-USD");
  });
});
