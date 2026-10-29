import { describe, expect, it } from "vitest";

import { add, move, remove, reorder, toggle } from "../watchlist-list";

const e = (market: string) => ({ market, engine: "perps" as const });
const names = (xs: readonly { market: string }[]) => xs.map((x) => x.market);

describe("watchlist list", () => {
  it("adds once and stops at 8", () => {
    const one = add([], e("BTC-USD"));
    expect(names(add(one, e("BTC-USD")))).toEqual(["BTC-USD"]);
    const eight = Array.from({ length: 8 }, (_, i) => e(`M${String(i)}`));
    expect(add(eight, e("X")).length).toBe(8);
  });
  it("moves, reorders, removes and toggles", () => {
    const l = [e("A"), e("B"), e("C")];
    expect(names(move(l, 0, 1))).toEqual(["B", "A", "C"]);
    expect(names(move(l, 0, -1))).toEqual(["A", "B", "C"]);
    expect(names(move(l, 2, 1))).toEqual(["A", "B", "C"]);
    expect(names(reorder(l, 2, 0))).toEqual(["C", "A", "B"]);
    expect(names(remove(l, "B"))).toEqual(["A", "C"]);
    expect(names(toggle(l, e("A")))).toEqual(["B", "C"]);
    expect(names(toggle(l, e("D")))).toEqual(["A", "B", "C", "D"]);
  });
});
