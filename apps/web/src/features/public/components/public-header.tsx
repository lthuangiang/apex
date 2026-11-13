import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { MobileMenu } from "./mobile-menu";

// Header của trang công khai (Landing, Risk Disclosure): logo, nav theo anchor (chỉ Landing), Sign in, Create account.
// Đã đăng nhập (chỉ gặp ở Risk Disclosure): một nút "Back to Overview" thay cho Sign in / Create account.

export function PublicHeader({
  withNav = false,
  signedIn = false,
}: {
  withNav?: boolean;
  signedIn?: boolean;
}) {
  const t = useTranslations("landing.nav");
  const tc = useTranslations("common");
  const links = ["strategies", "desk", "lab", "how", "safety", "fees", "faq"] as const;
  return (
    <header className="mx-auto flex w-full max-w-[1240px] flex-wrap items-center justify-between gap-x-3 gap-y-3 py-2 px-[clamp(20px,4vw,56px)] md:gap-x-6">
      <Link href="/" className="flex items-center gap-2 text-ink no-underline md:gap-2.5">
        <BrandMark />
        <span className="text-lg font-extrabold tracking-[-0.01em] md:text-xl">{tc("brand")}</span>
      </Link>
      {withNav ? (
        // < 768 px: chỉ còn logo + Sign in / Create account, nav anchor ẩn (UI_REVIEW K).
        <nav
          aria-label={t("label")}
          className="hidden flex-wrap items-center gap-x-6 gap-y-1 md:flex"
        >
          {links.map((k) => (
            <a
              key={k}
              href={`#${k}`}
              className="px-1 py-2.5 text-sm font-semibold text-ink-body no-underline hover:text-accent"
            >
              {t(k)}
            </a>
          ))}
        </nav>
      ) : null}
      {signedIn ? (
        <Link
          href="/"
          className="flex min-h-tap items-center gap-2 rounded-control bg-accent px-[18px] text-sm font-bold text-surface no-underline hover:brightness-95"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {t("backToOverview")}
        </Link>
      ) : (
        <div className="flex items-center gap-2 md:gap-2.5">
          <Link
            href="/signin"
            className={`min-h-tap items-center rounded-control px-4 text-sm font-bold text-ink no-underline ${withNav ? "hidden md:flex" : "flex"}`}
          >
            {t("signIn")}
          </Link>
          <Link
            href="/signup"
            className={`min-h-tap items-center rounded-control bg-accent px-4 text-sm font-bold text-surface no-underline hover:brightness-95 md:px-[18px] ${withNav ? "hidden min-[380px]:flex" : "flex"}`}
          >
            {t("createAccount")}
          </Link>
          {/* Điện thoại: link anchor và Sign in gom vào menu hamburger (DEC-148). */}
          {withNav ? (
            <MobileMenu
              links={links.map((k) => ({ href: `#${k}`, label: t(k) }))}
              signIn={t("signIn")}
              launch={t("createAccount")}
              openLabel={t("menu")}
              closeLabel={t("closeMenu")}
            />
          ) : null}
        </div>
      )}
    </header>
  );
}

export function BrandMark() {
  return (
    <span className="flex size-9 items-center justify-center rounded-control bg-accent text-surface md:size-10">
      <svg viewBox="0 0 24 24" className="size-full" aria-hidden="true">
        <path
          d="M6.5 5h5.2a7 7 0 0 1 0 14H6.5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinejoin="round"
        />
        <rect x="9.6" y="9" width="4.6" height="2" rx="1" fill="currentColor" />
        <rect x="9.6" y="13" width="3.2" height="2" rx="1" fill="currentColor" opacity="0.7" />
      </svg>
    </span>
  );
}
