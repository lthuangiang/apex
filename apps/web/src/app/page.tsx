import { SESSION_COOKIE } from "@drift/shared";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";

import { OverviewPage } from "@/features/account";
import { LandingPage } from "@/features/public";
import { SHARE_IMAGE } from "@/lib/share-image";

// `/`: chưa đăng nhập → Landing (UI_REVIEW mục K), đã đăng nhập → Overview. Cùng quy tắc cookie với proxy.ts.

async function signedIn(): Promise<boolean> {
  return (await cookies()).has(SESSION_COOKIE);
}

export async function generateMetadata(): Promise<Metadata> {
  if (await signedIn()) return {};
  const t = await getTranslations("landing");
  const brand = (await getTranslations("common"))("brand");
  const title = t("metaTitle", { brand });
  return {
    title,
    description: t("metaDescription"),
    openGraph: {
      title,
      description: t("metaDescription"),
      type: "website",
      siteName: "DeskLabs",
      images: [SHARE_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: t("metaDescription"),
      images: [SHARE_IMAGE],
    },
    robots: { index: true, follow: true },
  };
}

export default async function Page() {
  return (await signedIn()) ? <OverviewPage /> : <LandingPage />;
}
