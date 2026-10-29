import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { STRATEGIES } from "@drift/strategies";
import { describe, expect, it } from "vitest";

// Tham số do engine đề xuất (packages/shared/src/reco) phải qua được đúng zod schema của chiến lược.
const GOLDEN = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../packages/shared/src/reco/__tests__/golden",
);

describe("reco values fit the strategy schemas", () => {
  for (const file of readdirSync(GOLDEN).filter((f) => f.endsWith(".json"))) {
    it(file, () => {
      const plan = JSON.parse(readFileSync(join(GOLDEN, file), "utf8")) as {
        best: { strategy: string; values: unknown } | null;
        addOns: { strategy: string; values: unknown }[];
      };
      for (const s of [plan.best, ...plan.addOns]) {
        if (s === null) continue;
        const entry = (
          STRATEGIES as Record<
            string,
            { schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } } }
          >
        )[s.strategy];
        expect(entry, s.strategy).toBeDefined();
        const r = entry?.schema.safeParse(s.values);
        expect(r?.success, `${s.strategy}: ${JSON.stringify(r?.error)}`).toBe(true);
      }
    });
  }
});
