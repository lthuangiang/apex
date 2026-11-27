import { expect, test, type Page } from "@playwright/test";

import {
  FAKE_TOKEN,
  MASTER,
  defaultRoutes,
} from "../src/features/rewards/__tests__/gateway-fixtures";

// #558 PR5 (bản phác docs/mockups/rewards/server-token/): khối đồng ý trên màn ký, dải trạng thái (active / paused) và
// thẻ Settings › Notifications không làm trang cuộn ngang ở 1024 / 1280 / 1440 và 390. API DeskLabs và gateway SoDEX
// đều giả; token là chuỗi giả. `REWARDS_SHOTS=dir` thì lưu ảnh.

interface Watch {
  status: string;
  reason: string | null;
}

async function routes(page: Page, baseURL: string | undefined, watch: Watch) {
  await page
    .context()
    .addCookies([{ name: "drift_session", value: "x", url: baseURL ?? "http://127.0.0.1" }]);
  await page.route("**/api/**", async (r) => {
    const url = new URL(r.request().url());
    const json = (body: unknown, status = 200) =>
      r.fulfill({
        status,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(body),
      });
    if (url.hostname !== new URL(baseURL ?? "http://127.0.0.1").hostname) {
      const path = url.pathname.replace(/^\/api\/v1\//, "") as keyof ReturnType<
        typeof defaultRoutes
      >;
      const reply = defaultRoutes()[path];
      if (typeof reply === "object") return json(reply.body, reply.status ?? 200);
      return json({}, 404);
    }
    const p = url.pathname;
    if (p === "/api/v1/rewards/watch")
      return json({
        status: watch.status,
        reason: watch.reason,
        expiresAt: "2026-12-11T07:02:00.000Z",
        lastCheckedAt: "2026-11-26T08:40:00.000Z",
        delayed: false,
      });
    if (p === "/api/v1/features")
      return json({
        volumeMaker: false,
        volumeFarm: false,
        aiDesk: true,
        adaptiveDca: false,
        sodexRewards: true,
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
    if (p === "/api/v1/sodex/connection")
      return json({
        connection: {
          address: MASTER,
          sodexAccountId: "1234",
          status: "connected",
          apiKey: null,
          builderFee: null,
        },
      });
    if (p === "/api/v1/notifications") return json({ items: [], unread: 0 });
    if (p === "/api/v1/notifications/settings")
      return json({
        groups: ["botErrors", "risk", "keyFee", "fills", "daily", "copyTrading", "rewards"].map(
          (group) => ({
            group,
            alwaysOn: group === "botErrors",
            in_app: group !== "fills" && group !== "daily",
            email: ["botErrors", "risk", "keyFee"].includes(group),
            telegram: !["fills", "copyTrading"].includes(group),
          }),
        ),
      });
    if (p === "/api/v1/telegram/link") return json({ status: "not_connected" });
    if (p === "/api/v1/bots") return json({ items: [] });
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

async function shot(page: Page, name: string, narrow: boolean, project: string) {
  const dir = process.env.REWARDS_SHOTS;
  if (dir !== undefined && dir !== "")
    await page.screenshot({
      path: `${dir}/${name}-${narrow ? "390" : project}.png`,
      fullPage: true,
    });
}

for (const narrow of [false, true]) {
  const at = narrow ? " at 390" : "";

  test(`Rewards sign-in with the alerts consent${at}: no side scroll`, async ({
    page,
    baseURL,
  }, info) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    await routes(page, baseURL, { status: "off", reason: null });
    await page.goto("/rewards");
    await expect(page.getByRole("switch", { name: "Tell me about new boxes" })).toBeChecked();
    expect.soft(await sideScroll(page), "page does not scroll sideways").toBeLessThanOrEqual(0);
    await shot(page, "st-01", narrow, info.project.name);
  });

  test(`Rewards signed in, alerts on${at}: no side scroll`, async ({ page, baseURL }, info) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    await routes(page, baseURL, { status: "active", reason: null });
    await page.addInitScript(
      ([k, v]) => {
        localStorage.setItem(k, v);
      },
      [`desklabs.rewards.jwt.${MASTER.toLowerCase()}`, FAKE_TOKEN] as const,
    );
    await page.goto("/rewards");
    await page.getByText(/DeskLabs checks SoDEX for new boxes until/).waitFor();
    expect.soft(await sideScroll(page), "page does not scroll sideways").toBeLessThanOrEqual(0);
    await shot(page, "st-03", narrow, info.project.name);
  });

  test(`Rewards alerts paused${at}: no side scroll`, async ({ page, baseURL }, info) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    await routes(page, baseURL, { status: "paused", reason: "expired" });
    await page.goto("/rewards");
    await page.getByText("Notifications paused: sign in again").waitFor();
    expect.soft(await sideScroll(page), "page does not scroll sideways").toBeLessThanOrEqual(0);
    await shot(page, "st-05", narrow, info.project.name);
  });

  test(`Settings › Notifications with the rewards card${at}: no side scroll`, async ({
    page,
    baseURL,
  }, info) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    await routes(page, baseURL, { status: "active", reason: null });
    await page.goto("/settings?tab=notifications");
    await page.getByRole("heading", { name: "SoDEX rewards alerts" }).waitFor();
    await expect(page.getByText("SoDEX rewards", { exact: true })).toBeVisible();
    expect.soft(await sideScroll(page), "page does not scroll sideways").toBeLessThanOrEqual(0);
    await shot(page, "st-07", narrow, info.project.name);
  });
}
