"use client";

import { Link2Off } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { useSodexConnection } from "@/lib/queries";

// Khối "chưa kết nối SoDEX" dùng chung cho Overview, Portfolio, Trading Agent, Execution & Orders,
// Risk Center (UI_REVIEW B4): trang vẫn giữ khung, khối này nói lý do và dẫn tới /onboarding/connect.

/** `true` khi đã đọc xong và người dùng chưa có kết nối SoDEX đang hoạt động. */
export function useSodexMissing(): boolean {
  const conn = useSodexConnection();
  return conn.isSuccess && conn.data.connection?.status !== "connected";
}

export function NotConnected({ message }: { message?: string }) {
  const t = useTranslations("common.notConnected");
  return (
    <section
      aria-labelledby="not-connected-title"
      className="flex flex-wrap items-center gap-4 rounded-card border border-border bg-surface p-5"
    >
      <span
        aria-hidden="true"
        className="flex size-11 flex-none items-center justify-center rounded-[14px] bg-accent-tint text-accent"
      >
        <Link2Off size={20} />
      </span>
      <div className="flex min-w-[220px] flex-1 flex-col gap-0.5">
        <h2 id="not-connected-title" className="m-0 text-base font-extrabold">
          {t("title")}
        </h2>
        <p className="m-0 text-sm text-ink-2">{message ?? t("body")}</p>
      </div>
      <Link
        href="/onboarding/connect"
        className="flex min-h-tap items-center rounded-[14px] bg-accent px-[18px] text-sm font-bold text-white no-underline shadow-accent"
      >
        {t("cta")}
      </Link>
    </section>
  );
}
