import { SESSION_COOKIE } from "@drift/shared";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";

import { OverviewPage } from "@/features/account";
import { LandingPage } from "@/features/public/components/landing-page";
import { LANDING_THEME_COOKIE, themeFromCookie } from "@/features/public/landing-theme-cookie";
import { mcpServerUrl } from "@/features/public/mcp-url";
import { shareMetadata } from "@/lib/share-image";

// `/`: chưa đăng nhập → Landing (UI_REVIEW mục K), đã đăng nhập → Overview. Cùng quy tắc cookie với proxy.ts.

async function signedIn(): Promise<boolean> {
  return (await cookies()).has(SESSION_COOKIE);
}

export async function generateMetadata(): Promise<Metadata> {
  if (await signedIn()) return {};
  const t = await getTranslations("landing");
  const brand = (await getTranslations("common"))("brand");
  // Tiêu đề tab, meta description và câu chữ khi chia sẻ link dùng chung một bộ (DEC-TBD-share-images).
  const title = t("shareTitle", { brand });
  const description = t("shareDescription");
  return {
    title,
    description,
    ...shareMetadata("landing", title, description),
    robots: { index: true, follow: true },
  };
}

export default async function Page() {
  // Địa chỉ server MCP cho khối Claude trên landing: cùng env `MCP_PUBLIC_URL` với trang /claude.
  if (await signedIn()) return <OverviewPage />;
  // Theme người xem đã chọn (cookie) để vẽ đúng ngay lần đầu, không chớp sáng.
  const theme = themeFromCookie((await cookies()).get(LANDING_THEME_COOKIE)?.value);
  return <LandingPage serverUrl={mcpServerUrl(process.env.MCP_PUBLIC_URL)} initialTheme={theme} />;
}
