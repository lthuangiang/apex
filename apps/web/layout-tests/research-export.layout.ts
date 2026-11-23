import { expect, test, type Page } from "@playwright/test";

// #495: nút Export data (#489) trên bản build production: hiện cho role team ở /signal-research và ở tab Signal research
// của Admin › Signal Analysis, ở 1024 / 1280 / 1440 (project) và 390; người dùng test (role user, có cờ) không thấy.

async function open(page: Page, baseURL: string | undefined, role: "team" | "user", path: string) {
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
        role,
      });
    return json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  });
  await page.goto(path);
  await page.getByRole("heading", { level: 1 }).first().waitFor();
}

const visibleExport = (page: Page) =>
  page.getByRole("button", { name: "Export data" }).filter({ visible: true });

for (const path of ["/signal-research", "/admin/signal-analysis?tab=research"]) {
  for (const narrow of [false, true]) {
    test(`Export data on ${path}${narrow ? " at 390" : ""}: team sees it, a tester does not`, async ({
      page,
      baseURL,
    }, info) => {
      test.skip(narrow && info.project.name !== "w1440", "390 chỉ chạy một lần");
      if (narrow) await page.setViewportSize({ width: 390, height: 844 });
      await open(page, baseURL, "team", path);
      await expect(visibleExport(page)).toHaveCount(1);
      await expect(
        page.getByRole("radiogroup", { name: "Export period" }).filter({ visible: true }),
      ).toHaveCount(1);
      if (path === "/signal-research") {
        await page.unrouteAll({ behavior: "ignoreErrors" });
        await open(page, baseURL, "user", path);
        await expect(page.getByRole("heading", { name: /Signal Research/ }).first()).toBeVisible();
        await expect(visibleExport(page)).toHaveCount(0);
      }
    });
  }
}
