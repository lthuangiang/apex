import { SESSION_COOKIE } from "@drift/shared";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";

import { ClaudeGuidePage } from "@/features/public/components/claude-guide-page";
import { mcpServerUrl } from "@/features/public/mcp-url";
import { shareMetadata } from "@/lib/share-image";

// Trang công khai "Connect DeskLabs to Claude" (MCP M6, W7). Địa chỉ server đọc từ env `MCP_PUBLIC_URL` lúc chạy (cùng
// biến với api / mcp), nên đổi tên miền chỉ cần đặt env và khởi động lại web.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("claudeGuide");
  // Tiêu đề tab, meta description và câu chữ khi chia sẻ link dùng chung một bộ; ảnh share riêng (DEC-281).
  const title = t("shareTitle");
  const description = t("shareDescription");
  return { title, description, ...shareMetadata("claude", title, description) };
}

export default async function Page() {
  return (
    <ClaudeGuidePage
      serverUrl={mcpServerUrl(process.env.MCP_PUBLIC_URL)}
      signedIn={(await cookies()).has(SESSION_COOKIE)}
    />
  );
}
