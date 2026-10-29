import Link from "next/link";
import { useTranslations } from "next-intl";

import { PublicHeader } from "./public-header";

// Trang 404 dùng khung DRIFT thay cho trang mặc định của Next.js (UI_REVIEW J8).
export function NotFoundPage({ signedIn }: { signedIn: boolean }) {
  const t = useTranslations("notFound");
  return (
    <div className="flex min-h-screen flex-col gap-5 bg-bg p-4 md:p-5">
      <PublicHeader signedIn={signedIn} />
      <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col items-center justify-center gap-4 text-center">
        <p className="m-0 text-xs font-extrabold tracking-[0.08em] text-muted">404</p>
        <h1 className="m-0 text-[28px] font-extrabold">{t("title")}</h1>
        <Link
          href="/"
          className="flex min-h-tap items-center rounded-[14px] bg-accent px-[18px] text-sm font-bold text-white no-underline shadow-accent"
        >
          {signedIn ? t("backOverview") : t("backHome")}
        </Link>
      </main>
    </div>
  );
}
