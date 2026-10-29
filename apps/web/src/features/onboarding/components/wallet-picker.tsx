"use client";

import { useTranslations } from "next-intl";
import { useConnectors, type Connector } from "wagmi";

// Chọn ví để ký (DRIFT chỉ xin chữ ký, không gửi giao dịch). Ví extension được phát hiện qua EIP-6963;
// ví phổ biến chưa cài vẫn được liệt kê dạng "Not detected" để người dùng biết có hỗ trợ.
// Ví phải là master wallet của account SoDEX: kết nối sai ví thì server từ chối chữ ký.

const KNOWN = [
  { name: "Binance Wallet", match: /binance/i },
  { name: "OKX Wallet", match: /okx/i },
  { name: "Bitget Wallet", match: /bitget/i },
  { name: "MetaMask", match: /metamask/i },
] as const;

export function WalletPicker({
  onPick,
  disabled,
}: {
  onPick: (connector: Connector) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("onboarding.connect.wallets");
  const connectors = useConnectors();
  const discovered = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
  const generic = connectors.find((c) => c.id === "injected");
  const wc = connectors.find((c) => c.type === "walletConnect");
  const missing = KNOWN.filter((k) => !discovered.some((c) => k.match.test(c.name)));

  const option = (
    key: string,
    label: string,
    icon: string | undefined,
    onClick: (() => void) | null,
    note?: string,
  ) => (
    <li key={key}>
      <button
        type="button"
        disabled={onClick === null || disabled === true}
        onClick={onClick ?? undefined}
        className="flex min-h-tap w-full items-center gap-3 rounded-tile border border-border bg-surface px-4 py-3 text-left font-bold enabled:hover:bg-surface-2 disabled:cursor-not-allowed disabled:text-muted"
      >
        {icon === undefined ? (
          <span aria-hidden="true" className="size-7 rounded-full bg-surface-2" />
        ) : (
          <img src={icon} alt="" className="size-7 rounded-full" />
        )}
        <span className="flex flex-col">
          <span>{label}</span>
          {note === undefined ? null : (
            <span className="text-xs font-normal text-muted">{note}</span>
          )}
        </span>
      </button>
    </li>
  );

  return (
    <section aria-labelledby="wallet-title" className="flex flex-col gap-3">
      <h2 id="wallet-title" className="m-0 text-base font-extrabold">
        {t("title")}
      </h2>
      <p className="m-0 text-sm text-ink-2">{t("hint")}</p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {discovered.map((c) =>
          option(c.id, c.name, c.icon, () => {
            onPick(c);
          }),
        )}
        {/* Ví chỉ gắn window.ethereum (không công bố EIP-6963). */}
        {discovered.length === 0 && generic !== undefined
          ? option("injected", t("browser"), undefined, () => {
              onPick(generic);
            })
          : null}
        {wc === undefined
          ? option("walletconnect", t("walletConnect"), undefined, null, t("wcUnavailable"))
          : option(
              "walletconnect",
              t("walletConnect"),
              undefined,
              () => {
                onPick(wc);
              },
              t("wcNote"),
            )}
        {missing.map((k) => option(k.name, k.name, undefined, null, t("notDetected")))}
      </ul>
    </section>
  );
}
