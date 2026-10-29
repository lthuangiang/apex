import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { z } from "zod";

const indexSchema = z.object({
  entries: z.record(z.string(), z.object({ id: z.string(), type: z.string() })),
});

const indexPath = fileURLToPath(new URL("../storybook-static/index.json", import.meta.url));
const index = indexSchema.parse(JSON.parse(readFileSync(indexPath, "utf8")));
const storyIds = Object.values(index.entries)
  .filter((entry) => entry.type === "story")
  .map((entry) => entry.id);

for (const id of storyIds) {
  test(`${id} has no axe violations`, async ({ page }) => {
    await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=a11y.manual:!true`);
    await page.locator("#storybook-root > *").first().waitFor();
    await page.evaluate(() => document.fonts.ready);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
    ).toEqual([]);
  });

  test(`${id} has no page-level horizontal scroll`, async ({ page }) => {
    await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=a11y.manual:!true`);
    await page.locator("#storybook-root > *").first().waitFor();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
