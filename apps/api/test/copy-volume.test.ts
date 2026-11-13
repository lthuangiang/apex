import { describe, expect, it } from "vitest";

import { sodexVolume24h } from "../src/modules/copy/volume";

// Volume 24h cho cảnh báo "Thin market on SoDEX" (DEC-TBD-hip3-xyz): tổng quote volume 24 nến 1h, đọc lỗi → null.

const kline = (t: number, q: string) => ({ t, o: "1", h: "1", l: "1", c: "1", v: "1", q, n: 1 });

describe("SoDEX 24h volume", () => {
  it("sums the quote volume of the last 24 hourly candles, cached per market", async () => {
    let calls = 0;
    const read = sodexVolume24h(
      {
        getKlines: () => {
          calls += 1;
          return Promise.resolve([kline(2, "30000.5"), kline(1, "19999.5")]);
        },
      },
      () => new Date("2026-11-13T10:00:00Z"),
    );
    expect(await read("MSTR-USD")).toBe("50000");
    await read("MSTR-USD");
    expect(calls).toBe(1);
  });

  it("returns null instead of guessing when SoDEX fails or has no candles", async () => {
    const failing = sodexVolume24h(
      { getKlines: () => Promise.reject(new Error("down")) },
      () => new Date(),
    );
    expect(await failing("MSTR-USD")).toBeNull();
    const empty = sodexVolume24h({ getKlines: () => Promise.resolve([]) }, () => new Date());
    expect(await empty("MSTR-USD")).toBeNull();
  });
});
