import { SESSION_COOKIE } from "@drift/shared";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";

import { OverviewPage } from "@/features/account";
import { LandingPage } from "@/features/public";

// `/`: chưa đăng nhập → Landing (UI_REVIEW mục K), đã đăng nhập → Overview. Cùng quy tắc cookie với proxy.ts.

async function signedIn(): Promise<boolean> {
  return (await cookies()).has(SESSION_COOKIE);
}

export async function generateMetadata(): Promise<Metadata> {
  if (await signedIn()) return {};
  const t = await getTranslations("landing");
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    openGraph: { title: t("metaTitle"), description: t("metaDescription"), type: "website" },
    robots: { index: true, follow: true },
  };
}

export default async function Page() {
  return (await signedIn()) ? <OverviewPage /> : <LandingPage />;
}
