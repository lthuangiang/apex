import { expect, test, type Page } from "@playwright/test";

import {
  ARTICLES,
  LATENCY_1D,
  SUMMARY_1D,
} from "../src/features/signal-analysis/__tests__/news-trace-fixtures";
import { RESEARCH_TRADES } from "../src/features/signal-analysis/__tests__/research-fixtures";
import { CLASSIFIERS } from "../src/features/signal-analysis/__tests__/versions-fixtures";

// #391: drawer How it works (BottomSheet side) là một cột flex tự cuộn. Khối con thiếu `shrink-0` thì bị ép dẹt khi nội dung
// dài hơn màn hình (mockup v1: dải tab và sơ đồ bị dẹt). Test đo trên trình duyệt thật ở 1024 / 1280 / 1440, ở 390, và ở
// màn thấp (500 px) để chắc chắn cột phải cuộn: mỗi khối cao bằng nội dung, sơ đồ giữ tỉ lệ 680 × 860, trang không cuộn ngang.

async function open(page: Page, baseURL: string | undefined, classifiers: unknown = CLASSIFIERS) {
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
    if (p.endsWith("/signal-research/latency")) return json(LATENCY_1D);
    if (p.endsWith("/signal-research/classifiers")) return json(classifiers);
    if (p.endsWith("/signal-research/articles"))
      return json({ items: ARTICLES, nextCursor: null, total: ARTICLES.length, totalInRange: 58 });
    return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  });
  await page.goto("/admin/signal-analysis?tab=research");
  await page.getByRole("button", { name: "How it works", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: "How it works" });
  await expect(dlg.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  return dlg;
}

interface Squash {
  name: string;
  height: number;
  content: number;
}

/** Mỗi khối của drawer: chiều cao hiện ra ≥ chiều cao nội dung (không bị ép), sơ đồ đúng tỉ lệ, drawer không cuộn ngang. */
async function measure(page: Page) {
  return page.getByRole("dialog", { name: "How it works" }).evaluate((dlg) => {
    const list = dlg.querySelector<HTMLElement>("[role='tablist']");
    const panel = dlg.querySelector<HTMLElement>("[role='tabpanel']");
    const blocks: HTMLElement[] = [];
    if (list !== null) blocks.push(list);
    if (panel !== null) blocks.push(panel, ...[...panel.children].map((c) => c as HTMLElement));
    const squashed: Squash[] = blocks
      .map((el) => ({
        name: el.dataset.testid ?? el.getAttribute("role") ?? el.tagName.toLowerCase(),
        height: el.getBoundingClientRect().height,
        content: el.scrollHeight,
      }))
      .filter((x) => x.height + 1 < x.content);
    const svg = dlg.querySelector<SVGSVGElement>("[data-testid='hiw-flow'] svg");
    const r = svg?.getBoundingClientRect();
    const tab = list?.querySelector<HTMLElement>("[role='tab']")?.getBoundingClientRect();
    return {
      squashed,
      ratio: r === undefined || r.width === 0 ? 0 : r.height / r.width,
      tabHeight: tab?.height ?? 0,
      dialogScrolls: dlg.scrollHeight > dlg.clientHeight,
      dialogOverflowX: dlg.scrollWidth - dlg.clientWidth,
      // #392 đã sửa: trang nền không cuộn ngang khi drawer mở.
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

function expectNotSquashed(m: Awaited<ReturnType<typeof measure>>) {
  expect.soft(m.squashed, "no drawer block is squashed").toEqual([]);
  expect.soft(m.ratio, "diagram keeps its 680 × 860 shape").toBeCloseTo(860 / 680, 2);
  expect.soft(m.tabHeight, "tabs stay at least 44 px tall").toBeGreaterThanOrEqual(44);
  expect.soft(m.dialogScrolls, "the drawer scrolls instead of squashing").toBe(true);
  expect.soft(m.dialogOverflowX, "no horizontal scroll inside the drawer").toBeLessThanOrEqual(0);
  expect.soft(m.pageOverflowX, "the page does not scroll sideways").toBeLessThanOrEqual(0);
}

test("overview: drawer blocks keep their height, the diagram keeps its shape", async ({
  page,
  baseURL,
}, info) => {
  await open(page, baseURL);
  expectNotSquashed(await measure(page));
  const shots = process.env.HIW_SHOTS;
  if (shots !== undefined && info.project.name === "w1440")
    await page.screenshot({ path: `${shots}/overview-1440.png` });
});

test("overview: a short screen still scrolls the drawer instead of squashing it", async ({
  page,
  baseURL,
}) => {
  const vp = page.viewportSize();
  await page.setViewportSize({ width: vp?.width ?? 1440, height: 500 });
  await open(page, baseURL);
  expectNotSquashed(await measure(page));
});

test("overview at 390: full-screen drawer, the diagram scrolls inside its own box", async ({
  page,
  baseURL,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const dlg = await open(page, baseURL);
  expectNotSquashed(await measure(page));
  const flow = await dlg.getByTestId("hiw-flow").evaluate((el) => ({
    scrolls: el.scrollWidth > el.clientWidth,
    right: el.getBoundingClientRect().right,
  }));
  expect.soft(flow.scrolls, "diagram scrolls sideways in its box").toBe(true);
  expect.soft(flow.right, "diagram box stays on screen").toBeLessThanOrEqual(390);
  const shots = process.env.HIW_SHOTS;
  if (shots !== undefined && info.project.name === "w1440")
    await page.screenshot({ path: `${shots}/overview-390.png` });
});

/** #395, #399: reader v5 chạy được 1 ngày (nhãn "New in v5"), reader v4 lên cùng Rules v4 2 ngày trước ("New in v4"). */
function readerV5() {
  const [cur, old] = CLASSIFIERS.items;
  if (cur === undefined || old === undefined) throw new Error("fixture");
  return {
    ...CLASSIFIERS,
    items: [
      {
        ...cur,
        classifierVersion: "news-classifier-v5",
        startedAt: new Date(Date.now() - 86_400_000).toISOString(),
      },
      {
        ...old,
        classifierVersion: "news-classifier-v4",
        startedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      },
    ],
  };
}

for (const width of [1440, 390]) {
  test(`news types at ${String(width)}: the two boxes keep their height, nothing overflows`, async ({
    page,
    baseURL,
  }, info) => {
    if (width === 390) await page.setViewportSize({ width: 390, height: 844 });
    const dlg = await open(page, baseURL, readerV5());
    await dlg.getByRole("tab", { name: "News types" }).click();
    await expect(dlg.getByRole("region", { name: /^Not counted/ })).toBeVisible();
    await expect(dlg.getByText("New in v4")).toHaveCount(1);
    await expect(dlg.getByText("New in v5")).toHaveCount(1);
    const m = await dlg.evaluate((el) => {
      const boxes = [...el.querySelectorAll<HTMLElement>("[role='tabpanel'] section")];
      return {
        boxes: boxes.length,
        squashed: boxes.filter((b) => b.getBoundingClientRect().height + 1 < b.scrollHeight).length,
        overflowX: el.scrollWidth - el.clientWidth,
        wide: boxes.filter((b) => b.scrollWidth > b.clientWidth + 1).length,
      };
    });
    expect.soft(m.boxes, "two boxes").toBe(2);
    expect.soft(m.squashed, "no box is squashed").toBe(0);
    expect.soft(m.wide, "box text wraps inside the box").toBe(0);
    expect.soft(m.overflowX, "no horizontal scroll inside the drawer").toBeLessThanOrEqual(0);
    const shots = process.env.HIW_SHOTS;
    if (shots !== undefined && info.project.name === "w1440") {
      await dlg.getByRole("region", { name: /^What Claude reader v5/ }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/news-types-${String(width)}.png` });
    }
  });
}
