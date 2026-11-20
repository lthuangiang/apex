import { expect, test, type Page } from "@playwright/test";

import {
  ARTICLES,
  SUMMARY_1D,
  TRACES,
} from "../src/features/signal-analysis/__tests__/news-trace-fixtures";
import { RESEARCH_TRADES } from "../src/features/signal-analysis/__tests__/research-fixtures";

// #345 (review PR #362): chữ trong mỗi tầng phễu không bao giờ tràn ra ngoài tầng hay nền của nó, ở 1024 / 1280 / 1440,
// cả chế độ tổng lẫn trace. Tầng cao theo chữ; tầng hẹp dùng câu ngắn (container query).

async function open(page: Page, baseURL: string | undefined) {
  // Cookie giả chỉ để qua middleware; mọi API là bản giả ở dưới.
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
    const m = /\/signal-research\/articles\/([^/]+)\/trace$/.exec(p);
    const tr = m === null ? undefined : TRACES[decodeURIComponent(m[1] ?? "")];
    if (tr !== undefined) return json(tr);
    return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  });
  await page.goto("/admin/signal-analysis?tab=research");
  await page.getByTestId("sr-funnel-bands").waitFor();
}

interface Box {
  band: string;
  overflowX: number;
  overflowY: number;
  outside: string[];
}

/** Mỗi tầng: không cuộn ngang / dọc, mọi dòng chữ nằm trong khung tầng (trừ lề clip-path 3% hai góc dưới). */
async function measure(page: Page): Promise<Box[]> {
  return page.getByTestId("sr-funnel-bands").evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>("[data-band]")].map((el) => {
      const b = el.getBoundingClientRect();
      const inset = el.classList.contains("border-dashed") ? 0 : b.width * 0.03;
      const outside: string[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          if (r.width === 0 || r.height === 0) continue;
          const ok =
            r.left >= b.left + inset - 0.5 &&
            r.right <= b.right - inset + 0.5 &&
            r.top >= b.top - 0.5 &&
            r.bottom <= b.bottom + 0.5;
          if (!ok) outside.push(n.textContent ?? "");
        }
      }
      return {
        band: el.dataset.band ?? "",
        overflowX: el.scrollWidth - el.clientWidth,
        overflowY: el.scrollHeight - el.clientHeight,
        outside,
      };
    }),
  );
}

function expectFits(boxes: Box[]) {
  expect(boxes).toHaveLength(6);
  for (const x of boxes) {
    expect.soft(x.overflowX, `${x.band}: scrollWidth ≤ clientWidth`).toBeLessThanOrEqual(0);
    expect.soft(x.overflowY, `${x.band}: scrollHeight ≤ clientHeight`).toBeLessThanOrEqual(0);
    expect.soft(x.outside, `${x.band}: text inside the band`).toEqual([]);
  }
}

test("totals: every band's text fits inside the band", async ({ page, baseURL }) => {
  await open(page, baseURL);
  expectFits(await measure(page));
});

for (const title of ["SEC approves in-kind", "Solana Foundation", "Bithumb will list"])
  test(`trace (${title}): every band's text fits inside the band`, async ({ page, baseURL }) => {
    await open(page, baseURL);
    await page
      .getByRole("button", { name: new RegExp(title) })
      .first()
      .click();
    // Reduced motion: kết quả hiện ngay.
    await expect(page.locator("#sr-funnel").getByRole("status").first()).toContainText(
      /Reached Decide|Stopped at|Merged at/,
    );
    expectFits(await measure(page));
  });
