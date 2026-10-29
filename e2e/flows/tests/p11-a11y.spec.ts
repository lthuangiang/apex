import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { signUpConnectAnd2fa } from "../support/onboard";

// P11 (ROADMAP): không còn lỗi a11y nghiêm trọng trên mọi màn (axe, mức serious / critical), ở 1440 và 390;
// không có thanh cuộn ngang toàn trang; header bảo mật (CSP có nonce, không `unsafe-inline` cho script).

const ROUTES = [
  "/",
  "/portfolio",
  "/bots",
  "/bots/new/spot_grid",
  "/agent",
  "/orders",
  "/risk",
  "/analyst",
  "/settings",
  "/onboarding/goals",
];

test("every screen passes axe and has no horizontal page scroll; CSP uses a nonce", async ({
  page,
}, info) => {
  await signUpConnectAnd2fa(page, info);
  const res = await page.goto("/");
  const csp = res?.headers()["content-security-policy"] ?? "";
  const script = csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
  expect(script).toMatch(/'nonce-[^']+'/);
  expect(script).not.toContain("'unsafe-inline'");
  expect(csp).toContain("frame-ancestors 'none'");

  const problems: string[] = [];
  for (const route of ROUTES) {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    for (const v of result.violations.filter(
      (x) => x.impact === "serious" || x.impact === "critical",
    )) {
      problems.push(
        `${route}: ${v.id} (${v.impact ?? ""}) × ${String(v.nodes.length)} — ${v.nodes[0]?.target.join(" ") ?? ""}`,
      );
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 1) problems.push(`${route}: horizontal scroll ${String(overflow)}px`);
  }
  expect(problems).toEqual([]);
});
