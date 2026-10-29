import { expect, test } from "@playwright/test";

import { chooseMarket, fillBotName, startButton } from "../support/bot";
import { signUpConnectAnd2fa } from "../support/onboard";
import { nextTotpWindow, totp } from "../support/totp";

// Tiêu chí P7 (docs/ROADMAP.md): tạo bot → start → Running chỉ khi SoDEX ack lệnh đầu → pause/resume →
// sửa thành v2 → stop. Giá do global-setup đẩy vào NATS `md.vBTC_vUSDC.price` mỗi giây.

test("create a Spot Grid, start it, pause, resume, edit to v2 and stop", async ({ page }, info) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => {
    pageErrors.push(e.message);
  });
  const { address, secret } = await signUpConnectAnd2fa(page, info);

  await page.goto("/bots");
  await page.getByRole("tab", { name: /Strategy catalog/ }).click();
  await page.getByRole("link", { name: "Set up Spot Grid" }).click();
  await expect(page.getByRole("heading", { name: "Create Spot Grid" })).toBeVisible();
  await expect(page.getByText("Paper · Coming soon")).toBeVisible();

  await fillBotName(page, "Grid · BTC");
  await chooseMarket(page, "vBTC_vUSDC");
  await page.getByLabel("Lower price").fill("120");
  await page.getByLabel("Upper price").fill("110");
  await page.getByLabel("Grid levels").fill("5");
  await page.getByLabel("Investment").fill("500");
  await page.getByLabel("Max loss for this bot").fill("100");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Must be lower than the upper price.")).toBeVisible();
  await page.getByLabel("Lower price").fill("90");
  await page.getByRole("button", { name: "Save draft" }).click();

  const checks = page.getByRole("region", { name: "Before it starts" });
  await expect(checks.getByText("Builder fee approval")).toBeVisible();
  await expect(checks.getByText("✕")).toHaveCount(0, { timeout: 15_000 });
  await checks.getByRole("checkbox").check();
  await nextTotpWindow();
  await checks.getByLabel("2FA code").fill(totp(secret));
  await startButton(page).click();
  await expect(page.getByText("Start requested · waiting for backend")).toBeVisible();
  await page.getByRole("link", { name: "Watch it in Trading Agent" }).click();

  // Running chỉ sau khi engine gửi lệnh và mock SoDEX ack.
  const status = page.getByRole("status", { name: "Status" });
  await expect(status).toContainText("Running", { timeout: 30_000 });
  const placed = (await (
    await fetch(`${process.env.E2E_MOCK_CONTROL ?? ""}/__mock/orders?address=${address}`)
  ).json()) as unknown[];
  expect(placed.length).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(status).toContainText("Paused", { timeout: 15_000 });
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(status).toContainText("Running", { timeout: 15_000 });

  await page.getByRole("link", { name: "Edit bot" }).click();
  await expect(page.getByRole("heading", { name: "Edit Grid · BTC" })).toBeVisible();
  await page.getByLabel("Grid levels").fill("7");
  await page.getByRole("button", { name: "Review and apply v2" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Apply v2" }).click();
  await expect(page.getByText("v2 is live.")).toBeVisible({ timeout: 30_000 });

  await page.goto(page.url().replace(/\/bots\/([^/]+)\/edit$/, "/agent/$1"));
  await expect(page.getByText("v2 ·")).toBeVisible();
  await page.getByRole("button", { name: "Stop agent…" }).click();
  const stop = page.getByRole("dialog", { name: "Stop Grid · BTC?" });
  await nextTotpWindow();
  await stop.getByLabel("2FA code").fill(totp(secret));
  await stop.getByRole("button", { name: /Stop and cancel/ }).click();
  await expect(status).toContainText("Stopped", { timeout: 30_000 });

  await page.goto("/orders");
  await expect(page.getByRole("heading", { name: "Execution & Orders" })).toBeVisible();
  await expect(page.getByText("Cancelled").first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});
