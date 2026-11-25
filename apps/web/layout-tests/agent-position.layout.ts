import { createRequire } from "node:module";

import { expect, test, type Page } from "@playwright/test";

// #527: trang Trading Agent (/agent/:botId) với bot Volume Builder đang giữ vị thế Long: ô Open orders có "Long … USDC at
// …" và "Unrealized +… USDC", ô Last decision có "Hold 172 s" và đồng hồ "… s left". Hai dòng nhỏ nằm trong ô, không làm
// trang cuộn ngang ở 1024 / 1280 / 1440 (project) và 390; axe (wcag2a/aa, wcag21, wcag22aa).

const BOT_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date().toISOString();
const BOT = {
  id: BOT_ID,
  name: "ETH Builder",
  strategy: "volume_farm",
  market: "ETH-USD",
  engine: "perps",
  state: "running",
  reasonCode: null,
  needsAttention: false,
  activeVersion: 1,
  netPnl: "0.12",
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
        volumeMaker: true,
        volumeFarm: true,
        aiDesk: true,
        adaptiveDca: false,
        signalResearch: false,
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
    if (p === `/api/v1/bots/${BOT_ID}`) {
      const now = Date.now();
      return json({
        bot: BOT,
        versions: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            version: 1,
            config: {
              market: "ETH-USD",
              leverage: 20,
              marginMode: "isolated",
              orderSizeMinUsd: "50",
              orderSizeMaxUsd: "60",
              minHoldSecs: 120,
              maxHoldSecs: 180,
              maxLoss: "20",
            },
            paramSource: "manual",
            status: "active",
            appliedAt: NOW,
            createdAt: NOW,
          },
        ],
        events: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            type: "decision",
            decision: "Open long",
            why: "Long, 55.38 USDC, hold 172 s.",
            result: null,
            outcome: "filled",
            order: null,
            entryTry: null,
            rejectCode: null,
            fillPrice: null,
            occurredAt: new Date(now - 48_000).toISOString(),
          },
        ],
        openOrders: 1,
        positionShown: true,
        position: {
          side: "long",
          qty: "0.03324",
          value: "55.38",
          avgEntry: "1666.2",
          markPrice: "1667.4",
          unrealizedPnl: "0.0399",
        },
        pendingOrder: null,
        hold: {
          phase: "open",
          holdSecs: 172,
          openedAt: new Date(now - 48_000).toISOString(),
          holdUntil: new Date(now + 124_000).toISOString(),
        },
        serverTime: new Date(now).toISOString(),
      });
    }
    return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  });
  await page.goto(`/agent/${BOT_ID}`);
  await page.getByText("Hold 172 s", { exact: true }).waitFor();
}

async function settle(page: Page) {
  await page.evaluate(
    () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))),
  );
}

async function axe(page: Page) {
  await page.addScriptTag({ path: createRequire(import.meta.url).resolve("axe-core") });
  return page.evaluate(async () => {
    const w = window as unknown as {
      axe: {
        run: (ctx: Element, o: unknown) => Promise<{ violations: { id: string; help: string }[] }>;
      };
    };
    const dl = document.querySelector("dl");
    if (dl === null) return ["no tiles"];
    const r = await w.axe.run(dl, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    });
    return r.violations.map((v) => `${v.id}: ${v.help}`);
  });
}

for (const narrow of [false, true]) {
  test(`Trading Agent · Volume Builder${narrow ? " at 390" : ""}: position and hold lines sit in their tiles, axe`, async ({
    page,
    baseURL,
  }, info) => {
    test.skip(narrow && info.project.name !== "w1440", "390 chỉ chạy một lần");
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    await open(page, baseURL);
    await settle(page);
    await expect(page.getByText("Long", { exact: true })).toBeVisible();
    await expect(page.getByText("Unrealized +0.04 USDC")).toBeVisible();
    await expect(page.getByText(/^\d+ s left$/)).toBeVisible();
    await expect(page.locator("body")).not.toContainText("agent.position");
    await expect(page.locator("body")).not.toContainText("agent.hold");
    const m = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll<HTMLElement>("dl > div")];
      return {
        sideScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        spill: tiles.filter((t) => t.scrollWidth > t.clientWidth + 1).length,
      };
    });
    expect.soft(m.sideScroll, "page does not scroll sideways").toBeLessThanOrEqual(0);
    expect.soft(m.spill, "tile text stays inside its tile").toBe(0);
    expect.soft(await axe(page), "axe on the tiles").toEqual([]);
    const shots = process.env.AGENT_SHOTS;
    if (shots !== undefined && info.project.name === "w1440")
      await page.screenshot({ path: `${shots}/agent-position-${narrow ? "390" : "1440"}.png` });
  });
}
