import Link from "next/link";
import { useTranslations } from "next-intl";

// Footer của các trang công khai dùng giao diện app (Risk Disclosure, 404). Landing và trang MCP có footer riêng theo UI
// mới (landing/landing-sections.tsx).

export function PublicFooter() {
  const t = useTranslations("landing.footer");
  const tc = useTranslations("common");
  return (
    <footer className="mx-auto box-border flex w-full max-w-[1240px] flex-wrap items-start justify-between gap-x-8 gap-y-4 px-[clamp(20px,4vw,56px)] pt-4 pb-6 text-[13px] text-ink-2">
      <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-2">
        <span className="text-[15px] font-extrabold text-ink">{tc("brand")}</span>
        <p className="m-0 leading-relaxed font-semibold text-ink-body">{t("built")}</p>
        <p className="m-0 leading-relaxed">{t("disclaimer")}</p>
      </div>
      <nav aria-label={t("legalLabel")} className="flex flex-wrap gap-x-5">
        <Link
          href="/risk-disclosure"
          className="inline-flex min-h-tap items-center font-bold text-accent no-underline"
        >
          {t("risk")}
        </Link>
        <Link
          href="/claude"
          className="inline-flex min-h-tap items-center font-bold text-accent no-underline"
        >
          {t("claude")}
        </Link>
      </nav>
    </footer>
  );
}
