import { describe, expect, it } from "vitest";

import en from "../../../../messages/en.json";
import { FIELDS } from "../fields";

// Mọi field của mọi chiến lược (kể cả field ẩn, vì Trading Agent › Configuration vẫn hiện) phải có nhãn tiếng Anh,
// không bao giờ hiện key thô như "createBot.fields.markets.label" (người dùng báo trên prod 2026-11-13).
describe("field labels", () => {
  it("every field has an English label", () => {
    const fields = en.createBot.fields as Record<string, { label?: string } | undefined>;
    const missing = Object.entries(FIELDS).flatMap(([strategy, list]) =>
      list
        .map((f) => f.label ?? f.key)
        .filter((k) => typeof fields[k]?.label !== "string")
        .map((k) => `${strategy}:${k}`),
    );
    expect(missing).toEqual([]);
  });
});
