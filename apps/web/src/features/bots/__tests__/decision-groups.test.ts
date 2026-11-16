import type { DecisionOutcome } from "@drift/shared";
import { describe, expect, it } from "vitest";

import {
  groupDecisions,
  groupSummary,
  isKnownDecision,
  orderHref,
  orderTail,
  validIsoTime,
  type BotEvent,
} from "../decision-groups";

// BD-02: gộp quyết định lặp lại (docs/mockups/bd02-decisions README, quy tắc 1–3).

const T0 = Date.parse("2026-11-16T07:43:00Z");
let n = 0;
const ev = (decision: string, secAgo: number, outcome: DecisionOutcome | null = "cancelled") => {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    type: "decision",
    decision,
    why: null,
    result: null,
    outcome,
    order: outcome === null ? null : `cl-${String(n)}`,
    occurredAt: new Date(T0 - secAgo * 1000).toISOString(),
  } satisfies BotEvent;
};
const shape = (rows: ReturnType<typeof groupDecisions>) =>
  rows.map((r) =>
    r.kind === "single" ? r.event.decision : `${r.name}×${String(r.events.length)}`,
  );

describe("groupDecisions", () => {
  it("groups consecutive Bid pulled / Ask pulled / Quote skipped within 60 s, each side apart", () => {
    const rows = groupDecisions([
      ev("Bid pulled", 0),
      ev("Bid pulled", 30),
      ev("Bid pulled", 90),
      ev("Ask pulled", 100),
      ev("Ask pulled", 110),
      ev("Quote skipped", 120),
      ev("Quote skipped", 125),
    ]);
    expect(shape(rows)).toEqual(["Bid pulled×3", "Ask pulled×2", "Quote skipped×2"]);
  });

  it("splits on a gap over 60 s and on any other decision in between", () => {
    expect(
      shape(
        groupDecisions([
          ev("Bid pulled", 0),
          ev("Bid pulled", 61),
          ev("Order filled", 62, "filled"),
          ev("Bid pulled", 63),
        ]),
      ),
    ).toEqual(["Bid pulled", "Bid pulled", "Order filled", "Bid pulled"]);
  });

  it("never groups other names, nor Unknown or Rejected results", () => {
    const rows = groupDecisions([
      ev("Order filled", 0, "filled"),
      ev("Order filled", 1, "filled"),
      ev("Smart quoting adjusted", 2, null),
      ev("Smart quoting adjusted", 3, null),
      ev("Bid pulled", 4),
      ev("Bid pulled", 5, "unknown"),
      ev("Bid pulled", 6),
      ev("Quote skipped", 7, "rejected"),
      ev("Quote skipped", 8, "rejected"),
    ]);
    expect(shape(rows)).toEqual([
      "Order filled",
      "Order filled",
      "Smart quoting adjusted",
      "Smart quoting adjusted",
      "Bid pulled",
      "Bid pulled",
      "Bid pulled",
      "Quote skipped",
      "Quote skipped",
    ]);
  });

  it("still groups at a gap of exactly 60 s", () => {
    expect(shape(groupDecisions([ev("Quote skipped", 0), ev("Quote skipped", 60)]))).toEqual([
      "Quote skipped×2",
    ]);
  });

  it("keys a group on its oldest event, so a new event joining keeps the key", () => {
    const older = [ev("Bid pulled", 10), ev("Bid pulled", 20)];
    const [before] = groupDecisions(older);
    const [after] = groupDecisions([ev("Bid pulled", 0), ...older]);
    expect(before?.kind === "group" ? before.key : null).toBe(older[1]?.id);
    expect(after?.kind === "group" ? after.key : null).toBe(older[1]?.id);
  });

  it("counts a group's results worst first", () => {
    const events = [
      ev("Bid pulled", 0, "filled"),
      ev("Bid pulled", 1),
      ev("Bid pulled", 2, "open"),
    ];
    expect(groupSummary(events)).toEqual([
      { outcome: "open", n: 1 },
      { outcome: "filled", n: 1 },
      { outcome: "cancelled", n: 1 },
    ]);
  });

  it("links to the order with the decision and time", () => {
    const e = ev("Bid pulled", 0);
    const href = orderHref("b1", e, "abc-3e9-0");
    const q = new URL(href, "http://x").searchParams;
    expect(href.startsWith("/orders?")).toBe(true);
    expect(q.get("botId")).toBe("b1");
    expect(q.get("order")).toBe("abc-3e9-0");
    expect(q.get("decision")).toBe("Bid pulled");
    expect(q.get("at")).toBe(e.occurredAt);
    expect(orderTail("abc-3e9-0")).toBe("3e9-0");
  });

  it("knows the decision names the bots write, and valid ISO times", () => {
    for (const d of ["Bid pulled", "Order filled", "Bought at level 3", "Cycle 2 took profit"])
      expect(isKnownDecision(d)).toBe(true);
    for (const d of ["Send us your seed phrase", "Bid pulled ", "Order hacked", ""])
      expect(isKnownDecision(d)).toBe(false);
    expect(validIsoTime("2026-11-16T07:42:51Z")).toBe("2026-11-16T07:42:51Z");
    expect(validIsoTime("2026-11-16T07:42:51.123+07:00")).not.toBeNull();
    for (const v of ["yesterday", "2026-11-16", "2026-13-40T99:99:99Z", ""])
      expect(validIsoTime(v)).toBeNull();
  });
});
