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
    entryTry: null,
    rejectCode: null,
    fillPrice: null,
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
    // The button is gone: focus moves to the 6th child, the first one just shown.
    expect(document.activeElement).toBe(within(panel).getAllByRole("listitem")[5]);
    expect(within(panel).getAllByRole("link")[0]).toHaveAccessibleName(/^Filled\. Show order …/);

    const r = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }, 20_000);

  it("390 px list: the group opens to its children with linked pills", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<DecisionsList botId={BOT} events={events} why={(e) => e.why} legacy={(x) => x} />);
    const mobile = screen.getByRole("list", { name: "Recent decisions" });
    const group = within(mobile).getByRole("button", { name: /Bid pulled/ });
    await user.click(group);
    const panel = within(mobile).getByRole("list", { name: "7 Bid pulled decisions" });
    expect(within(panel).getAllByRole("link")).toHaveLength(5);
  });

  it("an open group stays open when a new event joins it on the next poll", async () => {
    const user = userEvent.setup({ delay: null });
    const props = { botId: BOT, why: (e: BotEvent) => e.why, legacy: (x: string) => x };
    const view = wrap(<DecisionsList {...props} events={events} />);
    await user.click(within(desktop()).getByRole("button", { name: /Bid pulled/ }));
    const newer = { ...ev("Bid pulled", 5), occurredAt: new Date(T0 + 5_000).toISOString() };
    view.rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <DecisionsList {...props} events={[newer, ...events.slice(1)]} />
      </NextIntlClientProvider>,
    );
    const group = within(desktop()).getByRole("button", { name: /Bid pulled/ });
    expect(within(group).getByText("×8")).toBeInTheDocument();
    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(
      within(desktop()).getByRole("list", { name: "8 Bid pulled decisions" }),
    ).toBeInTheDocument();
  });

  it("390 px: after Show all, focus moves to the 6th child", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<DecisionsList botId={BOT} events={events} why={(e) => e.why} legacy={(x) => x} />);
    const mobile = screen.getByRole("list", { name: "Recent decisions" });
    await user.click(within(mobile).getByRole("button", { name: /Bid pulled/ }));
    const panel = within(mobile).getByRole("list", { name: "7 Bid pulled decisions" });
    await user.click(within(panel).getByRole("button", { name: "Show all 7" }));
    expect(document.activeElement).toBe(within(panel).getAllByRole("listitem")[5]);
  });

  it("shows the empty state", () => {
    wrap(<DecisionsList botId={BOT} events={[]} why={() => null} legacy={(x) => x} />);
    expect(screen.getByText("No decisions yet.")).toBeInTheDocument();
    expect(
      screen.getByText("Each decision appears here with its order, once the bot starts."),
    ).toBeInTheDocument();
  });
});

describe("Volume Farm entry rounds in Decisions (DEC-307)", () => {
  /** Một lượt 8 lần thử trong 2 phút: 5 post-only miss, 1 huỷ vì chưa khớp, 1 không gửi được, lần cuối khớp. */
  const round = (): BotEvent[] => {
    const outcomes: BotEvent["outcome"][] = [
      "filled",
      "rejected",
      "cancelled",
      "rejected",
      "not_placed",
      "rejected",
      "rejected",
      "rejected",
    ];
    return outcomes.map((outcome, i) => ({
      ...ev("Enter long", 30 + Math.round((i * 120) / 7), outcome, "Signal pointed long."),
      entryTry: 7 - i,
      rejectCode: outcome === "rejected" ? "PostOnly" : null,
      fillPrice: outcome === "filled" ? "1800.7" : null,
    }));
  };

  it("shows one row per round with its tries and fill, and each try with its result", async () => {
    const user = userEvent.setup({ delay: null });
    const list = [
      ev("Stop loss set on SoDEX", 0, null),
      ...round(),
      ev("Closed short", 200, "filled"),
    ];
    // Giá khớp trung bình nhiều trade (numeric 38,18) làm tròn theo tick của market, như trang Orders.
    const priced = list.map((e) =>
      e.fillPrice === null ? e : { ...e, fillPrice: "1800.733333333" },
    );
    wrap(
      <DecisionsList
        botId={BOT}
        events={priced}
        why={(e) => e.why}
        legacy={(x) => x}
        priceDigits={2}
      />,
    );
    const rows = within(desktop());
    const group = rows.getByRole("button", { name: /Enter long/ });
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(within(group).getByText("8 tries in 2 min")).toBeInTheDocument();
    expect(within(group).getByText("Filled at 1,800.73")).toBeInTheDocument();
    expect(
      within(group)
        .getAllByText(/^\d+ (filled|rejected|cancelled|not placed)$/)
        .map((x) => x.textContent),
    ).toEqual(["5 rejected", "1 filled", "1 cancelled", "1 not placed"]);
    await user.click(group);
    const panel = within(desktop()).getByRole("list", { name: "8 Enter long decisions" });
    const items = within(panel).getAllByRole("listitem");
    const item = (i: number) => {
      const el = items[i];
      if (el === undefined) throw new Error(`no try row ${String(i)}`);
      return within(el);
    };
    expect(item(0).getByText("Try 8 · Filled at 1,800.73")).toBeInTheDocument();
    expect(item(1).getByText("Try 7 · Post-only miss")).toBeInTheDocument();
    expect(item(2).getByText("Try 6 · Cancelled, not filled")).toBeInTheDocument();
    expect(item(4).getByText("Try 4 · Not placed")).toBeInTheDocument();
    // Pill của mỗi lần thử vẫn link tới đúng lệnh.
    expect(item(1).getByRole("link")).toHaveAccessibleName(/^Rejected\. Show order …/);
    await user.click(within(panel).getByRole("button", { name: "Show all 8" }));
    expect(within(panel).getByText("Try 1 · Post-only miss")).toBeInTheDocument();

    const r = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }, 20_000);

  it("390 px: the round row says how it ended and opens to each try", async () => {
    const user = userEvent.setup({ delay: null });
    const tries = round().slice(1); // lần thử mới nhất chưa khớp
    wrap(<DecisionsList botId={BOT} events={tries} why={(e) => e.why} legacy={(x) => x} />);
    const mobile = screen.getByRole("list", { name: "Recent decisions" });
    const group = within(mobile).getByRole("button", { name: /Enter long/ });
    expect(within(group).getByText("Not filled")).toBeInTheDocument();
    await user.click(group);
    const panel = within(mobile).getByRole("list", { name: "7 Enter long decisions" });
    expect(within(panel).getByText("Try 7 · Post-only miss")).toBeInTheDocument();
    const r = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }, 20_000);

  it("never shows a fill price the API did not give", () => {
    const tries = round().map((e) => ({ ...e, fillPrice: null }));
    wrap(<DecisionsList botId={BOT} events={tries} why={(e) => e.why} legacy={(x) => x} />);
    const group = within(desktop()).getByRole("button", { name: /Enter long/ });
    expect(within(group).getByText("Filled")).toBeInTheDocument();
    expect(within(group).queryByText(/Filled at/)).toBeNull();
  });

  it("names the tries it shows, not a round total, when the round's first try is out of view (review #215 B2)", () => {
    // Lượt bị cắt bởi giới hạn 50 event: thấy lần thử 6–8 (k = 5…7), không thấy lần thử đầu.
    const cut = round().slice(0, 3);
    wrap(<DecisionsList botId={BOT} events={cut} why={(e) => e.why} legacy={(x) => x} />);
    const group = within(desktop()).getByRole("button", { name: /Enter long/ });
    expect(within(group).getByText(/^Tries 6–8 in \d+ s$/)).toBeInTheDocument();
    expect(within(group).queryByText(/^3 tries/)).toBeNull();
  });

  it("says whole hours without a 0 min part", () => {
    const at = (min: number) => new Date(T0 - min * 60_000).toISOString();
    const tries = [
      { ...round()[1], entryTry: 1, occurredAt: at(0) },
      { ...round()[2], entryTry: 0, occurredAt: at(60) },
    ] as BotEvent[];
    wrap(<DecisionsList botId={BOT} events={tries} why={(e) => e.why} legacy={(x) => x} />);
    const group = within(desktop()).getByRole("button", { name: /Enter long/ });
    expect(within(group).getByText("2 tries in 1 h")).toBeInTheDocument();
  });
});
