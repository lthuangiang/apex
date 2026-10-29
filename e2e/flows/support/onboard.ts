import { randomBytes } from "node:crypto";

import { expect, type Page, type TestInfo } from "@playwright/test";

import { totp } from "./totp";
import { installWallet } from "./wallet";

// Đăng ký email + mật khẩu (DEC-76), kết nối SoDEX bằng hai chữ ký, bật 2FA. Dùng cho các flow sau P3.
export async function signUpConnectAnd2fa(page: Page, info: TestInfo) {
  const email = `e2e-${info.project.name}-${String(Date.now())}@drift.test`;
  const address = await installWallet(page, `0x${randomBytes(32).toString("hex")}`);
  const accountID = 500_000 + Math.floor(Math.random() * 100_000);
  const registered = await fetch(`${process.env.E2E_MOCK_CONTROL ?? ""}/__mock/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, accountID }),
  });
  expect(registered.status).toBe(204);

  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("e2e correct horse battery");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding\/connect$/);
  await page.getByRole("button", { name: "Connect your SoDEX master wallet" }).click();
  await page.getByRole("button", { name: "Browser wallet" }).click();
  await page.getByRole("button", { name: "Sign 1 of 2: create key" }).click();
  await page.getByRole("button", { name: "Sign 2 of 2: approve fee" }).click();
  await expect(page.getByRole("status", { name: "Connected · confirmed by SoDEX" })).toBeVisible();

  await page.goto("/settings");
  await page.getByRole("tab", { name: "Security" }).click();
  await page.getByRole("button", { name: "Set up 2FA" }).click();
  const secret = (await page.locator("code").innerText()).replace(/\s/g, "");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByLabel("6-digit code from the app").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.getByRole("button", { name: "I saved them · turn on 2FA" }).click();
  await expect(page.getByText("● On")).toBeVisible();
  return { address, accountID, secret };
}
