"use client";

import { dec, notificationSettingsSchema, type NotificationGroup } from "@drift/shared";
import { Button, EmptyState, ErrorState, Skeleton, Switch } from "@drift/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useFeatures } from "@/lib/queries";

import { useFollow, useFollowing } from "../api";
import { addr, ago, base, usd } from "../format";

import { Avatar } from "./parts";
import { EventChange } from "./trader-profile-page";

// Following (artboard WhaleWatch, DEC-163 mục 11): trader đang theo dõi (≤ 5), thay đổi gần đây gộp 60 giây, độ trễ
// thật ("checked every 2 min"), cảnh báo big move chỉ trong app. Theo dõi miễn phí, không đặt lệnh.

const GROUP: NotificationGroup = "copyTrading";

function useBigMoveSetting() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["notifications", "settings"],
    queryFn: () => api("GET", "/api/v1/notifications/settings", notificationSettingsSchema),
  });
  const set = useMutation({
    mutationFn: (enabled: boolean) =>
      api("PUT", "/api/v1/notifications/settings", notificationSettingsSchema, {
        idempotencyKey: crypto.randomUUID(),
        body: { group: GROUP, channel: "in_app", enabled },
      }),
    onSuccess: (data) => {
      qc.setQueryData(["notifications", "settings"], data);
    },
  });
  const on = settings.data?.groups.find((g) => g.group === GROUP)?.in_app;
  return { on, set };
}

export function FollowingPage() {
  const t = useTranslations("copy");
  const router = useRouter();
  const features = useFeatures();
  const q = useFollowing();
  const follow = useFollow();
  const alerts = useBigMoveSetting();
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
          <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
            <div className="flex flex-col gap-5">
              <Card title={t("following.traders")}>
                <p className="m-0 -mt-2 text-sm text-ink-2">
                  {t("following.count", { n: d.traders.length, limit: d.limit })}
                </p>
                <ul className="m-0 flex list-none flex-col gap-3 p-0">
                  {d.traders.map((tr) => (
                    <li
                      key={tr.address}
                      className="flex flex-col gap-2 border-b border-border pb-3 last:border-b-0"
                    >
                      <div className="flex items-center gap-3">
                        <Avatar address={tr.address} />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <Link
                            href={`/traders/${tr.address}`}
                            className="truncate font-bold tabular-nums text-ink"
                          >
                            {tr.displayName ?? addr(tr.address)}
                          </Link>
                          <span className="text-xs text-muted">
                            {tr.lastEventAt === null
                              ? t("following.none")
                              : t("following.last", { when: ago(tr.lastEventAt) })}
                          </span>
                        </div>
                        {tr.copying ? (
                          <span className="rounded-full bg-pos-bg px-2.5 py-1 text-xs font-bold text-pos">
                            {t("following.copying")}
                          </span>
                        ) : null}
                      </div>
                      {tr.newMarkets.length === 0 ? null : (
                        <p className="m-0 text-xs text-warn">
                          {t("following.newMarkets", {
                            markets: tr.newMarkets.map(base).join(", "),
                          })}
                        </p>
                      )}
                      <Button
                        variant="secondary"
                        className="self-start"
                        disabled={follow.isPending}
                        onClick={() => {
                          follow.mutate({ address: tr.address, on: false });
                        }}
                      >
                        {t("following.unfollow")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card title={t("following.alertsTitle")}>
                <p className="m-0 text-sm text-ink-2">{t("following.alertsBody")}</p>
                {d.bigMoveAlerts ? (
                  <Switch
                    label={alerts.on === true ? t("following.on") : t("following.off")}
                    checked={alerts.on === true}
                    onCheckedChange={(enabled) => {
                      alerts.set.mutate(enabled);
                    }}
                  />
                ) : (
                  <p className="m-0 text-sm text-muted">{t("following.alertsOff")}</p>
                )}
                <p className="m-0 text-xs text-muted">{t("following.alertsWhere")}</p>
              </Card>
            </div>

            <Card title={t("following.changes")}>
              <p className="m-0 -mt-2 text-sm text-ink-2">
                {t("following.checked", {
                  time: formatDateTime(q.dataUpdatedAt),
                  minutes: Math.round(d.checkedEveryMs / 60_000),
                })}
              </p>
              {d.events.length === 0 ? (
                <EmptyState title={t("following.none")} />
              ) : (
                <div className="-mx-5 overflow-x-auto px-5">
                  <table className="w-full min-w-[640px] text-left text-sm">
                    <thead className="text-xs text-muted">
                      <tr>
                        <th className="py-2 font-semibold">{t("following.cols.when")}</th>
                        <th className="py-2 font-semibold">{t("following.cols.trader")}</th>
                        <th className="py-2 font-semibold">{t("following.cols.change")}</th>
                        <th className="py-2 font-semibold">{t("following.cols.market")}</th>
                        <th className="py-2 text-right font-semibold">
                          {t("following.cols.size")}
                        </th>
                        <th className="py-2 text-right font-semibold">
                          {t("following.cols.sodex")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.events.map((e) => {
                        const opening = e.kind === "open" || e.kind === "add" || e.kind === "flip";
                        return (
                          <tr
                            key={`${e.address}-${e.at}-${e.coin}`}
                            className="border-t border-border"
                          >
                            <td className="py-2 whitespace-nowrap tabular-nums">
                              {formatDateTime(e.at)}
                            </td>
                            <td className="py-2 tabular-nums">{addr(e.address)}</td>
                            <td className="py-2">
                              <EventChange e={e} />
                            </td>
                            <td className="py-2">{e.market === null ? e.coin : base(e.market)}</td>
                            <td
                              className={`py-2 text-right tabular-nums ${opening ? "" : "text-ink-2"}`}
                            >
                              {usd(opening ? e.notional : dec(e.notional).neg().toString(), true)}
                            </td>
                            <td className="py-2 text-right">
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
              <p className="m-0 text-xs text-muted">{t("following.grouped")}</p>
            </Card>
          </div>
        )}
      </div>
    </Workspace>
  );
}
