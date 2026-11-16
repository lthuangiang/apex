import { SESSION_COOKIE } from "@drift/shared";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";

import { ClaudeGuidePage } from "@/features/public/components/claude-guide-page";
import { LANDING_THEME_COOKIE, themeFromCookie } from "@/features/public/landing-theme-cookie";
import { mcpServerUrl } from "@/features/public/mcp-url";

// Trang công khai "Connect DeskLabs to Claude" (MCP M6, W7). Địa chỉ server đọc từ env `MCP_PUBLIC_URL` lúc chạy (cùng
// biến với api / mcp), nên đổi tên miền chỉ cần đặt env và khởi động lại web.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("claudeGuide");
  return { title: t("metaTitle"), description: t("metaDescription") };
}

export default async function Page() {
  const jar = await cookies();
  // Theme người xem đã chọn ở landing / trang này (cookie) để vẽ đúng ngay lần đầu, không chớp sáng.
  return (
    <ClaudeGuidePage
      serverUrl={mcpServerUrl(process.env.MCP_PUBLIC_URL)}
      signedIn={jar.has(SESSION_COOKIE)}
      initialTheme={themeFromCookie(jar.get(LANDING_THEME_COOKIE)?.value)}
    />
  );
}
