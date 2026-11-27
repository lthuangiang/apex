"use client";

import { Skeleton } from "@drift/ui";
import { ChevronDown } from "lucide-react";
import { notFound, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { PageHead, Workspace } from "@/components/workspace";
import { shortAddress } from "@/lib/format";
import { useFeatures } from "@/lib/queries";

import { browserZone, formatDay } from "../format";
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
import { rewardsExpiryMs } from "../token-exp";
import { useRewardsAuth } from "../use-rewards-auth";
import { useDisableRewardsWatch, useRewardsWatch } from "../watch";

import { ActionHost } from "./action-popup";
import { BoxesTab } from "./boxes-tab";
import { FeedCard, MultipliersCard, WeekCard } from "./public-cards";
import { ReceivedPopup } from "./received-popup";
import { NotConnectedBanner, RewardsProblem } from "./rewards-states";
import { LockedRow, SignInHero } from "./sign-in-hero";
import { SoPointsTab } from "./sopoints-tab";
import { RewardsWatchStrip } from "./watch-ui";

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
  // #558 (DEC-398): "Sign out of rewards" xoá luôn phiên lưu ở server (nếu có).
  const watch = useRewardsWatch();
  const disableWatch = useDisableRewardsWatch();
  const signOut = () => {
    auth.signOut();
    if (watch.data != null && watch.data.status !== "off") disableWatch.mutate();
  };

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
            <AccountChip master={auth.master} tz={tz} onSignOut={signOut} />
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
          <RewardsWatchStrip master={auth.master} signedIn={false} />
          <SignInHero auth={auth} />
          <LockedRow />
          <PublicGrid tz={tz} />
        </>
      ) : (
        <>
          <RewardsWatchStrip master={auth.master} signedIn />
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
              <SoPointsTab
                session={auth}
                tz={tz}
                onOpenBoxes={() => {
                  setTab("boxes");
                  window.history.replaceState(null, "", "?tab=boxes");
                }}
              />
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

/**
 * Chip tài khoản rewards ở hàng tiêu đề (bản phác polish 03, truyền vào `action` của PageHead): chấm xanh + ví rút gọn;
 * bấm mở menu "Rewards sign-in" · "Signed in as …" · "Expires {date}" (claim `exp` của JWT, đọc tại trình duyệt, không gửi
 * đi; không có thì bỏ dòng) · "Sign out of rewards". Mở thì đưa focus vào nút Sign out; Esc đóng và trả focus về chip;
 * bấm ra ngoài thì đóng.
 */
export function AccountChip({
  master,
  tz,
  onSignOut,
}: {
  master: string;
  tz: string;
  onSignOut: () => void;
}) {
  const t = useTranslations("rewards");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const exp = open ? rewardsExpiryMs(master) : null;
  const expText = exp === null ? null : formatDay(exp, tz);
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="inline-flex min-h-tap items-center gap-2 rounded-full border border-border bg-surface px-3 text-[13px] font-bold text-ink tabular-nums hover:bg-surface-2 lg:min-h-8"
      >
        <span
          aria-hidden="true"
          className="size-2 rounded-full bg-pos-dot ring-[3px] ring-pos-bg"
        />
        <span className="sr-only">{t("account.title")}: </span>
        {shortAddress(master)}
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      <div
        id={menuId}
        hidden={!open}
        className="absolute top-full left-0 z-50 mt-2 w-64 max-w-[calc(100vw-32px)] flex-col rounded-tile border border-border bg-surface p-1.5 text-sm shadow-lg lg:right-0 lg:left-auto [&:not([hidden])]:flex"
      >
        <div className="flex flex-col gap-0.5 border-b border-border px-3 pt-2 pb-2.5">
          <span className="text-xs text-ink-2">{t("account.title")}</span>
          <b className="tabular-nums">{t("signedInAs", { address: shortAddress(master) })}</b>
          {expText === null ? null : (
            <span className="text-xs text-ink-2 tabular-nums">
              {t("account.expires", { date: expText })}
            </span>
          )}
        </div>
        <button
          ref={first}
          type="button"
          onClick={() => {
            setOpen(false);
            onSignOut();
          }}
          className="mt-1 flex min-h-tap items-center rounded-control px-3 text-left font-bold text-neg-ink hover:bg-surface-2"
        >
          {t("signOut")}
        </button>
      </div>
    </div>
  );
}
