import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  decimalStringSchema,
  ianaTimeZoneSchema,
  isoDateTimeSchema,
  pageQuerySchema,
  pageSchema,
} from "../schemas";

describe("schemas", () => {
  it("accepts decimal strings and rejects numbers", () => {
    expect(decimalStringSchema.parse("129948.11")).toBe("129948.11");
    expect(decimalStringSchema.safeParse(129948.11).success).toBe(false);
    expect(decimalStringSchema.safeParse("1e3").success).toBe(false);
  });

  it("accepts UTC ISO timestamps only", () => {
    expect(isoDateTimeSchema.safeParse("2026-10-26T14:02:09Z").success).toBe(true);
    expect(isoDateTimeSchema.safeParse("2026-10-26T14:02:09+07:00").success).toBe(false);
  });

  it("defaults the page limit to 50 and caps it", () => {
    expect(pageQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(pageQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
  });

  it("wraps items with a nullable next cursor", () => {
    const schema = pageSchema(z.object({ id: z.string() }));
    expect(schema.parse({ items: [{ id: "a" }], nextCursor: null }).items).toHaveLength(1);
  });

  it("validates IANA time zones", () => {
    expect(ianaTimeZoneSchema.safeParse("Asia/Ho_Chi_Minh").success).toBe(true);
    expect(ianaTimeZoneSchema.safeParse("Mars/Base").success).toBe(false);
  });
});
