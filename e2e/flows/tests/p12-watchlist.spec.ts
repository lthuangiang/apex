import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { chooseMarket } from "../support/bot";
import { signUpConnectAnd2fa } from "../support/onboard";

// Watchlist của Overview (UI_REVIEW M2, DEC-74): seed BTC-USD, sửa bằng bàn phím (▲ ▼ ×), thêm market Spot,
// lưu qua backend; menu dòng mở Strategy Lab với market điền sẵn; axe không lỗi ở chế độ sửa.

test("edit the watchlist, reorder, save, and start a bot from a row", async ({ page }, info) => {
  await signUpConnectAnd2fa(page, info);
  await page.goto("/");
  const card = page.getByRole("region", { name: "Watchlist" });
  await expect(card.getByRole("button", { name: "Actions for BTC-USD" })).toBeVisible();
  await expect(card.getByText("Price · 24h")).toBeVisible();

  await card.getByRole("button", { name: "Edit watchlist" }).click();
  await card.getByRole("button", { name: "+ Add market" }).click();
  await card.getByRole("radio", { name: "Spot" }).click();
  await chooseMarket(page, "BTC", "Market");
  await expect(card.getByRole("button", { name: "Remove vBTC_vUSDC" })).toBeVisible();

  const axe = await new AxeBuilder({ page })
    .include("section[aria-labelledby]")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations
      .filter((x) => x.impact === "serious" || x.impact === "critical")
      .map((x) => x.id),
  ).toEqual([]);

  await card.getByRole("button", { name: "Move vBTC_vUSDC up" }).focus();
  await page.keyboard.press("Enter");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByRole("button", { name: "Edit watchlist" })).toBeVisible();
  const rows = card.getByRole("button", { name: /^Actions for / });
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAccessibleName("Actions for vBTC_vUSDC");

  await page.reload();
  await expect(card.getByRole("button", { name: /^Actions for / }).first()).toHaveAccessibleName(
    "Actions for vBTC_vUSDC",
  );

  await card.getByRole("button", { name: "Actions for BTC-USD" }).click();
  await card.getByRole("menuitem", { name: "New bot on BTC-USD" }).click();
  await expect(page.getByText("Strategies that can trade BTC-USD")).toBeVisible();
  await expect(page.getByRole("link", { name: "Set up Spot Grid" })).toHaveCount(0);
  await page.getByRole("link", { name: "Set up Futures Grid" }).click();
  await expect(page).toHaveURL(/market=BTC-USD/);
  await expect(page.getByLabel("Contract", { exact: true })).toHaveValue("BTC-USD");
  await expect(page.getByRole("button", { name: /^On watchlist · remove BTC-USD/ })).toBeVisible();
});
