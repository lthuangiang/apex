"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { PageHead, Workspace } from "@/components/workspace";
import { useFeatures } from "@/lib/queries";

import { Recommended } from "./recommended";

// AI Desk › New bot: luồng Recommended + fake money của DEC-105 (AI_DESK_RECOMMENDED.md), mở từ "+ New bot" trên trang
// chủ B+ (BP-Home). Tắt AI Desk thì quay về Overview.

export function NewBotPage() {
  const t = useTranslations("desk");
  const router = useRouter();
  const features = useFeatures();
  useEffect(() => {
    if (features.data !== undefined && !features.data.aiDesk) router.replace("/");
  }, [features.data, router]);
  return (
    <Workspace current="desk">
      <div className="flex flex-col gap-5">
        <PageHead
          title={t("newBot.title")}
          subtitle={t("subtitle")}
          back={{ href: "/desk", label: t("newBot.back") }}
        />
        {features.data?.aiDesk === true ? <Recommended /> : null}
      </div>
    </Workspace>
  );
}
