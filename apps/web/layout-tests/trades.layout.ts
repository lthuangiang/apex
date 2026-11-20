import { expect, test } from "@playwright/test";

import {
  ARTICLES,
  SUMMARY_1D,
} from "../src/features/signal-analysis/__tests__/news-trace-fixtures";
import { RESEARCH_TRADES } from "../src/features/signal-analysis/__tests__/research-fixtures";

// #388: chữ trong mỗi ô của bảng Paper trades nằm trong ô của nó (từ 1280 px bảng là table-fixed, không cuộn ngang). Lỗi cũ:
// dòng phụ "price 31 s after the fill" dưới giá Entry tràn sang cột Take profit.

test("paper trades: every cell's text stays inside its cell", async ({ page, baseURL }) => {
  await page
    .context()
    .addCookies([{ name: "drift_session", value: "x", url: baseURL ?? "http://127.0.0.1" }]);
  await page.route("**/api/**", async (r) => {
    const p = new URL(r.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p.endsWith("/signal-research/summary")) return json(SUMMARY_1D);
    if (p.endsWith("/signal-research/trades")) return json(RESEARCH_TRADES);
    if (p.endsWith("/signal-research/articles/new")) return json({ items: [], since: "c1" });
    if (p.endsWith("/signal-research/articles"))
      return json({ items: ARTICLES, nextCursor: null, total: ARTICLES.length, totalInRange: 58 });
    return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  });
  await page.goto("/admin/signal-analysis?tab=research");
  const table = page.getByRole("table", { name: "Signal research trades" });
  await table.waitFor();
  const outside = await table.evaluate((root) => {
    const out: string[] = [];
    for (const cell of root.querySelectorAll<HTMLElement>("tbody td, tbody th")) {
      const b = cell.getBoundingClientRect();
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        // Chữ chỉ cho trình đọc màn hình (sr-only) bị cắt, không hiện ra.
        if (n.parentElement?.closest(".sr-only") != null) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          if (r.width === 0) continue;
          if (r.left < b.left - 0.5 || r.right > b.right + 0.5) out.push(n.textContent ?? "");
        }
      }
    }
    return out;
  });
  expect(outside).toEqual([]);
});
