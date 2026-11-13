"use client";

import { dec, type LeaderEventView } from "@drift/shared";
import { EmptyState, ErrorState, Skeleton } from "@drift/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { PageHead, Workspace } from "@/components/workspace";
import { useFeatures } from "@/lib/queries";

import { useFollow, useFollowing } from "../api";
import { addr, ago, base, usd } from "../format";

import { FollowAlertSelect } from "./follow-alert-select";
import { Avatar } from "./parts";
import { EventChange } from "./trader-profile-page";

// Following (artboard WhaleWatch, DEC-163 mục 11): trader đang theo dõi (≤ 5), thay đổi gần đây gộp 60 giây, độ trễ
// thật ("checked every 2 min"), cảnh báo big move chỉ trong app. Theo dõi miễn phí, không đặt lệnh.

/** Chip "Change" theo artboard WhaleWatch: mở / tăng long xanh, mở / tăng short đỏ, giảm / đóng xám. */
function changeChip(e: LeaderEventView): string {
  const opening = e.kind === "open" || e.kind === "add" || e.kind === "flip";
  if (!opening) return "bg-cat-exec-bg text-ink-2";
  return e.side === "short" ? "bg-neg-bg text-neg-ink" : "bg-pos-bg text-pos";
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Giờ ngắn: hôm nay "13:58", ngày khác "Nov 12, 13:58" (giờ máy người xem). */
function shortWhen(at: string | number): string {
  const d = new Date(at);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${hm}`;
}
const formatTime = (at: number) => {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export function FollowingPage() {
  const t = useTranslations("copy");
  const router = useRouter();
  const features = useFeatures();
  const q = useFollowing();
  const follow = useFollow();
  useEffect(() => {
    if (features.data !== undefined && !features.data.aiDesk) router.replace("/");
  }, [features.data, router]);
  const d = q.data;

  return (
    <Workspace current="following">
      <div className="flex flex-col gap-5">
        <PageHead
          title={t("following.title")}
          subtitle={t("following.subtitle")}
          action={
            <Link
              href="/traders"
              className="inline-flex min-h-tap items-center justify-center rounded-control bg-accent px-4 text-sm font-bold text-white"
            >
              {t("following.find")}
            </Link>
          }
        />
        {q.isPending ? (
          <Skeleton className="h-96 rounded-card" />
        ) : q.isError ? (
          <ErrorState
            title={t("common.loadError")}
            retryLabel={t("common.retry")}
            onRetry={() => {
              void q.refetch();
            }}
          />
        ) : d === undefined || d.traders.length === 0 ? (
          <EmptyState
            title={t("following.empty")}
            description={t("following.emptyBody")}
            action={
              <Link href="/traders" className="font-bold text-accent">
                {t("following.find")}
              </Link>
            }
          />
        ) : (
          <div className="flex flex-col gap-5">
            {/* Artboard WhaleWatch: hàng trên Traders (trái) + Recent changes (phải); hàng dưới cảnh báo big move. */}
            <div className="grid gap-5 xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)] xl:items-start">
              <section
                aria-labelledby="fl-traders"
                className="flex flex-col gap-3 rounded-card border border-border bg-surface p-5"
              >
                <div className="flex items-center justify-between gap-3">
                  <h2 id="fl-traders" className="m-0 text-[17px] font-extrabold">
                    {t("following.traders")}
                  </h2>
                  <span className="text-[12.5px] font-bold text-ink-2 tabular-nums">
                    {t("following.count", { n: d.traders.length, limit: d.limit })}
                  </span>
                </div>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {d.traders.map((tr) => (
                    <li
                      key={tr.address}
                      className={`flex flex-col gap-1.5 rounded-[14px] px-3 py-2.5 ${
                        tr.copying
                          ? "border-[1.5px] border-accent bg-accent-tint"
                          : "border border-border"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <Avatar address={tr.address} size="sm" />
                        <Link
                          href={`/traders/${tr.address}`}
                          className="flex min-w-0 flex-1 flex-col text-ink no-underline"
                        >
                          <strong className="truncate text-sm tabular-nums">
                            {tr.displayName ?? addr(tr.address)}
                          </strong>
                          <span className="text-xs text-muted">
                            {tr.lastEventAt === null
                              ? t("following.none")
                              : t("following.last", { when: ago(tr.lastEventAt) })}
                          </span>
                        </Link>
                        {tr.copying ? (
                          <span className="inline-flex h-6 items-center rounded-full bg-pos-bg px-2 text-[11.5px] font-extrabold text-pos">
                            {t("following.copying")}
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={follow.isPending}
                            onClick={() => {
                              follow.mutate({ address: tr.address, on: false });
                            }}
                            className="min-h-9 rounded-[10px] px-2.5 text-xs font-bold text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-60"
                          >
                            {t("following.unfollow")}
                          </button>
                        )}
                      </div>
                      {tr.newMarkets.length === 0 ? null : (
                        <p className="m-0 pl-12 text-xs text-warn">
                          {t("following.newMarkets", {
                            markets: tr.newMarkets.map(base).join(", "),
                          })}
                        </p>
                      )}
                      {/* Mức cảnh báo riêng cho trader này (DEC-209). */}
                      <div className="pl-12">
                        <FollowAlertSelect
                          address={tr.address}
                          trader={tr.displayName ?? addr(tr.address)}
                          level={tr.alertLevel}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              <section
                aria-labelledby="fl-changes"
                className="flex min-w-0 flex-col gap-2.5 rounded-card border border-border bg-surface px-2 pt-5 pb-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2.5 px-3.5">
                  <h2 id="fl-changes" className="m-0 text-[17px] font-extrabold">
                    {t("following.changes")}
                  </h2>
                  <span className="text-[12.5px] font-semibold text-ink-2 tabular-nums">
                    {t("following.checked", {
                      time: formatTime(q.dataUpdatedAt),
                      minutes: Math.round(d.checkedEveryMs / 60_000),
                    })}
                  </span>
                </div>
                {d.events.length === 0 ? (
                  <EmptyState title={t("following.none")} />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-left text-sm tabular-nums">
                      <thead>
                        <tr className="text-xs font-bold text-ink-2">
                          {(["when", "trader", "change", "market"] as const).map((c) => (
                            <th
                              key={c}
                              className="border-b border-border px-3.5 py-2.5 font-bold whitespace-nowrap"
                            >
                              {t(`following.cols.${c}`)}
                            </th>
                          ))}
                          <th className="border-b border-border px-3.5 py-2.5 text-right font-bold whitespace-nowrap">
                            {t("following.cols.size")}
                          </th>
                          <th className="border-b border-border px-3.5 py-2.5 font-bold whitespace-nowrap">
                            {t("following.cols.sodex")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.events.map((e) => {
                          const opening =
                            e.kind === "open" || e.kind === "add" || e.kind === "flip";
                          return (
                            <tr key={`${e.address}-${e.at}-${e.coin}`}>
                              <td className="border-b border-surface-2 px-3.5 py-3 whitespace-nowrap text-ink-2">
                                {shortWhen(e.at)}
                              </td>
                              <td className="border-b border-surface-2 px-3.5 py-3 font-bold whitespace-nowrap">
                                {addr(e.address)}
                              </td>
                              <td className="border-b border-surface-2 px-3.5 py-3 whitespace-nowrap">
                                <span
                                  className={`inline-flex h-[26px] items-center rounded-full px-2.5 text-xs font-extrabold ${changeChip(e)}`}
                                >
                                  <EventChange e={e} plain />
                                </span>
                              </td>
                              <td className="border-b border-surface-2 px-3.5 py-3 font-bold whitespace-nowrap">
                                {e.market === null ? e.coin : base(e.market)}
                              </td>
                              <td
                                className={`border-b border-surface-2 px-3.5 py-3 text-right whitespace-nowrap ${opening ? "" : "text-ink-2"}`}
                              >
                                {usd(opening ? e.notional : dec(e.notional).neg().toString(), true)}
                              </td>
                              <td className="border-b border-surface-2 px-3.5 py-3 font-bold whitespace-nowrap">
                                {e.market === null ? (
                                  <span className="text-muted">{t("following.notListed")}</span>
                                ) : (
                                  <span className="text-pos">{t("following.listed")}</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="m-0 px-3.5 text-xs text-muted">{t("following.grouped")}</p>
              </section>
            </div>

            <section
              aria-labelledby="fl-alerts"
              className="flex flex-col gap-3.5 rounded-card border border-border bg-surface px-[22px] py-5"
            >
              {/* Công tắc chung đã bỏ: mỗi trader có ô chọn mức riêng (DEC-209). Khối này chỉ giải
                  thích ngưỡng big move (số thật từ config) và cách nhận trên Telegram. */}
              <div className="flex flex-col gap-1">
                <h2 id="fl-alerts" className="m-0 text-[17px] font-extrabold">
                  {t("following.alertsTitle")}
                </h2>
                <p className="m-0 text-[13.5px] leading-normal text-ink-2">
                  {d.bigMoveMinUsd === null
                    ? t("following.alertsBody")
                    : t("following.alertsBodyAt", {
                        threshold: usd(d.bigMoveMinUsd) ?? d.bigMoveMinUsd,
                      })}
                </p>
                <p className="m-0 text-[13.5px] leading-normal text-ink-2">
                  {t("followAlerts.explain")}
                </p>
              </div>
              {d.bigMoveAlerts ? null : (
                <p className="m-0 text-sm text-muted">{t("following.alertsOff")}</p>
              )}
              {/* Cảnh báo follow đi Telegram khi user bật nhóm Copy Trading ở Settings (DEC-170 mục 5). */}
              <p className="m-0 text-xs text-muted">
                {t.rich("following.alertsWhere", {
                  link: (chunks) => (
                    <Link
                      href="/settings?tab=notifications"
                      className="font-semibold text-accent-ink underline"
                    >
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
            </section>
          </div>
        )}
      </div>
    </Workspace>
  );
}
