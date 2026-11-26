"use client";

import { Button } from "@drift/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { shortAddress } from "@/lib/format";

import type { RewardsError } from "../client";
import { useRewardsPause } from "../queries";

// Dải trạng thái của SoDEX rewards (bản phác 18): hết hạn, sai ví, chưa kết nối SoDEX, lỗi mạng, 429, lỗi nghiệp vụ.
// Dùng chung cho trang /rewards (#548) và thẻ Overview (#549).

type Tone = "warn" | "err" | "info";

const TONE: Record<Tone, string> = {
  warn: "bg-warn-bg text-warn",
  err: "bg-neg-bg text-neg-ink",
  info: "bg-accent-tint text-accent-ink",
};

export function Banner({
  tone,
  title,
  body,
  action,
  alert = false,
}: {
  tone: Tone;
  title?: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  /** Lỗi cần đọc ngay (`role="alert"`); còn lại là `status`. */
  alert?: boolean;
}) {
  return (
    <div
      role={alert ? "alert" : "status"}
      className={`flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-tile px-4 py-3 text-sm ${TONE[tone]}`}
    >
      <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
        {title === undefined ? null : <p className="m-0 font-bold">{title}</p>}
        {body === undefined ? null : <p className="m-0 leading-normal">{body}</p>}
      </div>
      {action}
    </div>
  );
}

/** Phiên rewards hết hạn (SoDEX trả 401): token đã bị xoá; ký lại để đọc tiếp. */
export function ExpiredBanner({ onSign, pending }: { onSign: () => void; pending: boolean }) {
  const t = useTranslations("rewards");
  return (
    <Banner
      tone="warn"
      title={t("expired.title")}
      body={t("expired.body")}
      action={
        <Button pending={pending} onClick={onSign} className="px-4">
          {pending ? t("signIn.checkWallet") : t("expired.action")}
        </Button>
      }
    />
  );
}

/** Ví đang kết nối khác master wallet của account SoDEX: không ký gì (DEC-397). */
export function MismatchBanner({
  connected,
  master,
  onChoose,
}: {
  connected: string;
  master: string;
  onChoose: () => void;
}) {
  const t = useTranslations("rewards.mismatch");
  return (
    <div className="flex flex-col gap-3">
      <Banner
        tone="warn"
        alert
        title={t("title")}
        body={`${t("connected")} ${shortAddress(connected)} · ${t("account")} ${shortAddress(master)}. ${t("switch", { address: shortAddress(master) })}`}
      />
      <Button variant="secondary" onClick={onChoose} className="self-start">
        {t("choose")}
      </Button>
    </div>
  );
}

/** Tài khoản DeskLabs chưa kết nối SoDEX: không có master wallet để đăng nhập rewards. */
export function NotConnectedBanner() {
  const t = useTranslations("rewards");
  return (
    <Banner
      tone="warn"
      body={t("notConnected")}
      action={
        <Link
          href="/onboarding/connect"
          className="flex min-h-tap items-center rounded-control border border-border-input bg-surface px-4 text-sm font-semibold text-ink no-underline"
        >
          {t("notConnectedAction")}
        </Link>
      }
    />
  );
}

/**
 * Lỗi khi đọc SoDEX: 429 (đếm ngược theo `retryAfter`; không có thì dừng nhưng không hiện số), lỗi nghiệp vụ ("SoDEX
 * said: …"), còn lại là không tới được SoDEX (mạng, HTTP, dữ liệu lệch schema). 401 xử lý riêng (`ExpiredBanner`).
 */
export function RewardsProblem({ error, onRetry }: { error: RewardsError; onRetry: () => void }) {
  const t = useTranslations("rewards.errors");
  const pause = useRewardsPause();
  if (error.kind === "rate_limited" && pause.active) {
    const s = pause.seconds;
    return (
      <div className="flex flex-col gap-3">
        <Banner
          tone="err"
          alert
          title={s === null ? t("busyNoTime") : t("busy", { s })}
          body={t("busyBody")}
        />
        <Button variant="secondary" disabled className="self-start">
          {s === null ? t("retry") : t("retryIn", { s })}
        </Button>
      </div>
    );
  }
  if (error.kind === "business")
    return (
      <Banner
        tone="err"
        alert
        title={t("business")}
        body={error.sodexMessage === null ? undefined : `${t("said")} “${error.sodexMessage}”`}
      />
    );
  if (error.kind === "expired") return null;
  // 429 đã hết thời gian dừng: cho thử lại, không nói "không tới được SoDEX".
  const busyOver = error.kind === "rate_limited";
  // Mạng / HTTP / schema: cho thử lại.
  return (
    <div className="flex flex-col gap-3">
      <Banner
        tone="err"
        alert
        title={busyOver ? t("busyNoTime") : t("network")}
        body={busyOver ? undefined : t("networkBody")}
      />
      <Button variant="secondary" onClick={onRetry} className="self-start">
        {t("retry")}
      </Button>
    </div>
  );
}
