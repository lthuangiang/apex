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
  V4,
  VERSIONS,
} from "../src/features/signal-analysis/__tests__/versions-fixtures";

// #423: trang Signal Research BETA (/signal-research) của người dùng test không bao giờ cuộn ngang, ở 1024 / 1280 / 1440
// (project) và 390: sidebar có mục Beta, ô Version có nhóm Team versions / My versions, khu Bots & labels mở. API giả trả
// như API thật cho người dùng test (chỉ không có Claude cost; PM review #428).

const TESTER_VERSIONS = {
  ...VERSIONS,
  items: [
    {
      ...V4,
      id: "00000000-0000-4000-8000-000000000012",
      number: 12,
      name: "BTC only",
      owner: "me",
    },
    ...VERSIONS.items,
  ],
  running: 1,
  versionsTried: 2,
  extraCheck: false,
};
const TESTER_SUMMARY = {
  ...SUMMARY_1D,
  funnel:
    SUMMARY_1D.funnel === null
      ? null
      : { ...SUMMARY_1D.funnel, claudeCost: null, claudeCostPerDay: null },
};

async function open(page: Page, baseURL: string | undefined) {
  await page
    .context()
    .addCookies([{ name: "drift_session", value: "x", url: baseURL ?? "http://127.0.0.1" }]);
  await page.route("**/api/**", async (r) => {
    const p = new URL(r.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/api/v1/features")
      return json({
        volumeMaker: false,
        volumeFarm: false,
        aiDesk: true,
        adaptiveDca: false,
        signalResearch: true,
      });
    if (p === "/api/v1/me")
      return json({
        id: "00000000-0000-4000-8000-0000000000aa",
        email: "tester@drift.test",
        displayName: null,
        timezone: "UTC",
        numberFormat: "en-US",
        twoFactorEnabled: false,
        role: "user",
      });
    if (p.endsWith("/signal-research/summary")) return json(TESTER_SUMMARY);
    if (p.endsWith("/signal-research/trades")) return json(RESEARCH_TRADES);
    if (p.endsWith("/signal-research/articles/new")) return json({ items: [], since: "c1" });
    if (p.endsWith("/signal-research/latency")) return json(LATENCY_1D);
    if (p.endsWith("/signal-research/versions")) return json(TESTER_VERSIONS);
    if (p.endsWith("/signal-research/classifiers")) return json(CLASSIFIERS);
    if (p.endsWith("/signal-research/markets")) return json(MARKETS);
    if (p.endsWith("/signal-research/articles"))
      return json({
        items: ARTICLES.map((a) => ({
          ...a,
          claude: a.claude === null ? null : { ...a.claude, tokens: null, costUsd: null },
        })),
        nextCursor: null,
        total: ARTICLES.length,
        totalInRange: 58,
      });
    const m = /\/signal-research\/articles\/([^/]+)\/trace$/.exec(p);
    const tr = m === null ? undefined : TRACES[decodeURIComponent(m[1] ?? "")];
    if (tr !== undefined) return json(tr);
    return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  });
  await page.goto("/signal-research");
  await page.getByTestId("sr-funnel-bands").waitFor();
  await page
    .getByRole("button", { name: /^Trace: / })
    .first()
    .waitFor();
}

async function sideScroll(page: Page) {
  await page.evaluate(
    () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))),
  );
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

for (const narrow of [false, true]) {
  const tag = narrow ? " at 390" : "";

  test(`Signal Research BETA${tag}: no side scroll, no Claude cost, Beta in the nav`, async ({
    page,
    baseURL,
  }) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    await open(page, baseURL);
    await expect(page.getByText("Claude cost", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Where the time goes")).toBeVisible();
    if (!narrow) {
      const link = page.getByRole("link", { name: /Signal Research/ }).first();
      await expect(link).toHaveAttribute("href", "/signal-research");
      await expect(link).toContainText("Beta");
    }
    expect.soft(await sideScroll(page), "page does not scroll sideways").toBeLessThanOrEqual(0);
    await page.locator("#sr-bots-labels summary").click();
    await expect(page.getByRole("heading", { name: "Bots & labels" })).toBeVisible();
    expect
      .soft(await sideScroll(page), "Bots & labels open: page does not scroll sideways")
      .toBeLessThanOrEqual(0);
  });
}
