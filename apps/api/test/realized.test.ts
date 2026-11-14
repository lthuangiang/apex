import { describe, expect, it } from "vitest";

import {
  REALIZED_MAX_PAGES,
  REALIZED_PAGE,
  sumRealized,
  type ClosedPosition,
} from "../src/modules/account/realized";

/** Giả lập SoDEX: sắp theo `updatedAt` giảm dần, `endTime` lọc theo `createdAt`, tối đa `REALIZED_PAGE` dòng. */
function fakeSodex(rows: (ClosedPosition & { createdAt: number })[]) {
  const calls: (number | undefined)[] = [];
  const page = (endTime: number | undefined) => {
    calls.push(endTime);
    return Promise.resolve(
      rows
        .filter((r) => endTime === undefined || r.createdAt <= endTime)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, REALIZED_PAGE),
    );
  };
  return { page, calls };
}

const pos = (i: number, pnl = "0.01", held = 5) => ({
  id: BigInt(i),
  realizedPnL: pnl,
  createdAt: 1_000_000 + i * 10 - held,
  updatedAt: 1_000_000 + i * 10,
});

describe("sumRealized", () => {
  it("adds up every closed position across pages, once each", async () => {
    // 2.500 vị thế, mỗi cái +0.01, một vị thế giữ lâu (mở trước mốc của trang sau, đóng sau) không bị cộng hai lần.
    const rows = Array.from({ length: 2500 }, (_, i) => pos(i));
    rows[1600] = { ...pos(1600, "5"), createdAt: 1_000_000 };
    const sodex = fakeSodex(rows);
    expect(await sumRealized(sodex.page, 0)).toBe("29.99");
    expect(sodex.calls).toHaveLength(3);
  });

  it("only counts positions closed since the start of the period, and stops paging past it", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => pos(i, i % 2 === 0 ? "1" : "-1"));
    const sodex = fakeSodex(rows);
    // Từ vị thế 2000 trở đi: 500 vị thế, nửa +1 nửa −1.
    expect(await sumRealized(sodex.page, 1_000_000 + 2000 * 10)).toBe("0");
    expect(sodex.calls).toHaveLength(1);
  });

  it("returns one page as is when it is not full", async () => {
    const sodex = fakeSodex([pos(1, "2.5"), pos(2, "-1")]);
    expect(await sumRealized(sodex.page, 0)).toBe("1.5");
  });

  it("returns null instead of a partial total when there are too many positions", async () => {
    const rows = Array.from({ length: REALIZED_PAGE * REALIZED_MAX_PAGES + 1 }, (_, i) => pos(i));
    expect(await sumRealized(fakeSodex(rows).page, 0)).toBeNull();
  });

  it("returns null when a full page brings nothing new", async () => {
    const same = Array.from({ length: REALIZED_PAGE }, (_, i) => pos(i));
    expect(await sumRealized(() => Promise.resolve(same), 0)).toBeNull();
  });
});
