import { baselineVersionConfig } from "@drift/shared";
import { expect, test, type Page } from "@playwright/test";

// #470: trang Trading Agent (/agent/:botId) với bot Signal Research (`news_signal`): không lộ key i18n, khối Configuration
// có cấu hình chỉ xem và link "Open in Signal Research", không cuộn ngang ở 1024 / 1280 / 1440 (project) và 390.

const BOT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-22T10:00:00.000Z";
const BOT = {
  id: BOT_ID,
  name: "Stock Monitor",
  strategy: "news_signal",
  market: "",
  engine: "perps",
  state: "running",
  reasonCode: null,
  needsAttention: false,
  activeVersion: 1,
  netPnl: null,
  createdAt: NOW,
  updatedAt: NOW,
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
    if (p === "/api/v1/bots") return json({ items: [BOT] });
    if (p === `/api/v1/bots/${BOT_ID}`)
      return json({
        bot: BOT,
        versions: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            version: 1,
            config: { ...baselineVersionConfig(), sizeUsdc: "50", leverage: 10 },
            paramSource: "manual",
            status: "active",
            appliedAt: NOW,
            createdAt: NOW,
          },
        ],
        events: [],
        openOrders: 0,
        serverTime: NOW,
        recentErrors: [],
      });
    if (p.endsWith(`/signal-research/bots/${BOT_ID}/trades`)) return json({ items: [] });
    return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  });
  await page.goto(`/agent/${BOT_ID}`);
  await page.getByRole("heading", { name: "Configuration" }).waitFor();
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
  test(`Trading Agent · news bot${narrow ? " at 390" : ""}: config, link, no raw keys, no side scroll`, async ({
    page,
    baseURL,
  }, info) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    await open(page, baseURL);
    const shots = process.env.AGENT_SHOTS;
    if (shots !== undefined && info.project.name === "w1440")
      await page.screenshot({
        path: `${shots}/agent-news-${narrow ? "390" : "1440"}.png`,
        fullPage: true,
      });
    await expect(page.getByText("10×, isolated")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open in Signal Research" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("createBot.strategies");
    expect.soft(await sideScroll(page), "page does not scroll sideways").toBeLessThanOrEqual(0);
  });
}
