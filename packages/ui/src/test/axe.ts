import axe from "axe-core";
import { expect } from "vitest";

/**
 * Chạy axe theo các tiêu chí WCAG 2.2 A/AA. `color-contrast` không tính được trong jsdom
 * (không có layout), nên tương phản được kiểm tra riêng trên token (tokens.test.ts).
 */
export async function expectNoAxeViolations(root: Element = document.body): Promise<void> {
  const results = await axe.run(root, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}
