import { useTranslations } from "next-intl";

import { LandingHero } from "./landing/landing-hero";
import { LandingNav } from "./landing/landing-nav";
import { LandingProof } from "./landing/landing-proof";
import { LandingSections } from "./landing/landing-sections";
import { LandingStatsStrip } from "./landing/landing-stats";
import { LandingShell, type LandingTheme } from "./landing-theme";

// Landing khi chưa đăng nhập, UI mới người dùng duyệt 2026-11-16 (docs/mockups/landing-mcp/FullPage; DEC trong PR #166):
// mặc định theme sáng, nút đổi theme, font Space Grotesk / Inter / JetBrains Mono chỉ trên landing và trang MCP. Thứ tự:
// nav · hero (Example bot) · số liệu · Analytics · Claude · Strategies · How it works · Safety · Fees · Also in the app ·
// FAQ · CTA · footer.

export function LandingPage({
  serverUrl,
  initialTheme = null,
}: {
  serverUrl: string;
  /** Theme đã chọn (cookie, đọc ở server) để không chớp sáng khi người dùng chọn tối. */
  initialTheme?: LandingTheme | null;
}) {
  const t = useTranslations("landing.nav");
  const links = [
    { href: "#strategies", label: t("strategies") },
    { href: "#analytics", label: t("lab") },
    { href: "#how", label: t("how") },
    { href: "#safety", label: t("safety") },
    { href: "#fees", label: t("fees") },
    { href: "#faq", label: t("faq") },
    { href: "#claude", label: t("claude") },
  ];
  return (
    <LandingShell initialTheme={initialTheme}>
      <div className="flex min-h-[min(980px,100vh)] flex-col">
        <LandingNav links={links} home="#top" />
        <LandingHero />
        <div className="mt-auto">
          <LandingStatsStrip />
        </div>
      </div>
      <LandingProof serverUrl={serverUrl} />
      <LandingSections />
    </LandingShell>
  );
}
