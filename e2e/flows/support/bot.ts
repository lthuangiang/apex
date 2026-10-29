import { expect, type Page } from "@playwright/test";

import { nextTotpWindow, totp } from "./totp";

/**
 * Chọn market trong combobox Market (UI_REVIEW E7, G6): gõ mã gốc để tìm rồi chọn kết quả đầu tiên.
 * Desktop gõ thẳng vào ô; mobile (< 768 px) ô mở bottom sheet có ô tìm riêng.
 */
export async function chooseMarket(page: Page, market: string, label = "Market") {
  const field = page.getByLabel(label, { exact: true });
  await field.click();
  const sheet = page.getByRole("dialog");
  const mobile = (page.viewportSize()?.width ?? 1440) < 768;
  const search = mobile ? sheet.getByRole("combobox") : field;
  await search.fill(market);
  await page.getByRole("option").first().click();
  await expect(sheet).toBeHidden();
}

/** Đặt tên bot: ô Bot name nằm trong "Advanced settings" (đóng mặc định, DEC-68). */
export async function fillBotName(page: Page, name: string) {
  const toggle = page.getByRole("button", { name: /^Advanced settings/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.getByLabel("Bot name").fill(name);
}

/** Start on mainnet: desktop nằm trong "Before it starts"; mobile là thanh dính đáy. */
export const startButton = (page: Page) =>
  page.getByRole("button", { name: "Start on mainnet" }).filter({ visible: true });

/** Tạo một Spot Grid trên vBTC_vUSDC và start; trả về khi Trading Agent hiện Running. */
export async function createRunningGrid(page: Page, secret: string, name = "Grid · BTC") {
  await page.goto("/bots/new/spot_grid");
  await fillBotName(page, name);
  await chooseMarket(page, "vBTC_vUSDC");
  await page.getByLabel("Lower price").fill("90");
  await page.getByLabel("Upper price").fill("110");
  await page.getByLabel("Grid levels").fill("5");
  await page.getByLabel("Investment").fill("500");
  await page.getByLabel("Max loss for this bot").fill("100");
  await page.getByRole("button", { name: "Save draft" }).click();
  const checks = page.getByRole("region", { name: "Before it starts" });
  await expect(checks.getByText("✕")).toHaveCount(0, { timeout: 15_000 });
  await checks.getByRole("checkbox").check();
  await nextTotpWindow();
  await checks.getByLabel("2FA code").fill(totp(secret));
  await startButton(page).click();
  await page.getByRole("link", { name: "Watch it in Trading Agent" }).click();
  await expect(page.getByRole("status", { name: "Status" })).toContainText("Running", {
    timeout: 30_000,
  });
  return page.url();
}
