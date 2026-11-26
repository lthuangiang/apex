"use client";

import { Button } from "@drift/ui";
import { Gift, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useConnect, useConnection, useDisconnect, type Connector } from "wagmi";

import { WalletPicker } from "@/features/onboarding/components/wallet-picker";
import { shortAddress } from "@/lib/format";
import { connectWatched } from "@/lib/watch-wallet";

import type { SignInResult } from "../sign-in";
import type { useRewardsAuth } from "../use-rewards-auth";

import { ExpiredBanner, MismatchBanner, RewardsProblem } from "./rewards-states";
import { ServersValue, useEnableAfterSignIn, WatchConsent } from "./watch-ui";

// Khối mời ký của trang Rewards (bản phác 08, trạng thái ở 18): một chữ ký `personal_sign`, không gas. Ví chỉ được bật
// khi người dùng bấm (không tự bật ví, DEC-397); ví khác master wallet thì không ký gì.

type Auth = ReturnType<typeof useRewardsAuth>;

/**
 * Bắt đầu đăng nhập rewards; chưa kết nối ví thì mở danh sách ví, chọn xong thì ký tiếp (người dùng đã bấm ký).
 * `onSignedIn`: chạy sau khi ký xong (#558: gửi phiên lên server khi công tắc "Tell me about new boxes" bật).
 */
export function useRewardsSignIn(auth: Auth, onSignedIn?: () => Promise<void> | void) {
  const { isConnected } = useConnection();
  const { mutateAsync: connectAsync } = useConnect();
  const { mutateAsync: disconnectAsync } = useDisconnect();
  const [picking, setPicking] = useState(false);

  async function start(): Promise<SignInResult | null> {
    const r = await auth.signIn();
    if (r?.kind === "no_wallet") setPicking(true);
    if (r?.kind === "signed_in" && onSignedIn !== undefined) await onSignedIn();
    return r;
  }

  async function pick(connector: Connector) {
    if (isConnected) await disconnectAsync().catch(() => undefined);
    const ok = await connectWatched(connector, () => connectAsync({ connector })).then(
      () => true,
      () => false,
    );
    setPicking(false);
    if (ok) await start();
  }

  return {
    picking,
    choose: () => {
      setPicking(true);
    },
    start: () => void start(),
    pick: (c: Connector) => void pick(c),
  };
}

export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-4 flex-none rounded-full border-2 border-current border-t-transparent opacity-80 motion-safe:animate-spin"
    />
  );
}

export function SignInHero({ auth }: { auth: Auth }) {
  const t = useTranslations("rewards");
  // #558 (DEC-398): công tắc "Tell me about new boxes" bật sẵn; chỉ hiện khi tính năng có ở server (GET không 404).
  // Bật lúc ký thì sau auth/verify gửi phiên lên server đúng một lần; gạt tắt thì token chỉ ở trình duyệt.
  const [keep, setKeep] = useState(true);
  const watch = useEnableAfterSignIn(auth.master);
  const flow = useRewardsSignIn(auth, async () => {
    if (keep) await watch.run();
  });
  const watching = watch.available && keep;
  const master = auth.master;
  const signing = auth.phase === "signing";
  const mismatch = auth.last?.kind === "wrong_wallet" ? auth.last.connected : null;
  const rows = ["gas", "trades", "funds", "servers"] as const;

  return (
    <section
      aria-labelledby="rewards-sign-h"
      className="flex flex-wrap items-stretch gap-6 rounded-hero bg-hero p-5 sm:p-7"
    >
      <div className="flex min-w-0 flex-[1_1_420px] flex-col items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-14 items-center justify-center rounded-[16px] bg-surface/70 text-accent"
        >
          <Gift size={28} />
        </span>
        <h2 id="rewards-sign-h" className="m-0 text-2xl font-extrabold tracking-[-0.01em]">
          {t("signIn.title")}
        </h2>
        <p className="m-0 text-[15px] leading-normal text-ink-2">{t("signIn.body")}</p>
        {master === null ? null : (
          <p className="m-0 text-sm text-ink-2">
            {t("signIn.wallet")} <b className="text-ink tabular-nums">{shortAddress(master)}</b>{" "}
            <span className="text-muted">{t("signIn.walletNote")}</span>
          </p>
        )}
        {auth.expired ? (
          <div className="w-full">
            <ExpiredBanner onSign={flow.start} pending={signing} />
          </div>
        ) : null}
        {mismatch === null || master === null ? null : (
          <div className="w-full">
            <MismatchBanner connected={mismatch} master={master} onChoose={flow.choose} />
          </div>
        )}
        {auth.error === null ? null : (
          <div className="w-full">
            <RewardsProblem error={auth.error} onRetry={flow.start} />
          </div>
        )}
        {watch.available ? <WatchConsent keep={keep} onKeep={setKeep} /> : null}
        {auth.expired ? null : (
          <Button pending={signing} onClick={flow.start} className="px-5 text-[15px] font-bold">
            {signing ? (
              <>
                <Spinner />
                {t("signIn.checkWallet")}
              </>
            ) : (
              t("signIn.sign")
            )}
          </Button>
        )}
        <p className="m-0 text-xs text-ink-2" role={signing ? "status" : undefined}>
          {signing || auth.last?.kind === "rejected" ? t("signIn.rejected") : t("signIn.stay")}
        </p>
        {flow.picking ? (
          <div className="w-full">
            <WalletPicker onPick={flow.pick} disabled={signing} />
          </div>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-2 rounded-[20px] bg-surface/90 px-5 py-4">
        <h3 className="m-0 text-xs font-bold tracking-[0.06em] text-ink-2 uppercase">
          {t("thisSignIn.title")}
        </h3>
        <dl className="m-0 flex flex-col text-[15px]">
          {rows.map((k) => (
            <div
              key={k}
              className="flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-b-0"
            >
              <dt>{t(`thisSignIn.${k}`)}</dt>
              <dd className="m-0 font-bold text-neg-ink">
                {k === "servers" && watch.available ? (
                  <ServersValue keep={watching} />
                ) : (
                  t("thisSignIn.no")
                )}
              </dd>
            </div>
          ))}
        </dl>
        <p className="m-0 mt-auto text-xs text-ink-2">{t("thisSignIn.again")}</p>
      </div>
    </section>
  );
}

/** "Your points, tier and rank · Shows after you sign in." (bản phác 08). */
export function LockedRow() {
  const t = useTranslations("rewards.locked");
  return (
    <div className="flex items-center gap-3.5 rounded-card border border-dashed border-border-input bg-surface px-5 py-4">
      <span
        aria-hidden="true"
        className="flex size-9 flex-none items-center justify-center rounded-[12px] bg-surface-2 text-ink-2"
      >
        <Lock size={16} />
      </span>
      <div className="flex min-w-0 flex-col">
        <b className="text-[15px]">{t("title")}</b>
        <span className="text-xs text-ink-2">{t("body")}</span>
      </div>
    </div>
  );
}
