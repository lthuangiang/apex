import { expect, test, type Page } from "@playwright/test";

import { markets, wealthOk } from "../src/features/us-market/__tests__/fixtures";

// #591: trang /markets/us (bản phác màn 02) và banner Strategy Lab (màn 01) không bao giờ cuộn ngang ở 1024 / 1280 / 1440
// (project) và 390; bảng cuộn ngang trong khung riêng. API giả (page.route). `US_MARKET_SHOTS=dir` thì lưu ảnh để đối chiếu.

async function mockApi(page: Page, baseURL: string | undefined) {
  await page
    .context()
    .addCookies([{ name: "drift_session", value: "x", url: baseURL ?? "http://127.0.0.1" }]);
  await page.route("**/api/**", async (r) => {
    const p = new URL(r.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/api/v1/features")
      return json({
        volumeMaker: true,
        volumeFarm: true,
        aiDesk: true,
        adaptiveDca: false,
        signalResearch: true,
        usMarket: true,
        depthCapMarkets: ["ANT-USD", "vANT_vUSDC"],
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
    if (p === "/api/v1/sodex/connection") return json({ connection: null });
    if (p === "/api/v1/notifications") return json({ items: [], unread: 0 });
    if (p === "/api/v1/bots") return json({ items: [] });
    if (p === "/api/v1/markets/us") return json({ ...markets(), readAt: new Date().toISOString() });
    if (p === "/api/v1/wealth/me") return json(wealthOk());
    return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  });
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
  test(`US Market page${narrow ? " at 390" : ""}: no side scroll`, async ({
    page,
    baseURL,
  }, info) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page, baseURL);
    await page.goto("/markets/us");
    await page.getByRole("heading", { name: "US Market", level: 1 }).first().waitFor();
    await page.getByText("UNITREE FUND").first().waitFor();
    expect.soft(await sideScroll(page), "page does not scroll sideways").toBeLessThanOrEqual(0);
    const dir = process.env.US_MARKET_SHOTS;
    if (dir !== undefined && dir !== "")
      await page.screenshot({
        path: `${dir}/02-${narrow ? "390" : info.project.name}.png`,
        fullPage: true,
      });
  });

  test(`Strategy Lab banner${narrow ? " at 390" : ""}: no side scroll`, async ({
    page,
    baseURL,
  }, info) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page, baseURL);
    await page.goto("/bots?tab=catalog");
    await page.getByRole("link", { name: "See US Market" }).waitFor();
    expect.soft(await sideScroll(page), "page does not scroll sideways").toBeLessThanOrEqual(0);
    const dir = process.env.US_MARKET_SHOTS;
    if (dir !== undefined && dir !== "")
      await page.screenshot({
        path: `${dir}/01-${narrow ? "390" : info.project.name}.png`,
        fullPage: true,
      });
  });
}
