"use client";

import { ComingSoonChip } from "@drift/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { useFeatures } from "@/lib/queries";

import { Recommended } from "./recommended";
import { YourBots } from "./your-bots";

// AI Desk (AI_DESK.md, DEC-105): Recommended · Your bots · Ask AI (chưa làm: "Coming soon"). Chỉ hiện khi team bật cho
// tài khoản; tắt thì quay về Overview.

const TABS = ["recommended", "bots", "ask"] as const;
type Tab = (typeof TABS)[number];

export function DeskPage() {
  const t = useTranslations("desk");
  const router = useRouter();
  const params = useSearchParams();
  const features = useFeatures();
  const raw = params.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? "") ? (raw as Tab) : "recommended";
  useEffect(() => {
    if (features.data !== undefined && !features.data.aiDesk) router.replace("/");
  }, [features.data, router]);

  return (
    <Workspace current="desk">
      <div className="flex flex-col gap-5">
        <PageHead title={t("title")} subtitle={t("subtitle")} />
        <div
          role="tablist"
          aria-label={t("tabs.label")}
          className="flex w-full gap-1 overflow-x-auto rounded-[16px] border border-border bg-surface p-1 sm:w-auto sm:self-start"
        >
          {TABS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => {
                router.replace(k === "recommended" ? "/desk" : `/desk?tab=${k}`);
              }}
              className={`flex min-h-tap flex-1 items-center justify-center gap-2 rounded-[12px] px-4 text-sm font-bold whitespace-nowrap sm:flex-none ${
                tab === k ? "bg-ink text-white" : "text-ink-2 hover:bg-surface-2"
              }`}
            >
              {t(`tabs.${k}`)}
              {k === "ask" ? (
                <span className="hidden sm:inline-flex">
                  <ComingSoonChip label={t("ask.soon")} />
                </span>
              ) : null}
            </button>
          ))}
        </div>
        {features.data?.aiDesk !== true ? null : tab === "recommended" ? (
          <Recommended />
        ) : tab === "bots" ? (
          <YourBots />
        ) : (
          <Card title={t("ask.title")}>
            <div className="flex flex-wrap items-center gap-2">
              <ComingSoonChip label={t("ask.soon")} />
            </div>
            <p className="m-0 text-sm text-ink-2">{t("ask.body")}</p>
          </Card>
        )}
      </div>
    </Workspace>
  );
}
