"use client";

import { notificationSettingsSchema } from "@drift/shared";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { TelegramChannel } from "@/features/notifications/components/telegram-channel";
import { useTelegramLink } from "@/features/notifications/telegram";
import { api } from "@/lib/api";
import { useFeatures } from "@/lib/queries";

import { StepHeading } from "./onboarding-shell";

// Bước tuỳ chọn cuối onboarding (DEC-TBD-onboarding-skip): nhận cảnh báo trên Telegram. Dùng lại thẻ Telegram và
// hộp thoại Connect của Settings › Notifications. Có Skip; server tắt Telegram thì đi thẳng tới `next`.

/** Chỉ nhận đường dẫn nội bộ (không `//host`, không `/\host`): tránh open redirect qua `?next=`. */
export function safeNext(raw: string | null): string {
  if (raw === null || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\"))
    return "/";
  return raw;
}

/** Link tới bước này, mang theo nơi người dùng định tới sau đó. */
export function alertsStepHref(next: string): string {
  return `/onboarding/alerts?next=${encodeURIComponent(next)}`;
}

export function TelegramStep() {
  const t = useTranslations("onboarding.alerts");
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const aiDesk = useFeatures().data?.aiDesk === true;
  const link = useTelegramLink(false);
  const settings = useQuery({
    queryKey: ["notifications", "settings"],
    queryFn: () => api("GET", "/api/v1/notifications/settings", notificationSettingsSchema),
  });
  const status = link.data?.status;

  // Telegram chưa bật trên server: bước này không có gì để làm.
  useEffect(() => {
    if (status === "disabled") router.replace(next);
  }, [status, next, router]);
  if (status === "disabled") return null;

  const connected = status === "active";
  return (
    <>
      <StepHeading title={t("title")} lead={t("lead")} />
      <span className="self-start rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-extrabold text-ink-2">
        {t("optional")}
      </span>
      <TelegramChannel groups={settings.data?.groups ?? []} aiDesk={aiDesk} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={next}
          className="inline-flex min-h-tap items-center text-sm font-bold text-accent no-underline"
        >
          {connected ? t("continue") : t("skip")}
        </Link>
      </div>
    </>
  );
}
