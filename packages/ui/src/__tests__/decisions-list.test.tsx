import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { DecisionsList, type DecisionGroupRow } from "../components/decisions-list";
import { expectNoAxeViolations } from "../test/axe";

// DecisionsList không chứa câu chữ (#227): mọi chữ đến từ props; mở / thu nhóm, "Show all" và focus nằm ở đây.

const labels = {
  cols: { time: "T", decision: "D", why: "W", result: "R" },
  list: "Desktop list",
  mobileList: "Mobile list",
  emptyTitle: "Nothing yet",
  emptyBody: "Body",
};

const group: DecisionGroupRow = {
  kind: "group",
  key: "g1",
  name: "Enter long",
  badge: "8 tries in 2 min",
  range: "07:41 – 07:43",
  shortTime: "07:41",
  head: "Filled at 1,800.70",
  mobileHead: "Filled at 1,800.70",
  summary: [{ label: "1 filled", tone: "positive" }],
  panelLabel: "8 Enter long decisions",
  showAllLabel: "Show all 8",
  children: Array.from({ length: 8 }, (_, i) => ({
    id: `c${String(i)}`,
    time: `07:4${String(i)}`,
    label: `Try ${String(8 - i)}`,
    why: "why",
    mobileText: `Try ${String(8 - i)}`,
    result: {
      pill: {
        label: "Filled",
        tone: "positive" as const,
        href: `/o/${String(i)}`,
        linkLabel: `Show ${String(i)}`,
      },
    },
  })),
};

describe("DecisionsList", () => {
  it("shows the empty state from props", async () => {
    const { container } = render(<DecisionsList rows={[]} labels={labels} />);
    expect(screen.getByText("Nothing yet")).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("expands a group, shows 5 children, then all and moves focus to the 6th", async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<DecisionsList rows={[group]} labels={labels} />);
    const desktop = within(screen.getByRole("list", { name: "Desktop list" }));
    const head = desktop.getByRole("button", { name: /Enter long/ });
    expect(head).toHaveAttribute("aria-expanded", "false");
    await user.click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
    const panel = within(desktop.getByRole("list", { name: "8 Enter long decisions" }));
    expect(panel.getAllByRole("link")).toHaveLength(5);
    await user.click(panel.getByRole("button", { name: "Show all 8" }));
    expect(panel.getAllByRole("link")).toHaveLength(8);
    expect(document.activeElement?.textContent).toContain("Try 3");
    await expectNoAxeViolations(container);
  });

  it("opens groups listed in defaultOpen and uses renderLink for result pills", () => {
    render(
      <DecisionsList
        rows={[group]}
        labels={labels}
        defaultOpen={["g1"]}
        renderLink={({ children, ...p }) => (
          <a data-custom="" {...p}>
            {children}
          </a>
        )}
      />,
    );
    const link = screen.getAllByRole("link", { name: "Show 0" })[0];
    expect(link).toHaveAttribute("data-custom");
    expect(link).toHaveAttribute("href", "/o/0");
  });
});
