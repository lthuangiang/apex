import { SESSION_COOKIE } from "@drift/shared";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";

import { RiskDisclosurePage } from "@/features/public";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("riskDisclosure");
  return { title: t("metaTitle") };
}

export default async function Page() {
  // Mở cho cả hai trạng thái (DEC-69); chỉ header đổi theo phiên.
  return <RiskDisclosurePage signedIn={(await cookies()).has(SESSION_COOKIE)} />;
}
