import { describe, expect, it } from "vitest";

import { sortOps } from "../components/ops-page";

// Trang Ops (DEC-TBD-ops-page): bot có vi phạm bất biến gần nhất lên đầu, rồi theo volume / giờ.

const row = (id: string, volumeHour: string | null, at: string | null) => ({
  botId: id,
  userId: "01a1d823-0000-7000-8000-0000000000aa",
  name: id,
  strategy: "volume_maker",
  market: "BTC-USD",
  state: "running",
  costPerMillion: null,
  volumeHour,
  requestsPerMinute: null,
  makerSharePct: null,
  untrackedCancels: 0,
  positionCuts: 0,
  maxQuoteGapSec: null,
  latestInvariant: at === null ? null : { invariant: "P5", at, detail: "" },
});

describe("team ops order", () => {
  it("puts the latest invariant violation first, then sorts by volume per hour", () => {
    const out = sortOps([
      row("a", "1000", null),
      row("b", null, "2026-11-16T09:00:00.000Z"),
      row("c", "5000", null),
      row("d", "10", "2026-11-16T10:00:00.000Z"),
      row("e", null, null),
    ]);
    expect(out.map((r) => r.botId)).toEqual(["d", "b", "c", "a", "e"]);
  });
});
