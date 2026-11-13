// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { FollowAlertSelect, FollowingMenu } from "../components/follow-alert-select";

// Mức cảnh báo mỗi trader (DEC-209; PM chốt vị trí A).

const T = "0x84b2b687df7c99702e887849f8d99bfb0fed12f2";

interface Call {
  method: string;
  path: string;
  body: unknown;
}
const state: { calls: Call[]; fail: boolean } = vi.hoisted(() => ({ calls: [], fail: false }));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (method: string, path: string, _s: unknown, opts?: { body?: unknown }) => {
      state.calls.push({ method, path, body: opts?.body });
      if (path === "/api/v1/following")
        return Promise.resolve({
          limit: 5,
          checkedEveryMs: 120000,
          traders: [],
          events: [],
          bigMoveAlerts: true,
        });
      if (state.fail) return Promise.reject(new real.ApiError("NETWORK", 0));
      if (path.endsWith("/follow/alerts")) {
        const level = (opts?.body as { level: string }).level;
        return Promise.resolve({ address: T, alertLevel: level });
      }
      return Promise.resolve({ following: false });
    },
  };
});

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

async function expectNoAxeViolations() {
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

beforeEach(() => {
  state.calls = [];
  state.fail = false;
});
afterEach(() => {
  cleanup();
});

describe("FollowAlertSelect (Following row)", () => {
  it("shows the level with a screen-reader label and saves a change", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<FollowAlertSelect address={T} trader="0x84b2…12f2" level="big_moves" />);
    const select = screen.getByRole("combobox", { name: "Alerts for 0x84b2…12f2" });
    expect(select).toHaveValue("big_moves");
    await user.selectOptions(select, "positions");
    await waitFor(() => {
      expect(state.calls).toContainEqual({
        method: "PUT",
        path: `/api/v1/traders/${T}/follow/alerts`,
        body: { level: "positions" },
      });
    });
    expect(screen.getByRole("option", { name: "New and closed positions" })).toBeInTheDocument();
    await expectNoAxeViolations();
  }, 15_000);

  it("shows an error instead of failing silently", async () => {
    state.fail = true;
    const user = userEvent.setup({ delay: null });
    wrap(<FollowAlertSelect address={T} trader="0x84b2…12f2" level="big_moves" />);
    await user.selectOptions(screen.getByRole("combobox"), "off");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

describe("FollowingMenu (trader profile)", () => {
  it("opens with the three levels and Unfollow; Escape closes and returns focus", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<FollowingMenu address={T} level="positions" />);
    const button = screen.getByRole("button", { name: /Following/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    expect(screen.getByRole("group", { name: "Alert me about" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /New and closed positions/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Big moves/ })).not.toBeChecked();
    await expectNoAxeViolations();
    await user.click(screen.getByRole("radio", { name: /^Off/ }));
    await waitFor(() => {
      expect(
        state.calls.some(
          (c) => c.method === "PUT" && (c.body as { level: string }).level === "off",
        ),
      ).toBe(true);
    });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Alert me about" })).toBeNull();
    expect(button).toHaveFocus();
  }, 15_000);

  it("Unfollow is in the menu", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<FollowingMenu address={T} level="big_moves" />);
    await user.click(screen.getByRole("button", { name: /Following/ }));
    await user.click(screen.getByRole("button", { name: "Unfollow" }));
    await waitFor(() => {
      expect(state.calls).toContainEqual(
        expect.objectContaining({ method: "DELETE", path: `/api/v1/traders/${T}/follow` }),
      );
    });
  });
});
