"use client";

import { UserRole } from "@drift/shared";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { PageHead } from "@/components/workspace";
import { WorkspaceShell } from "@/components/workspace-shell";
import { useMe } from "@/lib/queries";

import { NotificationsTab } from "./notifications-tab";
import { ProfileTab, TradingDefaultsTab } from "./profile-tabs";
import { SecurityTab } from "./security-tab";
import { SodexAccessTab } from "./sodex-access-tab";

// Các tab: SoDEX access · Security · Notifications · Trading defaults · Profile (SCREENS.md mục 8.5).
const TABS = ["access", "security", "notifications", "defaults", "profile"] as const;

export function SettingsPage() {
  const t = useTranslations("settings");
  const me = useMe();
  // `?tab=notifications` từ nút chuông ở hàng tiêu đề.
  const initial = useSearchParams().get("tab");
  const [tab, setTab] = useState<(typeof TABS)[number]>(
    TABS.find((k) => k === initial) ?? "access",
  );

  return (
    <WorkspaceShell current="settings" isTeam={me.data?.role === UserRole.team}>
      <div className="flex flex-col gap-5">
        <PageHead title={t("title")} subtitle={t("subtitle")} />
        <div
          role="tablist"
          aria-label={t("tabs.label")}
          className="flex gap-1 self-start overflow-x-auto rounded-tile border border-border bg-surface p-1 max-w-full"
        >
          {TABS.map((key) => (
            <button
              key={key}
              id={`tab-${key}`}
              type="button"
              role="tab"
              aria-selected={tab === key}
              aria-controls={`panel-${key}`}
              onClick={() => {
                setTab(key);
              }}
              className={`min-h-10 flex-none rounded-control px-3.5 text-sm font-bold whitespace-nowrap ${tab === key ? "bg-ink text-surface" : "text-ink-2"}`}
            >
              {t(`tabs.${key}`)}
            </button>
          ))}
        </div>
        <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === "access" ? (
            <SodexAccessTab />
          ) : tab === "security" ? (
            <SecurityTab />
          ) : tab === "notifications" ? (
            <NotificationsTab />
          ) : tab === "defaults" ? (
            <TradingDefaultsTab />
          ) : (
            <ProfileTab />
          )}
        </div>
      </div>
    </WorkspaceShell>
  );
}
