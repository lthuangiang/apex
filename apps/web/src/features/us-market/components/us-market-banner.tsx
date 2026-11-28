"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

// Banner ở Strategy Lab mở trang US Market (bản phác màn 01, DEC-402 mục 1). Hai tab Strategy Lab giữ nguyên; không logo.
// Strategy Lab chỉ render khi `/features.usMarket` bật (mục 9).

export function UsMarketBanner() {
  const t = useTranslations("usMarket.banner");
  return (
    <section
      aria-labelledby="us-market-banner"
      className="flex flex-wrap items-center justify-between gap-5 rounded-card bg-ink px-[26px] py-[22px] text-surface"
    >
      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="rounded-full bg-pos-bg px-[7px] py-0.5 text-[10px] font-extrabold tracking-[0.04em] text-pos">
            {t("new")}
          </span>
          <h2 id="us-market-banner" className="m-0 text-[19px] font-extrabold">
            {t("title")}
          </h2>
        </div>
        <p className="m-0 text-[13.5px] text-on-ink-2">{t("body")}</p>
      </div>
      <Link
        href="/markets/us"
        className="inline-flex min-h-tap items-center justify-center whitespace-nowrap rounded-control bg-accent px-4 text-sm font-extrabold text-white no-underline"
      >
        {t("cta")}
      </Link>
    </section>
  );
}
