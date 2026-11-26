"use client";

import type { RewardsWatchState } from "@drift/shared";
import { Button, Switch } from "@drift/ui";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { shortAddress } from "@/lib/format";

import { browserZone, formatDayTime } from "../format";
import {
  enableErrorKind,
  useDisableRewardsWatch,
  useEnableRewardsWatch,
  useRewardsWatch,
} from "../watch";

import { Banner } from "./rewards-states";

// Giao diện báo box mới SoDEX rewards (#558, DEC-398; bản phác docs/mockups/rewards/server-token/, người dùng duyệt,
// câu chữ PM duyệt). Mọi trạng thái công tắc lấy từ `GET /api/v1/rewards/watch` (quy tắc 6): chuyển tiếp "Turning on…" /
// "Turning off…" giữ tới khi backend trả lời. Tính năng tắt ở server (404) thì không render gì.

/** Lỗi bật sau khi ký (khối ký đã unmount khi lỗi về): giữ trong cache để dải trạng thái hiện. */
export const REWARDS_WATCH_ERROR_KEY = ["rewards", "watch", "enableError"] as const;
type EnableError = ReturnType<typeof enableErrorKind>;

function dateOf(iso: string | null): string {
  if (iso === null) return "";
  return formatDayTime(Date.parse(iso), browserZone()) ?? "";
}

/** Khối đồng ý trên màn ký (bản phác 01 / 02): công tắc bật sẵn, câu đồng ý ngay trên nút ký. */
export function WatchConsent({ keep, onKeep }: { keep: boolean; onKeep: (keep: boolean) => void }) {
  const t = useTranslations("rewards.watch");
  return (
    <div
      className={`flex w-full flex-col gap-2 rounded-tile border px-3.5 py-3 ${keep ? "border-accent/30 bg-accent-tint" : "border-border bg-surface-2"}`}
    >
      <Switch label={t("toggle")} checked={keep} onCheckedChange={onKeep} />
      <p className="m-0 text-[13px] leading-normal text-ink-2">
        {keep ? t("consentOn") : t("consentOff")}
      </p>
    </div>
  );
}

/** Giá trị hàng "Sent to DeskLabs servers" của bảng "This sign-in" theo công tắc. */
export function ServersValue({ keep }: { keep: boolean }) {
  const t = useTranslations("rewards");
  if (!keep) return <span className="font-bold text-neg-ink">{t("thisSignIn.no")}</span>;
  return (
    <span className="flex flex-col items-end gap-0.5 text-right">
      <b className="text-accent-ink">{t("watch.serversYes")}</b>
      <span className="text-xs font-normal text-ink-2">{t("watch.serversYesNote")}</span>
    </span>
  );
}

/** Hook dùng chung: bật sau khi ký (chỉ khi công tắc bật và tính năng có ở server). */
export function useEnableAfterSignIn(master: string | null) {
  const qc = useQueryClient();
  const watch = useRewardsWatch();
  const enable = useEnableRewardsWatch(master);
  return {
    available: watch.data != null,
    run: async () => {
      if (watch.data == null) return;
      qc.setQueryData(REWARDS_WATCH_ERROR_KEY, null);
      try {
        await enable.mutateAsync();
      } catch (e) {
        qc.setQueryData<EnableError>(REWARDS_WATCH_ERROR_KEY, enableErrorKind(e));
      }
    },
  };
}

function EnableProblem({ kind, onRetry }: { kind: EnableError; onRetry?: () => void }) {
  const t = useTranslations("rewards.watch");
  if (kind === "no_token") return <p className="m-0 text-[13px] text-ink-2">{t("needSignIn")}</p>;
  return (
    <Banner
      tone="err"
      alert
      title={kind === "wallet" ? t("wrongWallet") : t("enableFailed")}
      body={kind === "wallet" ? t("wrongWalletBody") : t("enableFailedBody")}
      action={
        kind === "failed" && onRetry !== undefined ? (
          <Button variant="secondary" onClick={onRetry}>
            {t("tryAgain")}
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * Dải trạng thái trên trang Rewards (bản phác 03 / 04 / 05): active / off khi đã ký; paused ("Notifications paused: sign
 * in again") cả khi chưa ký. `onSignIn` mở luồng ký (khối ký của trang).
 */
export function RewardsWatchStrip({
  master,
  signedIn,
  onSignIn,
}: {
  master: string | null;
  signedIn: boolean;
  onSignIn?: () => void;
}) {
  const t = useTranslations("rewards.watch");
  const qc = useQueryClient();
  const watch = useRewardsWatch();
  const enable = useEnableRewardsWatch(master);
  const disable = useDisableRewardsWatch();
  const error = qc.getQueryData<EnableError | null>(REWARDS_WATCH_ERROR_KEY) ?? null;
  const state = watch.data;
  if (state == null) return null;

  const turnOn = () => {
    qc.setQueryData(REWARDS_WATCH_ERROR_KEY, null);
    enable.mutate(undefined, {
      onError: (e) => {
        qc.setQueryData<EnableError>(REWARDS_WATCH_ERROR_KEY, enableErrorKind(e));
      },
    });
  };

  if (state.status === "paused") {
    return (
      <Banner
        tone="warn"
        title={t("pausedTitle")}
        body={t("pausedBody", { date: dateOf(state.expiresAt) })}
        action={
          signedIn ? (
            <Button pending={enable.isPending} onClick={turnOn}>
              {enable.isPending ? t("turningOn") : t("signInAgain")}
            </Button>
          ) : onSignIn === undefined ? undefined : (
            <Button onClick={onSignIn}>{t("signInAgain")}</Button>
          )
        }
      />
    );
  }
  if (!signedIn) return null;

  const on = state.status === "active";
  const busy = enable.isPending ? "on" : disable.isPending ? "off" : null;
  const shownOn = busy === null ? on : busy === "off";
  return (
    <div className="flex flex-col gap-2">
      <section
        aria-label={t("strip")}
        className="flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-tile border border-border bg-surface px-4 py-3"
      >
        <Switch
          className="flex-row-reverse justify-end"
          label={t("strip")}
          description={
            busy === "on"
              ? t("turningOn")
              : busy === "off"
                ? t("turningOff")
                : on
                  ? t("on")
                  : t("off")
          }
          checked={shownOn}
          disabled={busy !== null}
          onCheckedChange={(next) => {
            if (next) turnOn();
            else disable.mutate();
          }}
        />
        <p className="m-0 min-w-0 flex-[1_1_320px] text-[13px] text-ink-2">
          {busy === "on"
            ? t("savingOn")
            : busy === "off"
              ? t("deletingOff")
              : on
                ? t("activeBody", { date: dateOf(state.expiresAt) })
                : t("offBody")}{" "}
          {on && busy === null ? (
            <Link
              href="/settings?tab=notifications"
              className="font-bold text-accent-ink no-underline"
            >
              {t("settingsLink")}
            </Link>
          ) : null}
        </p>
      </section>
      {on && state.delayed ? <p className="m-0 text-xs text-ink-2">{t("delayed")}</p> : null}
      {disable.isError ? (
        <Banner tone="err" alert title={t("disableFailed")} body={t("disableFailedBody")} />
      ) : null}
      {error === null ? null : <EnableProblem kind={error} onRetry={turnOn} />}
    </div>
  );
}

/** Dòng tạm dừng trên thẻ SoDEX rewards ở Overview (bản phác 06). */
export function WatchPausedNote({ expired }: { expired: boolean }) {
  const t = useTranslations("rewards.watch");
  const watch = useRewardsWatch();
  if (watch.data?.status !== "paused") return null;
  return expired ? (
    <p className="m-0 text-[13px] font-semibold text-warn">{t("expiredToo")}</p>
  ) : (
    <Banner
      tone="warn"
      title={t("pausedTitle")}
      body={t("pausedBody", { date: dateOf(watch.data.expiresAt) })}
    />
  );
}

function Pill({ state }: { state: RewardsWatchState }) {
  const t = useTranslations("rewards.watch.card");
  const cls =
    state.status === "active"
      ? "bg-pos-bg text-pos"
      : state.status === "paused"
        ? "bg-warn-bg text-warn"
        : "bg-surface-2 text-ink-2";
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${cls}`}>
      {state.status === "active"
        ? t("watching")
        : state.status === "paused"
          ? t("paused")
          : t("off")}
    </span>
  );
}

/** Thẻ "SoDEX rewards alerts" trong Settings › Notifications (bản phác 07 / 08 / 09). */
export function RewardsAlertsCard({ master }: { master: string | null }) {
  const t = useTranslations("rewards.watch");
  const watch = useRewardsWatch();
  const disable = useDisableRewardsWatch();
  const state = watch.data;
  if (state == null) return null;
  return (
    <section
      aria-labelledby="rewards-alerts-h"
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-5 md:px-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="rewards-alerts-h" className="m-0 text-lg font-extrabold">
          {t("card.title")}
        </h2>
        <Pill state={state} />
      </div>
      {state.status === "active" ? (
        <>
          <p className="m-0 text-sm text-ink-2">
            {t("card.kept", { address: master === null ? "" : shortAddress(master) })}
          </p>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-ink-2">{t("card.expires")}</dt>
            <dd className="m-0 text-right font-bold tabular-nums">{dateOf(state.expiresAt)}</dd>
            <dt className="text-ink-2">{t("card.lastChecked")}</dt>
            <dd className="m-0 text-right font-bold tabular-nums">
              {state.lastCheckedAt === null ? t("card.notAvailable") : dateOf(state.lastCheckedAt)}
            </dd>
          </dl>
          {state.delayed ? <p className="m-0 text-xs text-ink-2">{t("delayed")}</p> : null}
          <div>
            <Button
              variant="secondary"
              pending={disable.isPending}
              onClick={() => {
                disable.mutate();
              }}
            >
              {disable.isPending ? t("turningOff") : t("card.turnOff")}
            </Button>
          </div>
          {disable.isError ? (
            <Banner tone="err" alert title={t("disableFailed")} body={t("disableFailedBody")} />
          ) : null}
          <p className="m-0 text-xs text-ink-2">{t("card.turnOffNote")}</p>
        </>
      ) : state.status === "paused" ? (
        <>
          <Banner
            tone="warn"
            title={t("pausedTitle")}
            body={t("pausedBody", { date: dateOf(state.expiresAt) })}
          />
          <div>
            <Link
              href="/rewards"
              className="inline-flex min-h-tap items-center rounded-control bg-accent px-4 text-sm font-semibold text-white no-underline"
            >
              {t("signInAgainOnRewards")}
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="m-0 text-sm text-ink-2">{t("card.offBody")}</p>
          <div>
            <Link
              href="/rewards"
              className="inline-flex min-h-tap items-center rounded-control border border-border-input bg-surface px-4 text-sm font-semibold text-ink no-underline"
            >
              {t("card.turnOnFromRewards")}
            </Link>
          </div>
        </>
      )}
    </section>
  );
}
