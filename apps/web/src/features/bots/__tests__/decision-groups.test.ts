import type { DecisionOutcome } from "@drift/shared";
import { describe, expect, it } from "vitest";

import {
  entryDuration,
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
    entryTry: null,
    rejectCode: null,
    fillPrice: null,
    occurredAt: new Date(T0 - secAgo * 1000).toISOString(),
  } satisfies BotEvent;
};
/** Lần thử vào lệnh Volume Farm (`vf:<n>:in:<k>`). */
const tryEv = (
  k: number,
  secAgo: number,
  outcome: DecisionOutcome = "rejected",
  side: "long" | "short" = "long",
): BotEvent => ({
  ...ev(`Enter ${side}`, secAgo, outcome),
  entryTry: k,
  rejectCode: outcome === "rejected" ? "PostOnly" : null,
  fillPrice: outcome === "filled" ? "1800.7" : null,
});
const shape = (rows: ReturnType<typeof groupDecisions>) =>
  rows.map((r) =>
    r.kind === "single"
      ? r.event.decision
      : `${r.kind === "entry" ? "entry:" : ""}${r.name}×${String(r.events.length)}`,
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

describe("Volume Farm entry rounds (DEC-TBD-vb-decisions-grouping)", () => {
  it("collapses the tries of one round, newest first, up to the round's first try", () => {
    const rows = groupDecisions([
      tryEv(0, 0, "open"), // lượt mới
      ev("Closed long", 30, "filled"),
      tryEv(3, 200, "filled"),
      tryEv(2, 220, "cancelled"),
      tryEv(1, 240),
      tryEv(0, 260, "not_placed"),
      tryEv(4, 300, "cancelled"), // lượt trước, không nối (số thứ tự không liền)
    ]);
    expect(shape(rows)).toEqual(["Enter long", "Closed long", "entry:Enter long×4", "Enter long"]);
    const round = rows[2];
    expect(round?.kind === "entry" ? round.key : null).toBe(
      round?.kind === "entry" ? round.events.at(-1)?.id : "",
    );
  });

  it("has no 60 s limit inside a round, and keeps a round across a change of direction", () => {
    const rows = groupDecisions([
      tryEv(2, 0, "filled", "short"),
      tryEv(1, 400, "cancelled", "long"),
      tryEv(0, 900),
    ]);
    // Tên = lần thử mới nhất (lần vào thật của lượt).
    expect(shape(rows)).toEqual(["entry:Enter short×3"]);
  });

  it("never groups Unknown, other rejects, or tries without a round number", () => {
    const other = { ...tryEv(1, 10), rejectCode: "-1" };
    const unknown = { ...tryEv(1, 10), outcome: "unknown" as const };
    const old = ev("Enter long", 10, "cancelled");
    for (const middle of [other, unknown, old])
      expect(shape(groupDecisions([tryEv(2, 0), middle, tryEv(0, 20)]))).toEqual([
        "Enter long",
        "Enter long",
        "Enter long",
      ]);
  });

  it("splits a round on any other decision in between", () => {
    expect(
      shape(
        groupDecisions([tryEv(2, 0), ev("Skipped entry", 5, null), tryEv(1, 10), tryEv(0, 20)]),
      ),
    ).toEqual(["Enter long", "Skipped entry", "entry:Enter long×2"]);
  });

  it("measures the round from its first try to its newest", () => {
    expect(entryDuration([tryEv(1, 0), tryEv(0, 0)])).toEqual({ unit: "seconds", n: 1 });
    expect(entryDuration([tryEv(1, 0), tryEv(0, 45)])).toEqual({ unit: "seconds", n: 45 });
    expect(entryDuration([tryEv(7, 0), tryEv(0, 125)])).toEqual({ unit: "minutes", n: 2 });
    expect(entryDuration([tryEv(9, 0), tryEv(0, 3_900)])).toEqual({ unit: "hours", h: 1, m: 5 });
  });
});
