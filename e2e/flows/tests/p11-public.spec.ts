import { AxeBuilder } from "@axe-core/playwright";
import { SESSION_COOKIE } from "@drift/shared";
import { expect, test } from "@playwright/test";

// Trang công khai khi chưa đăng nhập (UI_REVIEW K, J8): axe không lỗi serious / critical, không cuộn ngang ở
// 1440 và 390; chỉ Landing được index; 404 dùng khung DRIFT. Chưa đăng nhập thì đường dẫn lạ về /signup
// (cổng đăng nhập), nên 404 kiểm bằng cookie phiên giả: trang 404 không gọi api.

test("public pages pass axe, only the landing is indexable, 404 has DRIFT chrome", async ({
  page,
  request,
}) => {
  const problems: string[] = [];
  for (const route of ["/", "/risk-disclosure"]) {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    for (const v of result.violations.filter(
      (x) => x.impact === "serious" || x.impact === "critical",
    )) {
      problems.push(
        `${route}: ${v.id} × ${String(v.nodes.length)} — ${v.nodes[0]?.target.join(" ") ?? ""}`,
      );
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 1) problems.push(`${route}: horizontal scroll ${String(overflow)}px`);
  }
  expect(problems).toEqual([]);

  await page.goto("/");
  await expect(page).toHaveTitle("DRIFT · Profit bots for SoDEX");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /^index/);
  await expect(page.locator('meta[property="og:image"]')).toHaveCount(1);
  await page.goto("/risk-disclosure");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

  await page.goto("/no-such-page");
  await expect(page).toHaveURL(/\/signup$/);
  await page
    .context()
    .addCookies([
      { name: SESSION_COOKIE, value: "e2e-not-a-session", url: new URL(page.url()).origin },
    ]);
  await page.goto("/no-such-page");
  await expect(
    page.getByRole("heading", { level: 1, name: "This page doesn't exist." }),
  ).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("link", { name: "Back to Overview" }),
  ).toBeVisible();
  const axe404 = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe404.violations.filter((x) => x.impact === "serious" || x.impact === "critical"),
  ).toEqual([]);

  const robots = await request.get("/robots.txt");
  expect(robots.ok()).toBe(true);
  expect(await robots.text()).toContain("Disallow: /");
  const og = await request.get("/opengraph-image");
  expect(og.headers()["content-type"]).toContain("image/png");
});
