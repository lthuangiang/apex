"use client";

import { Button } from "@drift/ui";
import { useTranslations } from "next-intl";
import { useRef, useState, type ReactNode } from "react";
import { useConnect, useConnection, useDisconnect, type Connector } from "wagmi";

import { WalletPicker } from "@/features/onboarding/components/wallet-picker";
import { shortAddress } from "@/lib/format";

// Ký trong Settings (renew key, phí, disconnect) cần ví đang kết nối đúng là master wallet của account SoDEX.
// Sau khi tải lại trang, wagmi có thể không còn nhớ ví: hỏi người dùng chọn ví trước khi mở dialog, không để
// lỗi chữ ký rơi vào "Something went wrong" (DEC-62).

export class WalletCancelled extends Error {
  override name = "WalletCancelled";
}

const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

export function useMasterWallet(expected: string): {
  ensure: () => Promise<void>;
  prompt: ReactNode;
} {
  const t = useTranslations("settings.sodexAccess.wallet");
  const tConnect = useTranslations("onboarding.connect");
  const { address, isConnected } = useConnection();
  const { mutateAsync: connectAsync } = useConnect();
  const { mutateAsync: disconnectAsync } = useDisconnect();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiter = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  function ensure(): Promise<void> {
    if (isConnected && same(address, expected)) return Promise.resolve();
    waiter.current?.reject(new WalletCancelled());
    setError(null);
    setPicking(true);
    return new Promise((resolve, reject) => {
      waiter.current = { resolve, reject };
    });
  }

  async function pick(connector: Connector) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (isConnected) await disconnectAsync();
      const account = (await connectAsync({ connector })).accounts[0];
      if (!same(account, expected)) {
        setError(t("wrong", { address: shortAddress(expected) }));
        return;
      }
      setPicking(false);
      waiter.current?.resolve();
      waiter.current = null;
    } catch {
      setError(tConnect("errors.noWallet"));
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setPicking(false);
    setError(null);
    waiter.current?.reject(new WalletCancelled());
    waiter.current = null;
  }

  const prompt = picking ? (
    <div className="flex flex-col gap-3 rounded-tile border border-border bg-surface-2 p-4">
      <p className="m-0 text-sm text-ink-2">{t("lead", { address: shortAddress(expected) })}</p>
      {error === null ? null : (
        <p role="alert" className="m-0 text-sm font-semibold text-neg-ink">
          {error}
        </p>
      )}
      <WalletPicker disabled={busy} onPick={(c) => void pick(c)} />
      <Button variant="secondary" className="self-start" onClick={cancel}>
        {t("cancel")}
      </Button>
    </div>
  ) : null;

  return { ensure, prompt };
}
