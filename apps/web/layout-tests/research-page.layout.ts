import { expect, test, type Page } from "@playwright/test";

import {
  ARTICLES,
  LATENCY_1D,
  SUMMARY_1D,
  TRACES,
} from "../src/features/signal-analysis/__tests__/news-trace-fixtures";
import { RESEARCH_TRADES } from "../src/features/signal-analysis/__tests__/research-fixtures";
import {
  CLASSIFIERS,
  MARKETS,
  VERSIONS,
} from "../src/features/signal-analysis/__tests__/versions-fixtures";

// #392: trang Signal research không bao giờ cuộn ngang, ở 1024 / 1280 / 1440 (project) và 390. Lỗi cũ ở 1024: hoạt cảnh chờ
// của khung 4 · Context (svg dài hơn khung) và bảng Paper trades kéo giãn trang thêm ~449 px. Khi fail, test in danh sách
// phần tử tràn (right > clientWidth) kèm testid / class để biết chính xác chỗ nào.

/**
 * #413: dữ liệu có hai version Rules: Rules v3 hiện tại, bài / lệnh của Rules v2 là lịch sử (chip, dòng ngăn cách, câu
 * "all rules" dưới phễu, banner ở trace, nút Current / All rules).
 */
const OLD = new Set(["art-sol", "art-kntq", "art-merged"]);
const HISTORY_SUMMARY = {
  ...SUMMARY_1D,
  newsRulesVersion: 3,
  olderRules: { trades: 2, versions: [2] },
  rulesHistory: [
    { v: 2, startedAt: "2026-11-01T00:00:00.000Z", reader: "news-classifier-v2" },
    { v: 3, startedAt: "2026-11-19T03:18:00.000Z", reader: "news-classifier-v3" },
  ],
  funnel:
    SUMMARY_1D.funnel === null
      ? null
      : {
          ...SUMMARY_1D.funnel,
          rules: [
            { v: 2, articles: 40 },
            { v: 3, articles: 18 },
          ],
        },
};
const withRules = <T extends { id: string }>(a: T) =>
  OLD.has(a.id)
    ? { ...a, rulesVersion: 2, readerVersion: "news-classifier-v2" }
    : { ...a, rulesVersion: 3, readerVersion: "news-classifier-v3" };

async function open(page: Page, baseURL: string | undefined, history = false) {
  await page
    .context()
    .addCookies([{ name: "drift_session", value: "x", url: baseURL ?? "http://127.0.0.1" }]);
  await page.route("**/api/**", async (r) => {
    const p = new URL(r.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p.endsWith("/signal-research/summary")) return json(history ? HISTORY_SUMMARY : SUMMARY_1D);
    if (p.endsWith("/signal-research/trades"))
      return json(
        history
          ? {
              ...RESEARCH_TRADES,
              items: RESEARCH_TRADES.items.map((x, i) => ({ ...x, rulesVersion: i === 0 ? 3 : 2 })),
            }
          : RESEARCH_TRADES,
      );
    if (p.endsWith("/signal-research/articles/new")) return json({ items: [], since: "c1" });
    if (p.endsWith("/signal-research/latency")) return json(LATENCY_1D);
    if (p.endsWith("/signal-research/versions")) return json(VERSIONS);
    if (p.endsWith("/signal-research/classifiers")) return json(CLASSIFIERS);
    if (p.endsWith("/signal-research/markets")) return json(MARKETS);
    if (p.endsWith("/signal-research/articles"))
      return json({
        items: history ? ARTICLES.map(withRules) : ARTICLES,
        nextCursor: null,
        total: ARTICLES.length,
        totalInRange: 58,
      });
    const m = /\/signal-research\/articles\/([^/]+)\/trace$/.exec(p);
    const tr = m === null ? undefined : TRACES[decodeURIComponent(m[1] ?? "")];
    if (tr !== undefined) return json(history ? { ...tr, article: withRules(tr.article) } : tr);
    return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  });
  await page.goto("/admin/signal-analysis?tab=research");
  await page.getByTestId("sr-funnel-bands").waitFor();
  // Bảng (≥ 768 px) hoặc thẻ (390) của Paper trades đã có dữ liệu.
  await page
    .getByRole("button", { name: /^Trace: / })
    .first()
    .waitFor();
}

/** Độ cuộn ngang của trang và các phần tử hiện ra có cạnh phải vượt quá bề rộng trang (bỏ phần tử bị khung tổ tiên cắt). */
async function overflow(page: Page) {
  // Chờ 2 frame cho bố cục ổn định sau thao tác.
  await page.evaluate(
    () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))),
  );
  return page.evaluate(() => {
    const root = document.documentElement;
    const w = root.clientWidth;
    // Phần tử bị khung cuộn / cắt của tổ tiên giữ lại thì không làm trang cuộn. Phần tử absolute chỉ bị cắt bởi containing
    // block của nó (tổ tiên có position) và tổ tiên của khối đó: một `sr-only` trong bảng của khung cuộn không có position
    // vẫn thoát ra ngoài (lỗi gốc của #392).
    const clipped = (el: Element) => {
      let mode = getComputedStyle(el).position;
      for (let p = el.parentElement; p !== null && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p);
        const positioned = s.position !== "static" || s.transform !== "none";
        if (mode === "fixed" && s.transform === "none") continue;
        if (mode === "absolute" && !positioned) continue;
        const clips = s.overflowX !== "visible" || s.contain.includes("paint");
        if (clips && p.getBoundingClientRect().right <= w + 0.5) return true;
        mode = s.position;
      }
      return false;
    };
    const wide: string[] = [];
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= w + 0.5 || clipped(el)) continue;
      const id = el.getAttribute("data-testid") ?? el.id;
      const cls = el.getAttribute("class") ?? "";
      wide.push(
        `${el.tagName.toLowerCase()}${id === "" ? "" : `#${id}`} .${cls.slice(0, 80)} right=${String(Math.round(r.right))}`,
      );
    }
    return { scroll: root.scrollWidth - root.clientWidth, wide: wide.slice(0, 12) };
  });
}

async function expectNoSideScroll(page: Page, what: string) {
  const o = await overflow(page);
  expect.soft(o.wide, `${what}: nothing sticks out past the page`).toEqual([]);
  expect.soft(o.scroll, `${what}: page does not scroll sideways`).toBeLessThanOrEqual(0);
}

for (const narrow of [false, true]) {
  const tag = narrow ? " at 390" : "";

  test(`totals${tag}: the research page does not scroll sideways`, async ({
    page,
    baseURL,
  }, info) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    await open(page, baseURL);
    await expectNoSideScroll(page, "totals");
    const shots = process.env.SR_SHOTS;
    if (shots !== undefined && !narrow && info.project.name === "w1024")
      await page.screenshot({ path: `${shots}/research-1024.png`, fullPage: true });
  });

  test(`trace${tag}: the research page does not scroll sideways`, async ({ page, baseURL }) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    await open(page, baseURL);
    await page
      .getByRole("button", { name: /SEC approves in-kind/ })
      .first()
      .click();
    await expect(page.locator("#sr-funnel").getByRole("status").first()).toContainText(
      /Reached Decide|Stopped at|Merged at/,
    );
    await expectNoSideScroll(page, "trace");
  });

  test(`Bots & labels open${tag}: the research page does not scroll sideways`, async ({
    page,
    baseURL,
  }) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    await open(page, baseURL);
    await page.locator("#sr-bots-labels summary").click();
    await expect(page.getByRole("heading", { name: "Bots & labels" })).toBeVisible();
    await expect(page.getByText("Hide", { exact: true })).toBeVisible();
    await expectNoSideScroll(page, "Bots & labels open");
  });

  test(`Is it working? tabs${tag}: the research page does not scroll sideways`, async ({
    page,
    baseURL,
  }) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    await open(page, baseURL);
    const tabs = page.getByRole("tablist", { name: /./ }).filter({ hasText: "Overall" });
    for (const name of ["Overall", "By level", "By market", "Does context help?"]) {
      const tab = tabs.getByRole("tab", { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expectNoSideScroll(page, `Is it working? › ${name}`);
    }
  });

  test(`history across Rules versions${tag}: chips, divider, banner and All rules do not scroll sideways (#413)`, async ({
    page,
    baseURL,
  }) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    await open(page, baseURL, true);
    await expect(page.getByTestId("sr-rules-divider").first()).toBeVisible();
    await expect(page.getByTestId("sr-rules-split")).toBeVisible();
    await expectNoSideScroll(page, "history · totals");
    await page.getByRole("radio", { name: "All rules" }).click();
    await expect(page.getByTestId("sr-all-rules-sum")).toBeVisible();
    await expectNoSideScroll(page, "history · All rules");
    await page
      .getByRole("button", { name: /Solana Foundation flags exploit/ })
      .first()
      .click();
    await expect(page.getByTestId("sr-old-rules-banner")).toBeVisible();
    await expectNoSideScroll(page, "history · old trace");
  });
}
