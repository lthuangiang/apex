import { expect, test } from "@playwright/test";

import { signUpConnectAnd2fa } from "../support/onboard";

// Chưa đăng nhập: mọi trang chuyển về /signup, trừ Landing (`/`) và `/risk-disclosure`. Đã đăng nhập: /signup và
// /signin chuyển về Overview.

test("pages need a session; signed-in users skip sign-up", async ({ page }, info) => {
  for (const route of ["/bots", "/settings", "/risk"]) {
    await page.goto(route);
    await expect(page).toHaveURL(/\/signup$/);
  }
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: /Your trading, studied/ }),
  ).toBeVisible();
  await page.goto("/risk-disclosure");
  await expect(page.getByRole("heading", { level: 1, name: "Risk Disclosure" })).toBeVisible();
  await signUpConnectAnd2fa(page, info);
  await page.goto("/signup");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await page.goto("/signin");
  await expect(page).toHaveURL(/\/$/);

  // Sign out: thu hồi phiên ở server, về /signin; các trang lại cần đăng nhập.
  // Desktop: menu avatar; mobile (< 1024 px): cuối sheet More.
  const mobile = (page.viewportSize()?.width ?? 1440) < 1024;
  await page.getByRole("button", { name: mobile ? "More" : "Account menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signin$/);
  await page.goto("/bots");
  await expect(page).toHaveURL(/\/signup$/);

  // Phiên bị thu hồi phía server: lần gọi api kế tiếp trả 401 → về /signup.
  await page
    .context()
    .addCookies([
      { name: "drift_session", value: "revoked-token", domain: "127.0.0.1", path: "/" },
    ]);
  await page.goto("/portfolio");
  await expect(page).toHaveURL(/\/signup$/, { timeout: 15_000 });
});
