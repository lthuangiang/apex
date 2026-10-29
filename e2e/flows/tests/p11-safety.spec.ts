import { expect, test } from "@playwright/test";

import { createRunningGrid } from "../support/bot";
import { signUpConnectAnd2fa } from "../support/onboard";
import { nextTotpWindow, totp } from "../support/totp";

// Definition of done (CODING_STANDARDS mục 14): lệnh unknown → đối soát (không gửi lại), và revoke fee → mọi bot
// bị pause với BUILDER_FEE_REVOKED, lệnh đang mở được giữ.

const control = () => process.env.E2E_MOCK_CONTROL ?? "";

test("an order with an unknown result is reconciled, never resent; revoking the fee pauses the bot", async ({
  page,
}, info) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => {
    pageErrors.push(e.message);
  });
  const { address, secret } = await signUpConnectAnd2fa(page, info);
  const agentUrl = await createRunningGrid(page, secret);

  // Lệnh của v2 gặp timeout sau khi SoDEX đã nhận: phải hiện unknown rồi được đối soát thành open.
  const inject = await fetch(`${control()}/__mock/fail-next`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "timeout-after-apply" }),
  });
  expect(inject.status).toBe(204);
  await page.goto(agentUrl.replace(/\/agent\/([^/]+)$/, "/bots/$1/edit"));
  await page.getByLabel("Grid levels").fill("7");
  await page.getByRole("button", { name: "Review and apply v2" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Apply v2" }).click();
  await expect(page.getByText("v2 is live.")).toBeVisible({ timeout: 30_000 });

  await page.goto("/orders");
  await expect(page.getByText(/order(s)? (has|have) an unknown result/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/order(s)? (has|have) an unknown result/)).toHaveCount(0, {
    timeout: 30_000,
  });
  const placed = (await (await fetch(`${control()}/__mock/orders?address=${address}`)).json()) as {
    clOrdID: string;
  }[];
  expect(new Set(placed.map((o) => o.clOrdID)).size).toBe(placed.length);

  // Revoke fee → engine đọc lại approval → bot Paused (builder fee approval is 0); lệnh mở được giữ.
  const openBefore = placed.filter((o) => (o as { status?: string }).status === "NEW").length;
  await page.goto("/settings");
  await page.getByRole("button", { name: "Revoke (set to 0)…" }).click();
  const dialog = page.getByRole("dialog", { name: "Revoke DRIFT’s builder fee?" });
  await nextTotpWindow();
  await dialog.getByLabel("2FA code").fill(totp(secret));
  await dialog.getByRole("button", { name: "Sign to revoke" }).click();
  await expect(page.getByText("❚❚ Revoked")).toBeVisible();

  await page.goto(agentUrl);
  await expect(page.getByRole("status", { name: "Status" })).toContainText("Paused", {
    timeout: 30_000,
  });
  await expect(page.getByRole("status", { name: "Status" })).toContainText(
    "builder fee approval is 0",
  );
  const after = (await (await fetch(`${control()}/__mock/orders?address=${address}`)).json()) as {
    status: string;
  }[];
  expect(after.filter((o) => o.status === "NEW").length).toBe(openBefore);
  expect(pageErrors).toEqual([]);
});
