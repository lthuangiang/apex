import { expect, test, type Page } from "@playwright/test";

import {
  FAKE_TOKEN,
  MASTER,
  defaultRoutes,
} from "../src/features/rewards/__tests__/gateway-fixtures";

// #548: trang /rewards (bản phác 08–09) không bao giờ cuộn ngang ở 1024 / 1280 / 1440 (project) và 390, cả khi chưa ký
// (khối mời ký + dữ liệu công khai) lẫn khi đã ký (tab SoPoints, bảng tuần cuộn trong khung riêng). API DeskLabs và
// gateway SoDEX rewards đều giả; token là chuỗi giả trong sessionStorage. `REWARDS_SHOTS=dir` thì lưu ảnh để đối chiếu.

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
    return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  });
  if (signedIn)
    await page.addInitScript(
      ([k, v]) => {
        sessionStorage.setItem(k, v);
      },
      [`desklabs.rewards.jwt.${MASTER.toLowerCase()}`, FAKE_TOKEN] as const,
    );
  await page.goto("/rewards");
  await page.getByRole("heading", { name: "Rewards", level: 1 }).first().waitFor();
  if (signedIn) await page.getByText("48,210").waitFor();
  else await page.getByText("1,000,000").first().waitFor();
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
    test(`Rewards ${tag}: no side scroll`, async ({ page, baseURL }, info) => {
      if (narrow) await page.setViewportSize({ width: 390, height: 844 });
      await open(page, baseURL, signedIn);
      expect.soft(await sideScroll(page), "page does not scroll sideways").toBeLessThanOrEqual(0);
      const dir = process.env.REWARDS_SHOTS;
      if (dir !== undefined && dir !== "")
        await page.screenshot({
          path: `${dir}/${signedIn ? "09" : "08"}-${narrow ? "390" : info.project.name}.png`,
          fullPage: true,
        });
    });
  }
}

// #550: tab Blind Boxes (bản phác 10–14) ở từng tab con, đã ký: không cuộn ngang.
const SUBS = [
  ["Backpack", "10", "Boxes in your backpack"],
  ["History", "12", "Rewards from opened boxes"],
  ["Weekly draw", "13", "Round 10"],
  ["Live feed", "14", "0x67fc…c7a0"],
] as const;
for (const narrow of [false, true]) {
  for (const [sub, shot, marker] of SUBS) {
    test(`Rewards Blind Boxes › ${sub}${narrow ? " at 390" : ""}: no side scroll`, async ({
      page,
      baseURL,
    }, info) => {
      if (narrow) await page.setViewportSize({ width: 390, height: 844 });
      await open(page, baseURL, true);
      await page.getByRole("tab", { name: /^Blind Boxes/ }).click();
      await page.getByRole("tab", { name: new RegExp(`^${sub}`) }).click();
      await page.getByText(marker).first().waitFor();
      expect.soft(await sideScroll(page), "page does not scroll sideways").toBeLessThanOrEqual(0);
      const dir = process.env.REWARDS_SHOTS;
      if (dir !== undefined && dir !== "")
        await page.screenshot({
          path: `${dir}/${shot}-${narrow ? "390" : info.project.name}.png`,
          fullPage: true,
        });
    });
  }
}
