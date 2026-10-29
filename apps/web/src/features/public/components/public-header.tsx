import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

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
  const links = ["how", "strategies", "safety", "fees", "faq"] as const;
  return (
    <header className="mx-auto flex w-full max-w-[1240px] flex-wrap items-center justify-between gap-x-3 gap-y-3 p-2 md:gap-x-6">
      <Link href="/" className="flex items-center gap-2.5 text-ink no-underline">
        <BrandMark />
        <span className="text-xl font-extrabold tracking-[0.06em]">{tc("brand")}</span>
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
        <div className="flex items-center gap-2.5">
          <Link
            href="/signin"
            className="flex min-h-tap items-center rounded-control px-4 text-sm font-bold text-ink no-underline"
          >
            {t("signIn")}
          </Link>
          <Link
            href="/signup"
            className="flex min-h-tap items-center rounded-control bg-accent px-[18px] text-sm font-bold text-surface no-underline hover:brightness-95"
          >
            {t("createAccount")}
          </Link>
        </div>
      )}
    </header>
  );
}

export function BrandMark() {
  return (
    <span className="flex size-10 items-center justify-center rounded-control bg-accent text-surface">
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 15c3-6 6 2 9-3s5-5 7-4" />
        <path d="M4 20h16" />
      </svg>
    </span>
  );
}
