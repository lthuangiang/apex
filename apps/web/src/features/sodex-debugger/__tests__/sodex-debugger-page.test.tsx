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
import { SodexDebuggerPage } from "../components/sodex-debugger-page";

import { ADDRESS, CANCEL, DETAIL, FACETS, page, PLACE, SLOW, SUMMARY } from "./fixtures";

// SoDEX Debugger (team): dữ liệu chỉ đến từ api; ở đây api giả trả fixture đã qua đúng zod schema của web.

type Mode = "ok" | "forbidden" | "error" | "empty" | "pending";
const state = vi.hoisted((): { mode: Mode; paths: string[] } => ({ mode: "ok", paths: [] }));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (_method: string, path: string, schema: z.ZodType) => {
      state.paths.push(path);
      if (state.mode === "forbidden") return Promise.reject(new real.ApiError("FORBIDDEN", 403));
      if (state.mode === "pending") return new Promise(() => undefined);
      const url = new URL(path, "http://x");
      if (url.pathname.endsWith("/summary")) return Promise.resolve(schema.parse(SUMMARY));
      if (url.pathname.endsWith("/facets")) return Promise.resolve(schema.parse(FACETS));
      if (url.pathname === "/api/v1/admin/sodex-calls") {
        if (state.mode === "error") return Promise.reject(new real.ApiError("INTERNAL_ERROR", 500));
        const items = state.mode === "empty" ? [] : [CANCEL, PLACE, SLOW];
        return Promise.resolve(schema.parse(page(items)));
      }
      return Promise.resolve(schema.parse(DETAIL));
    },
  };
});
vi.mock("@/components/workspace", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Workspace: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageHead: ({ title, action }: { title: string; action?: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {action}
    </header>
  ),
}));

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SodexDebuggerPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const writeText = vi.fn(() => Promise.resolve());
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  writeText.mockClear();
});
afterEach(() => {
  cleanup();
  state.mode = "ok";
  state.paths = [];
  window.history.replaceState(null, "", "/");
});

async function noViolations() {
  // color-contrast tắt vì jsdom không tính được màu; cặp màu token được kiểm ở packages/ui.
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
}

const openButton = (name: RegExp) => screen.getAllByRole("button", { name })[0];
const lastListPath = () =>
  [...state.paths].reverse().find((p) => p.startsWith("/api/v1/admin/sodex-calls?")) ?? "";

// axe trên cả trang chậm khi cả bộ test chạy song song.
describe("SoDEX Debugger page", { timeout: 30_000 }, () => {
  it("lists calls, the summary and endpoint stats from the API", async () => {
    wrap();
    const table = await screen.findByRole("table", { name: "SoDEX calls, newest first" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByText("order rejected: OrderNotFound")).toBeInTheDocument();
    expect(within(table).getByText("Slow")).toBeInTheDocument();
    expect(within(table).getByText("▲ 1,840 ms")).toBeInTheDocument();
    expect(screen.getByText(/1,284 stored in the last 24 hours/)).toBeInTheDocument();
    expect((await screen.findAllByText("182,406")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("0.34%").length).toBeGreaterThan(0);
    expect(screen.getByText("▲ 41")).toBeInTheDocument();
    expect(screen.getByText(/PostOnly is 81% of the rejects on new orders/)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Kept for 14 days: every error, timeout and call over 1,000 ms. Successful calls are kept for 3 days.",
      ),
    ).toBeInTheDocument();
    // Địa chỉ đầy đủ không bao giờ hiện trên trang.
    expect(document.body.textContent).not.toContain(ADDRESS);
    await noViolations();
  });

  it("filters by outcome and by an hour of the timeouts chart", async () => {
    const user = userEvent.setup({ delay: null });
    wrap();
    await screen.findByRole("table", { name: "SoDEX calls, newest first" });
    await user.click(screen.getByRole("radio", { name: /Timeouts/ }));
    await waitFor(() => {
      expect(lastListPath()).toContain("show=timeouts");
    });
    expect(screen.getByRole("radio", { name: /Timeouts/ })).toHaveAttribute("aria-checked", "true");
    await user.click(
      await screen.findByRole("button", {
        name: /15:00–16:00 UTC: 37 timeouts\. Show these calls/,
      }),
    );
    await waitFor(() => {
      expect(lastListPath()).toContain("after=2026-11-17T15%3A00%3A00Z");
    });
    expect(lastListPath()).toContain("before=2026-11-17T16%3A00%3A00Z");
    await user.click(screen.getByRole("button", { name: "Remove the 15:00–16:00 UTC filter" }));
    await waitFor(() => {
      expect(lastListPath()).not.toContain("after=");
    });
  });

  it("opens a call with Enter, moves with j/k, switches tabs and closes with Esc", async () => {
    const user = userEvent.setup({ delay: null });
    wrap();
    await screen.findByRole("table", { name: "SoDEX calls, newest first" });
    await user.keyboard("{Enter}");
    const detail = await screen.findByRole("region", { name: /DELETE/ });
    expect(await within(detail).findByText("Why it’s unreadable")).toBeInTheDocument();
    expect(within(detail).getAllByText("Signature redacted").length).toBeGreaterThan(0);
    expect(within(detail).getByText("Key masked")).toBeInTheDocument();
    // Không có giá trị chữ ký nào trên trang.
    expect(document.body.textContent).not.toMatch(/0x0[12][0-9a-f]{20,}/i);
    await noViolations();

    const tabs = within(detail).getAllByRole("tab");
    tabs[0]?.focus();
    await user.keyboard("{ArrowRight}");
    expect(within(detail).getByRole("tab", { name: "Response" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(detail).getByText("0 (envelope) · -1 (order)")).toBeInTheDocument();
    await user.click(within(detail).getByRole("tab", { name: "Context" }));
    expect(within(detail).getByText("7f3c9a1e5b2d4c08")).toBeInTheDocument();
    expect(within(detail).getByText(/0x4E1e…29Db/)).toBeInTheDocument();

    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard("j");
    await waitFor(() => {
      expect(openButton(/POST \/perps\/trade\/orders, Ok/)).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });
    await user.keyboard("k");
    await waitFor(() => {
      expect(openButton(/DELETE \/perps\/trade\/orders/)).toHaveAttribute("aria-expanded", "true");
    });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: /DELETE/ })).not.toBeInTheDocument();
  });

  it("builds the report with the full address and masks it when unchecked", async () => {
    const user = userEvent.setup({ delay: null });
    wrap();
    await screen.findByRole("table", { name: "SoDEX calls, newest first" });
    await user.click(openButton(/DELETE \/perps\/trade\/orders/) ?? document.body);
    await screen.findByText("Why it’s unreadable");
    await user.keyboard("c");
    const dialog = await screen.findByRole("dialog", { name: "Report for SoDEX" });
    const text = () => within(dialog).getByLabelText("Report text").textContent;
    expect(text()).toContain(`Account:      ${ADDRESS} (accountID 20417)`);
    expect(text()).not.toContain("X-API-Sign");
    await noViolations();
    await user.click(within(dialog).getByRole("checkbox", { name: "Full account address" }));
    expect(text()).not.toContain(ADDRESS);
    expect(text()).toContain("0x4E1e…29Db");
    await user.click(within(dialog).getByRole("button", { name: "Copy text" }));
    // userEvent thay navigator.clipboard bằng bản giả của nó.
    expect(await navigator.clipboard.readText()).toBe(text());
    expect(
      await within(dialog).findByText("Copied. Paste it into your SoDEX ticket."),
    ).toBeInTheDocument();
  });

  it("opens the call from ?call= in a copied link", async () => {
    window.history.replaceState(null, "", `/admin/sodex-debugger?call=${DETAIL.id}`);
    wrap();
    expect(await screen.findByText("Why it’s unreadable")).toBeInTheDocument();
  });

  it("shows the forbidden copy for people outside the team", async () => {
    state.mode = "forbidden";
    wrap();
    expect(await screen.findByText("This page is for the DeskLabs team only.")).toBeInTheDocument();
  });

  it("shows loading, empty and error states", async () => {
    state.mode = "pending";
    const first = wrap();
    expect(screen.getByText("Loading calls…")).toBeInTheDocument();
    first.unmount();

    state.mode = "empty";
    const second = wrap();
    expect(await screen.findByText("No calls match these filters")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Nothing in the last 24 hours. Successful calls are kept for 3 days, so an older Ok call may be gone.",
      ),
    ).toBeInTheDocument();
    await noViolations();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Last 14 days" }));
    expect(await screen.findByText("Nothing stored yet")).toBeInTheDocument();
    second.unmount();

    state.mode = "error";
    wrap();
    expect(await screen.findByText("Couldn’t load calls")).toBeInTheDocument();
    expect(
      screen.getByText("The DeskLabs API didn’t answer. This is not a SoDEX problem."),
    ).toBeInTheDocument();
  });
});
