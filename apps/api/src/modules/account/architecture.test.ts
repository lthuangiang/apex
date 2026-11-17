import { architectureMapSchema } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { ARCHITECTURE_MAP } from "./architecture-data";

// Nội dung System Architecture Diagram: đúng schema, mọi đường nối / bước trỏ tới thứ có thật, nằm trong khung vẽ,
// và không có địa chỉ production (hostname thật, IP).

describe("architecture map content", () => {
  const map = architectureMapSchema.parse(ARCHITECTURE_MAP);
  const nodes = new Set(map.nodes.map((n) => n.id));
  const edges = new Set(map.edges.map((e) => e.id));

  it("links every edge and step to a real node or edge", () => {
    for (const e of map.edges) {
      expect(nodes.has(e.from), e.id).toBe(true);
      expect(nodes.has(e.to), e.id).toBe(true);
    }
    for (const f of map.flows)
      for (const s of f.steps) {
        expect(
          s.edge === null ? nodes.has(s.node ?? "") : edges.has(s.edge),
          `${f.id}: ${s.title}`,
        ).toBe(true);
      }
    expect(map.flows.map((f) => f.id)).toContain(map.defaultFlow);
  });

  it("keeps every point inside the drawing", () => {
    for (const e of map.edges)
      for (const [x, y] of e.points) {
        expect(x >= 0 && x <= map.width && y >= 0 && y <= map.height, e.id).toBe(true);
      }
  });

  it("names no production host or IP address", () => {
    const text = JSON.stringify(map);
    expect(text).not.toMatch(/desklabs\.xyz/);
    expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });
});
