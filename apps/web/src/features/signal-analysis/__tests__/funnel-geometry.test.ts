import { describe, expect, it } from "vitest";

import { bandRects, DROP_CHIP_MAX, tokenRect, TOKEN_GUTTER, type Rect } from "../research/funnel";

// Chip của phễu không bao giờ đè lên tầng nào (#343 review). Cùng công thức với CSS của `Token` / `FunnelBands`.
// Khung phễu đo bằng Playwright trên trang thật (fixture), trừ lề 2 × 16 px: 1280 px → 585 px, 1440 px → 380 px (khung
// Context nằm cạnh phễu từ 1400 px). Kiểm thêm một dải rộng để không phụ thuộc số đo.

const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const MEASURED = { 1280: 585, 1440: 380 } as const;
const WIDTHS = [...Object.values(MEASURED), ...Array.from({ length: 13 }, (_, i) => 300 + i * 50)];
// Chip dài nhất có thể: bị giới hạn bởi max-width; 2 dòng chữ 11 px.
const CHIPS = [
  { w: 60, h: 26 },
  { w: DROP_CHIP_MAX, h: 40 },
  { w: 400, h: 40 },
];

describe("funnel chip geometry", () => {
  it.each(WIDTHS)(
    "a dropped chip parks beside the band that dropped it, never over a band (%i px)",
    (width) => {
      const bands = bandRects(width, true);
      for (let pos = 1; pos <= 6; pos++)
        for (const chip of CHIPS) {
          const r = tokenRect(width, { pos, tone: "dropped" }, chip);
          for (const b of bands) expect(overlap(r, b)).toBe(false);
          // Cùng hàng với tầng đã loại, nằm bên phải thân phễu, trong khung.
          const own = bands[pos - 1];
          expect(own).toBeDefined();
          if (own === undefined) continue;
          expect(r.y).toBe(own.y);
          expect(r.x).toBeGreaterThanOrEqual(own.x + own.w);
          expect(r.x + r.w).toBeLessThanOrEqual(width);
        }
    },
  );

  it.each(WIDTHS)("the traded chip parks under Decide, never over a band (%i px)", (width) => {
    const bands = bandRects(width, true);
    const r = tokenRect(width, { pos: 6, tone: "traded" }, { w: 140, h: 26 });
    for (const b of bands) expect(overlap(r, b)).toBe(false);
  });

  it("the gutter only exists while tracing", () => {
    expect(bandRects(600, false)[0]?.w).toBeCloseTo(600 * 0.7);
    expect(bandRects(600, true)[0]?.w).toBeCloseTo((600 - TOKEN_GUTTER) * 0.94);
  });
});
