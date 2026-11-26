"use client";

import { Skeleton } from "@drift/ui";
import { notFound, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { PageHead, Workspace } from "@/components/workspace";
import { shortAddress } from "@/lib/format";
import { useFeatures } from "@/lib/queries";

import { browserZone } from "../format";
import {
  firstRewardsError,
  useRewardsFeed,
  useRewardsRetry,
  useRewardsSummary,
  useRewardsVolumeWeights,
  useRewardsWeekInfo,
  useRewardsWeekList,
} from "../queries";
import { useRewardsAuth } from "../use-rewards-auth";

import { FeedCard, MultipliersCard, WeekCard } from "./public-cards";
import { NotConnectedBanner, RewardsProblem } from "./rewards-states";
import { LockedRow, SignInHero } from "./sign-in-hero";
import { SoPointsTab } from "./sopoints-tab";

// Trang /rewards (bản phác 08–09, DEC-397, #548). Sau công tắc toàn hệ thống `sodexRewards` (`/api/v1/features`): tắt thì
// route Not found như chưa có. Trình duyệt đọc thẳng gateway SoDEX; token chỉ ở sessionStorage của tab.

/**
 * Tab có trong bản này. Blind Boxes (`?tab=boxes`) ẩn tới #550 (PM chốt): giá trị lạ hay tab chưa có đều rơi về
 * SoPoints. Chỉ còn một tab thì không vẽ thanh tab.
 */
export const REWARDS_TABS = ["sopoints"] as const;
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
  const tab = resolveRewardsTab(useSearchParams().get("tab"));
  const signedIn = auth.signedIn && auth.master !== null;

  // Một dải lỗi chung cho cả trang (429 chỉ đếm ngược ở một chỗ); thẻ thiếu dữ liệu ghi "Not available".
  const weekInfo = useRewardsWeekInfo();
  const weights = useRewardsVolumeWeights();
  const feed = useRewardsFeed(!signedIn);
  const summary = useRewardsSummary(auth);
  const weekList = useRewardsWeekList(auth);
  const problem = firstRewardsError(
    signedIn ? summary.error : null,
    signedIn ? weekList.error : null,
    weekInfo.error,
    weights.error,
    signedIn ? null : feed.error,
  );

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
      <p className="m-0 text-xs text-ink-2">{t("page.source")}</p>
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
        { sopoints: <SoPointsTab session={auth} tz={tz} /> }[tab]
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
