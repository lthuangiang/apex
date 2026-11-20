import { expect, test, type Page } from "@playwright/test";

import {
  ARTICLES,
  LATENCY_1D,
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

interface Chip {
  tone: string;
  overflowX: number;
  overflowY: number;
  overlaps: string[];
  outsideFunnel: boolean;
}

/** Chip trace (#361: bài bị loại đỗ trong rãnh bên phải; vào lệnh / gộp đỗ dưới Decide): không đè tầng nào, chữ không tràn. */
async function chip(page: Page): Promise<Chip | null> {
  return page.getByTestId("sr-funnel-bands").evaluate((root) => {
    const el = root.querySelector<HTMLElement>("[data-testid='sr-token']");
    if (el === null || getComputedStyle(el).opacity === "0") return null;
    const c = el.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    const hit = (b: DOMRect) =>
      c.left < b.right - 0.5 &&
      c.right > b.left + 0.5 &&
      c.top < b.bottom - 0.5 &&
      c.bottom > b.top + 0.5;
    return {
      tone: el.dataset.tone ?? "",
      overflowX: el.scrollWidth - el.clientWidth,
      overflowY: el.scrollHeight - el.clientHeight,
      overlaps: [...root.querySelectorAll<HTMLElement>("[data-band]")]
        .filter((b) => hit(b.getBoundingClientRect()))
        .map((b) => b.dataset.band ?? ""),
      outsideFunnel: c.left < box.left - 0.5 || c.right > box.right + 0.5,
    };
  });
}

function expectChip(c: Chip | null) {
  expect(c, "the chip is shown").not.toBeNull();
  if (c === null) return;
  expect.soft(c.overlaps, `${c.tone} chip covers no band`).toEqual([]);
  expect.soft(c.outsideFunnel, `${c.tone} chip stays inside the funnel box`).toBe(false);
  // Chip đang chạy / đã vào lệnh có thể cắt "…" (truncate); chip bị loại xuống dòng, không được tràn.
  if (c.tone === "dropped") {
    expect.soft(c.overflowX, "dropped chip: scrollWidth ≤ clientWidth").toBeLessThanOrEqual(0);
    expect.soft(c.overflowY, "dropped chip: scrollHeight ≤ clientHeight").toBeLessThanOrEqual(0);
  }
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
    expectChip(await chip(page));
  });

// #343 (review PM): câu ngắn của Decide ("L 1 · S 0") luôn nằm trên một dòng khi tầng hẹp. Ép tầng Decide hẹp hơn ngưỡng
// câu ngắn (container query 260 px) để chắc chắn câu ngắn hiện ở mọi độ rộng của project. 140 px là độ rộng nhỏ nhất mà
// tầng vẫn vừa khi có nowrap; không có nowrap thì ở 140 px câu này xuống 2 dòng (đã kiểm ngược), nên test bắt được lỗi.
test("totals: the short Decide counts stay on one line when the band is narrow", async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  for (const px of [140, 180, 220, 250]) {
    const r = await page.getByTestId("sr-funnel-bands").evaluate(async (root, w) => {
      const band = root.querySelector<HTMLElement>("[data-band='decide']");
      if (band === null) return null;
      band.style.width = `${String(w)}px`;
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      const short = band.querySelector<HTMLElement>("[data-nowrap]");
      if (short === null || short.getClientRects().length === 0)
        return { shown: false, lines: 0, text: "" };
      const range = document.createRange();
      range.selectNodeContents(short);
      const tops = new Set(
        [...range.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)),
      );
      return {
        shown: true,
        lines: tops.size,
        text: short.textContent,
        overflowX: band.scrollWidth - band.clientWidth,
      };
    }, px);
    expect(r, `decide band at ${String(px)} px`).not.toBeNull();
    expect.soft(r?.shown, `short Decide counts shown at ${String(px)} px`).toBe(true);
    expect.soft(r?.text).toMatch(/^L \d+ · S \d+$/);
    expect.soft(r?.lines, `"${r?.text ?? ""}" on one line at ${String(px)} px`).toBe(1);
    expect
      .soft(r?.overflowX ?? 0, `decide band at ${String(px)} px does not overflow`)
      .toBeLessThanOrEqual(0);
  }
});

/**
 * #375: ô "Where the time goes" (chế độ tổng) và dòng thời gian của thẻ Collect (trace): không tràn ngang, giá trị từng
 * dòng nằm trong khung của nó.
 */
async function latencyFits(page: Page, testId: string) {
  const r = await page.getByTestId(testId).evaluate((box) => {
    const b = box.getBoundingClientRect();
    const outside: string[] = [];
    for (const el of box.querySelectorAll<HTMLElement>("dd, [data-mark] > div > div")) {
      const x = el.getBoundingClientRect();
      if (x.width === 0) continue;
      if (x.left < b.left - 0.5 || x.right > b.right + 0.5) outside.push(el.textContent);
    }
    return { overflowX: box.scrollWidth - box.clientWidth, outside };
  });
  expect.soft(r.overflowX, `${testId}: scrollWidth ≤ clientWidth`).toBeLessThanOrEqual(0);
  expect.soft(r.outside, `${testId}: values inside the box`).toEqual([]);
}

test("totals: Where the time goes fits, every leg value inside the card", async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL);
  await expect(page.getByTestId("sr-latency")).toContainText("5 min 45 s");
  await latencyFits(page, "sr-latency");
  // Phễu vẫn không tràn khi có ô mới.
  expectFits(await measure(page));
});

test("trace: the Collect card timeline fits", async ({ page, baseURL }) => {
  await open(page, baseURL);
  await page
    .getByRole("button", { name: /SEC approves in-kind/ })
    .first()
    .click();
  await expect(page.getByTestId("sr-latency-timeline")).toContainText("Paper trade opened");
  await latencyFits(page, "sr-latency-timeline");
});
