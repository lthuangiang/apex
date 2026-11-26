"use client";

import { Skeleton } from "@drift/ui";
import { notFound, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { PageHead, Workspace } from "@/components/workspace";
import { shortAddress } from "@/lib/format";
import { useFeatures } from "@/lib/queries";

import { browserZone } from "../format";
import { REWARDS_RULES_URL } from "../links";
import {
  firstRewardsError,
  useRewardsFeed,
  useRewardsRetry,
  useRewardsSummary,
  useRewardsTreasures,
  useRewardsVolumeWeights,
  useRewardsWeekInfo,
  useRewardsWeekList,
} from "../queries";
import { useRewardsAuth } from "../use-rewards-auth";

import { ActionHost } from "./action-popup";
import { BoxesTab } from "./boxes-tab";
import { FeedCard, MultipliersCard, WeekCard } from "./public-cards";
import { ReceivedPopup } from "./received-popup";
import { NotConnectedBanner, RewardsProblem } from "./rewards-states";
import { LockedRow, SignInHero } from "./sign-in-hero";
import { SoPointsTab } from "./sopoints-tab";

// Trang /rewards (bản phác 08–14, DEC-397, #548, #550). Sau công tắc toàn hệ thống `sodexRewards` (`/api/v1/features`): tắt thì
// route Not found như chưa có. Trình duyệt đọc thẳng gateway SoDEX; token chỉ ở sessionStorage của tab.

/** Tab của trang: SoPoints và Blind Boxes (#550). `?tab=` lạ rơi về SoPoints. */
export const REWARDS_TABS = ["sopoints", "boxes"] as const;
export type RewardsTab = (typeof REWARDS_TABS)[number];

export function resolveRewardsTab(param: string | null): RewardsTab {
  return REWARDS_TABS.find((t) => t === param) ?? "sopoints";
}

export function RewardsPage() {
  const features = useFeatures();
  if (features.data !== undefined && !features.data.sodexRewards) notFound();
  return (
    <Workspace current="rewards">
      {features.data?.sodexRewards === true ? (
        <RewardsContent />
      ) : (
        <Skeleton className="h-40 rounded-card" />
      )}
    </Workspace>
  );
}

/** Múi giờ trình duyệt (bảng tuần ghi rõ múi giờ); render đầu tiên dùng UTC để server và client khớp nhau. */
function useBrowserZone(): string {
  const [tz, setTz] = useState("UTC");
  useEffect(() => {
    setTz(browserZone());
  }, []);
  return tz;
}

function RewardsContent() {
  const t = useTranslations("rewards");
  const auth = useRewardsAuth();
  const tz = useBrowserZone();
  const retry = useRewardsRetry();
  const param = useSearchParams().get("tab");
  const [tab, setTab] = useState<RewardsTab>(() => resolveRewardsTab(param));
  useEffect(() => {
    setTab(resolveRewardsTab(param));
  }, [param]);
  const treasures = useRewardsTreasures(auth);
  const signedIn = auth.signedIn && auth.master !== null;

  // Một dải lỗi chung cho cả trang (429 chỉ đếm ngược ở một chỗ); thẻ thiếu dữ liệu ghi "Not available".
  const weekInfo = useRewardsWeekInfo();
  const weights = useRewardsVolumeWeights();
  const feed = useRewardsFeed(!signedIn);
  const summary = useRewardsSummary(auth);
  const weekList = useRewardsWeekList(auth);
  // Tab Blind Boxes có dải lỗi riêng cho dữ liệu của nó.
  const onSopoints = !signedIn || tab === "sopoints";
  const problem = onSopoints
    ? firstRewardsError(
        signedIn ? summary.error : null,
        signedIn ? weekList.error : null,
        weekInfo.error,
        weights.error,
        signedIn ? null : feed.error,
      )
    : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHead
        title={t("page.title")}
        subtitle={t("page.subtitle")}
        action={
          signedIn && auth.master !== null ? (
            <SignedChips master={auth.master} onSignOut={auth.signOut} />
          ) : undefined
        }
      />
      <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
        <span>{t("page.source")}</span>
        <a
          href={REWARDS_RULES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-bold text-accent-ink no-underline"
        >
          {t("page.rules")}
        </a>
      </p>
      {problem === null ? null : <RewardsProblem error={problem} onRetry={retry} />}
      {auth.sodexLoading ? (
        <Skeleton className="h-56 rounded-hero" />
      ) : auth.master === null ? (
        <>
          <NotConnectedBanner />
          <PublicGrid tz={tz} />
        </>
      ) : !signedIn ? (
        <>
          <SignInHero auth={auth} />
          <LockedRow />
          <PublicGrid tz={tz} />
        </>
      ) : (
        <>
          <div
            role="tablist"
            aria-label={t("tabs.label")}
            className="flex gap-1 self-start rounded-[14px] border border-border bg-surface p-1"
          >
            {REWARDS_TABS.map((key) => (
              <button
                key={key}
                id={`rewards-tab-${key}`}
                type="button"
                role="tab"
                aria-selected={tab === key}
                aria-controls="rewards-panel"
                onClick={() => {
                  setTab(key);
                  // Giữ `?tab=` để tải lại / chia sẻ link mở đúng tab; không thêm lịch sử.
                  window.history.replaceState(null, "", `?tab=${key}`);
                }}
                className={`flex min-h-tap items-center gap-1.5 rounded-[10px] px-4 text-[15px] font-bold ${tab === key ? "bg-surface-2 text-ink shadow-sm" : "text-ink-2"}`}
              >
                {t(`tabs.${key}`)}
                {key === "boxes" && (treasures.data?.total ?? 0) > 0 ? (
                  <span className="rounded-full bg-accent px-[7px] py-px text-[11px] text-white tabular-nums">
                    {treasures.data?.total}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          {/* Popup Claim / Open / Merge và theo dõi job khi popup đóng (#551). */}
          <ActionHost auth={auth} />
          {/* Box mới nhận / vé trúng (#556), xếp hàng sau popup thao tác. */}
          <ReceivedPopup session={auth} />
          <div id="rewards-panel" role="tabpanel" aria-labelledby={`rewards-tab-${tab}`}>
            {tab === "sopoints" ? (
              <SoPointsTab session={auth} tz={tz} />
            ) : (
              <BoxesTab session={auth} tz={tz} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function PublicGrid({ tz }: { tz: string }) {
  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-3">
      <WeekCard tz={tz} />
      <MultipliersCard tz={tz} />
      <FeedCard tz={tz} />
    </div>
  );
}

/** "Signed in as 0x3f2a…9c4e" + "Sign out of rewards" ở hàng tiêu đề (bản phác 09). */
function SignedChips({ master, onSignOut }: { master: string; onSignOut: () => void }) {
  const t = useTranslations("rewards");
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className="inline-flex h-8 items-center gap-2 rounded-full border border-border bg-surface px-3 text-[13px] font-semibold text-ink-2 tabular-nums">
        <span
          aria-hidden="true"
          className="size-2 rounded-full bg-pos-dot ring-[3px] ring-pos-bg"
        />
        {t("signedInAs", { address: shortAddress(master) })}
      </span>
      <button
        type="button"
        onClick={onSignOut}
        className="inline-flex min-h-tap items-center rounded-full border border-border bg-surface px-3 text-[13px] font-semibold text-ink-2 hover:bg-surface-2 lg:min-h-8"
      >
        {t("signOut")}
      </button>
    </div>
  );
}
