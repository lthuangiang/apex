import { describe, expect, it } from "vitest";

import { Decimal } from "../money";
import { diffByDayBootstrap, summarizeByDay, type DayObs } from "../stats/day-bootstrap";

// Chênh hai nhóm bằng bootstrap ngày ghép cặp (#282): cùng PRNG, seed và quy ước phân vị với `summarizeByDay`.

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-10T00:00:00Z");
const o = (day: number, v: number, k = 0): DayObs => ({
  v: new Decimal(v),
  at: T0 + day * DAY + k,
});

describe("diffByDayBootstrap", () => {
  it("is the difference of the two means, degenerate when every day differs by the same amount", () => {
    const a = [0, 1, 2, 3].flatMap((k) => [o(k, -2), o(k, -4, 1)]);
    const b = [0, 1, 2, 3].map((k) => o(k, -8, 5));
    const r = diffByDayBootstrap(a, b);
    expect(r.diff?.toFixed(1)).toBe("5.0");
    expect(r.clusters).toBe(4);
    expect(r.ciLow?.toFixed(1)).toBe("5.0");
    expect(r.ciHigh?.toFixed(1)).toBe("5.0");
  });

  it("needs two days and both groups", () => {
    expect(diffByDayBootstrap([o(0, 1)], [o(0, 2)]).ciLow).toBeNull();
    expect(diffByDayBootstrap([o(0, 1), o(1, 2)], []).diff).toBeNull();
  });

  it("matches summarizeByDay when the second group is a constant zero on every day", () => {
    const a = Array.from({ length: 10 }, (_, k) => o(k, ((k * 7) % 5) - 2));
    const zero = Array.from({ length: 10 }, (_, k) => o(k, 0, 1));
    const r = diffByDayBootstrap(a, zero);
    const s = summarizeByDay(a);
    expect(r.diff?.toFixed(6)).toBe(s.mean?.toFixed(6));
    // Cùng chuỗi lấy mẫu (seed) và cùng quy ước phân vị → cùng khoảng.
    expect(r.ciLow?.toFixed(6)).toBe(s.ciLow?.toFixed(6));
    expect(r.ciHigh?.toFixed(6)).toBe(s.ciHigh?.toFixed(6));
  });
});
