import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { STRATEGIES } from "../index";

// Form tạo bot gọi safeParse trên config chưa điền xong (dry-run checks). Ô trống "" hoặc số viết dở phải
// trả về lỗi validate, không được ném RangeError từ dec() bên trong refine.

function shapeOf(schema: z.ZodType): Record<string, unknown> {
  let x: unknown = schema;
  for (let i = 0; i < 5 && x !== undefined; i++) {
    const node = x as { shape?: Record<string, unknown>; _zod?: { def?: { in?: unknown } } };
    if (node.shape) return node.shape;
    x = node._zod?.def?.in;
  }
  return {};
}

describe("strategy schemas with unfinished input", () => {
  for (const [name, s] of Object.entries(STRATEGIES)) {
    const keys = Object.keys(shapeOf(s.schema));
    it(`${name}: blank or partial values never throw`, () => {
      expect(keys.length).toBeGreaterThan(0);
      const filled = Object.fromEntries(keys.map((k) => [k, "1"]));
      for (const key of keys) {
        for (const bad of ["", "1.", "-", "abc"]) {
          expect(() => s.schema.safeParse({ [key]: bad })).not.toThrow();
          const r = s.schema.safeParse({ ...filled, [key]: bad });
          expect(r.success).toBe(false);
        }
      }
    });
  }
});
