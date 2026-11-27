import { expect, test, type Page } from "@playwright/test";

import {
  FAKE_TOKEN,
  MASTER,
  defaultRoutes,
} from "../src/features/rewards/__tests__/gateway-fixtures";

// #549: Overview khi công tắc `sodexRewards` bật (bản phác 02–03): thẻ SoDEX rewards đứng đúng chỗ thẻ Trading Agent (cạnh
// Performance; ở 390 ngay sau Performance), trang không cuộn ngang ở 1024 / 1280 / 1440 (project) và 390, chưa ký lẫn đã
// ký. API DeskLabs và gateway SoDEX rewards đều giả; token là chuỗi giả. `REWARDS_SHOTS=dir` thì lưu ảnh để đối chiếu.

async function open(page: Page, baseURL: string | undefined, signedIn: boolean) {
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
    if (p === "/api/v1/bots") return json({ items: [] });
    if (p === "/api/v1/overview")
      return json({
        portfolio: null,
        equityCurve: [
          { at: 1764000000000, equity: "12300.00" },
          { at: 1764003600000, equity: "12410.50" },
          { at: 1764007200000, equity: "12480.22" },
        ],
        realizedPnl: null,
        realizedSince: 1763900000000,
        risk: null,
        bots: [],
        activity: [],
        watchlist: [],
      });
    return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  });
  if (signedIn)
    await page.addInitScript(
      ([k, v]) => {
        localStorage.setItem(k, v);
      },
      [`desklabs.rewards.jwt.${MASTER.toLowerCase()}`, FAKE_TOKEN] as const,
    );
  await page.goto("/");
  await page.getByRole("heading", { name: "SoDEX rewards" }).waitFor();
  if (signedIn) await page.getByText("Open Rewards").waitFor();
  else await page.getByText("Weekly pool 1,000,000 SoPoints").waitFor();
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
  for (const signedIn of [false, true]) {
    const tag = `${signedIn ? "signed in" : "not signed in"}${narrow ? " at 390" : ""}`;
    test(`Overview rewards card ${tag}: in the Trading Agent slot, no side scroll`, async ({
      page,
      baseURL,
    }, info) => {
      if (narrow) await page.setViewportSize({ width: 390, height: 844 });
      await open(page, baseURL, signedIn);
      await expect(page.getByRole("heading", { name: "Trading Agent" })).toHaveCount(0);
      const card = page.locator('section[aria-labelledby="rewards-card-h"]');
      const perf = page.getByRole("region", { name: "Performance" });
      const c = await card.boundingBox();
      const pb = await perf.boundingBox();
      if (c === null || pb === null) throw new Error("cards not laid out");
      if (narrow) expect(c.y, "below Performance at 390").toBeGreaterThan(pb.y + pb.height - 1);
      else if (info.project.name !== "w1024")
        expect(Math.abs(c.y - pb.y), "same row as Performance").toBeLessThan(2);
      expect.soft(await sideScroll(page), "page does not scroll sideways").toBeLessThanOrEqual(0);
      const dir = process.env.REWARDS_SHOTS;
      if (dir !== undefined && dir !== "")
        await page.screenshot({
          path: `${dir}/ov-${signedIn ? "03" : "02"}-${narrow ? "390" : info.project.name}.png`,
          fullPage: true,
        });
    });
  }
}
