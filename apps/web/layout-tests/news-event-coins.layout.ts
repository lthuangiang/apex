import { expect, test, type Page } from "@playwright/test";

import {
  EVENT_FIRST,
  EVENT_FIRST_TRACE,
  EVENT_REPOST,
  EVENT_REPOST_TRACE,
} from "../src/features/signal-analysis/__tests__/news-event-fixtures";
import {
  LATENCY_1D,
  SUMMARY_1D,
} from "../src/features/signal-analysis/__tests__/news-trace-fixtures";
import { RESEARCH_TRADES } from "../src/features/signal-analysis/__tests__/research-fixtures";

// #530 PR3: trace của sự kiện tin nêu nhiều coin và bài đăng lại "Same event" (mockup news-event-coins.html). Chữ trong
// tầng phễu và thẻ bước không tràn, trang không cuộn ngang ở 1024 / 1280 / 1440 và 390. `SHOTS_DIR` (tuỳ chọn): lưu ảnh để
// so với mockup.

const ARTICLES = [EVENT_REPOST, EVENT_FIRST];
const TRACES: Record<string, unknown> = {
  [EVENT_FIRST.id]: EVENT_FIRST_TRACE,
  [EVENT_REPOST.id]: EVENT_REPOST_TRACE,
};
const FUNNEL = SUMMARY_1D.funnel;
const SUMMARY =
  FUNNEL === null ? SUMMARY_1D : { ...SUMMARY_1D, funnel: { ...FUNNEL, sizeSplit: true } };
const SHOTS = process.env.SHOTS_DIR;

async function open(page: Page, baseURL: string | undefined) {
  // Cookie giả chỉ để qua middleware; mọi API là bản giả ở dưới.
  await page
    .context()
    .addCookies([{ name: "drift_session", value: "x", url: baseURL ?? "http://127.0.0.1" }]);
  await page.route("**/api/**", async (r) => {
    const p = new URL(r.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p.endsWith("/signal-research/summary")) return json(SUMMARY);
    if (p.endsWith("/signal-research/trades")) return json(RESEARCH_TRADES);
    if (p.endsWith("/signal-research/articles/new")) return json({ items: [], since: "c1" });
    if (p.endsWith("/signal-research/latency")) return json(LATENCY_1D);
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

/** Mỗi tầng phễu: không cuộn ngang / dọc (tầng cao theo chữ). */
async function bandsFit(page: Page) {
  const over = await page
    .getByTestId("sr-funnel-bands")
    .evaluate((root) =>
      [...root.querySelectorAll<HTMLElement>("[data-band]")]
        .filter((el) => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight)
        .map((el) => el.dataset.band ?? ""),
    );
  expect.soft(over, "no band overflows").toEqual([]);
}

async function noPageScrollX(page: Page) {
  const x = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect.soft(x, "no horizontal page scroll").toBeLessThanOrEqual(0);
}

async function trace(page: Page, title: RegExp, shot: string, width: number) {
  await page.getByRole("button", { name: title }).first().click();
  const steps = page.getByRole("list", { name: "Steps this article went through" });
  await steps.waitFor();
  await page.waitForTimeout(400);
  await bandsFit(page);
  await noPageScrollX(page);
  if (SHOTS !== undefined)
    await page
      .getByRole("region", { name: /From headline to trade/ })
      .screenshot({ path: `${SHOTS}/${shot}-${String(width)}.png` });
}

for (const [name, title] of [
  ["first", /A major broker adds AAVE/],
  ["repost", /Major broker adds COMP and AAVE/],
] as const) {
  test(`#530 ${name} article trace fits`, async ({ page, baseURL }, info) => {
    await open(page, baseURL);
    await trace(page, title, `trace-${name}`, info.project.use.viewport?.width ?? 0);
  });

  test(`#530 ${name} article trace fits at 390`, async ({ page, baseURL }, info) => {
    test.skip(info.project.name !== "w1440", "one run is enough for the phone width");
    await page.setViewportSize({ width: 390, height: 900 });
    await open(page, baseURL);
    await trace(page, title, `trace-${name}`, 390);
  });
}
