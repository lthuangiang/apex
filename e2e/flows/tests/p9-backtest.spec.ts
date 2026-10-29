import { expect, test } from "@playwright/test";

import { chooseMarket } from "../support/bot";
import { signUpConnectAnd2fa } from "../support/onboard";

// Tiêu chí P9 (docs/ROADMAP.md): tab Backtest chạy trên giá quá khứ (mock SoDEX, nến 5 phút cho 30D),
// hiện kết quả, giả định và câu "not a forecast"; đổi field thì kết quả cũ bị đánh dấu Out of date.

test("backtest a Spot Grid over 30 days and see it go out of date after an edit", async ({
  page,
}, info) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => {
    pageErrors.push(e.message);
  });
  await signUpConnectAnd2fa(page, info);

  await page.goto("/bots/new/spot_grid");
  await chooseMarket(page, "vBTC_vUSDC");
  await page.getByLabel("Lower price").fill("92");
  await page.getByLabel("Upper price").fill("108");
  await page.getByLabel("Grid levels").fill("9");
  await page.getByLabel("Investment").fill("1000");
  await page.getByLabel("Max loss for this bot").fill("200");

  await page.getByRole("tab", { name: "Backtest" }).click();
  await page.getByRole("radio", { name: "30D" }).click();
  const panel = page.getByRole("region", { name: "Backtest" });
  await expect(
    panel.getByText("Simulated on past prices. Not a forecast; future results will differ."),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Run backtest" }).click();
  await expect(
    page.getByText(/Simulating 8,640 5-minute candles…|Waiting for a backtest worker…/),
  ).toBeVisible();

  await expect(panel.getByText("Net result after fees")).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText("Fills")).toBeVisible();
  await expect(panel.getByText("Time in range")).toBeVisible();
  await expect(page.getByRole("img", { name: "Simulated equity · dashed = start" })).toBeVisible();
  await expect(page.getByText(/^Data: SoDEX 5-minute candles, /)).toBeVisible();
  await expect(page.getByText(/APR|expected profit/i)).toHaveCount(0);

  await page.getByLabel("Grid levels").fill("7");
  await expect(panel.getByText("Out of date · run again")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Run again" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
