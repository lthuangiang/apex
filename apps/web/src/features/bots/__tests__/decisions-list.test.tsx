// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { DecisionsList } from "../components/decisions-list";
import type { BotEvent } from "../decision-groups";

// BD-02 Decisions (docs/mockups/bd02-decisions Main + Mobile): dòng gộp, pill Result link tới lệnh.

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const T0 = Date.parse("2026-11-16T07:43:00Z");
let n = 0;
const ev = (
  decision: string,
  secAgo: number,
  outcome: BotEvent["outcome"] = "cancelled",
  why: string | null = null,
): BotEvent => {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    type: "decision",
    decision,
    why,
    result: null,
    outcome,
    order: outcome === null ? null : `cl-abc-${String(n).padStart(3, "0")}`,
    occurredAt: new Date(T0 - secAgo * 1000).toISOString(),
  };
};

const BOT = "11111111-1111-4111-8111-111111111111";
const events = [
  ev("Position cut", 0, "filled", "Closed the whole position at market."),
  ...Array.from({ length: 7 }, (_, i) =>
    ev("Bid pulled", 10 + i * 5, i === 0 ? "filled" : "cancelled", "Bid moved"),
  ),
  ev("Order sent", 80, "unknown"),
  ev("Paused", 90, null),
];

const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );

afterEach(() => {
  cleanup();
});

const desktop = () => screen.getByRole("list", { name: "Decisions & actions" });

describe("Decisions & actions (BD-02)", () => {
  it("groups repeats, counts results worst first and links every result to its order", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<DecisionsList botId={BOT} events={events} why={(e) => e.why} legacy={(x) => x} />);
    const list = within(desktop());
    const group = list.getByRole("button", { name: /Bid pulled/ });
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(within(group).getByText("×7")).toBeInTheDocument();
    expect(
      within(group)
        .getAllByText(/^\d+ (filled|cancelled)$/)
        .map((s) => s.textContent),
    ).toEqual(["1 filled", "6 cancelled"]);
    // Single rows: pill links to the order, label from orders.status.*.
    const unknown = list.getByRole("link", { name: /^Unknown · reconciling\. Show order/ });
    const href = new URL(unknown.getAttribute("href") ?? "", "http://x");
    expect(href.pathname).toBe("/orders");
    expect(href.searchParams.get("botId")).toBe(BOT);
    expect(href.searchParams.get("order")).toMatch(/^cl-abc-/);
    expect(href.searchParams.get("decision")).toBe("Order sent");
    // Paused has no order: no pill.
    expect(list.getByText("Paused")).toBeInTheDocument();

    await user.click(group);
    expect(group).toHaveAttribute("aria-expanded", "true");
    const panel = within(desktop()).getByRole("list", { name: "7 Bid pulled decisions" });
    expect(within(panel).getAllByRole("link")).toHaveLength(5);
    await user.click(within(panel).getByRole("button", { name: "Show all 7" }));
    expect(within(panel).getAllByRole("link")).toHaveLength(7);
    expect(within(panel).getAllByRole("link")[0]).toHaveAccessibleName(/^Filled\. Show order …/);

    const r = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("390 px list: the group opens to its children with linked pills", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<DecisionsList botId={BOT} events={events} why={(e) => e.why} legacy={(x) => x} />);
    const mobile = screen.getByRole("list", { name: "Recent decisions" });
    const group = within(mobile).getByRole("button", { name: /Bid pulled/ });
    await user.click(group);
    const panel = within(mobile).getByRole("list", { name: "7 Bid pulled decisions" });
    expect(within(panel).getAllByRole("link")).toHaveLength(5);
  });

  it("shows the empty state", () => {
    wrap(<DecisionsList botId={BOT} events={[]} why={() => null} legacy={(x) => x} />);
    expect(screen.getByText("No decisions yet.")).toBeInTheDocument();
    expect(
      screen.getByText("Each decision appears here with its order, once the bot starts."),
    ).toBeInTheDocument();
  });
});
