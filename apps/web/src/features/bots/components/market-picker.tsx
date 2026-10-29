"use client";

import { useTranslations } from "next-intl";
import { useMemo, type InputHTMLAttributes } from "react";

import { formatAmount, formatInteger, stepDecimals } from "@/lib/format";
import { useMarkets } from "@/lib/markets";

import { displayParts, marketItems } from "../pickers";

import { Picker } from "./picker";
import { WatchStar } from "./watch-star";

// Ô chọn market (UI_REVIEW E7, G6): chỉ market đang `TRADING`, hiện tên hiển thị của SoDEX (E1.6).
// Giá trị gửi đi luôn là mã gốc (`vBTC_vUSDC`, `BTC-USD`). Chưa gõ gì: nhóm "Popular" (BTC, ETH, SOL;
// quyết định UI, không phải số liệu) rồi A→Z theo quote hiển thị. SoDEX không trả khối lượng 24h hay
// phân loại market nên không có cột Vol và không có chip lọc.

export function MarketPicker({
  engine,
  value,
  onChange,
  disabled,
  inputProps,
  added,
  watch = true,
}: {
  engine: "spot" | "perps";
  value: string;
  onChange: (market: string) => void;
  disabled?: boolean | undefined;
  /** id / aria-* do `Field` cấp cho ô nhập. */
  inputProps: InputHTMLAttributes<HTMLInputElement>;
  /** Market đã có (Watchlist › Add market): disabled kèm "Added". */
  added?: ReadonlySet<string> | undefined;
  /** Nút ☆ "Add to watchlist" cạnh market đang chọn (UI_REVIEW M2). */
  watch?: boolean;
}) {
  const t = useTranslations("createBot.marketPicker");
  const markets = useMarkets();
  const all = markets.data?.items;
  const items = useMemo(
    () =>
      marketItems(all ?? [], engine, {
        popular: t("popular"),
        quote: (quote) => (quote === "" ? t("other") : t("quote", { quote })),
      }).map((it) =>
        added?.has(it.value) === true ? { ...it, disabled: true, secondary: t("added") } : it,
      ),
    [all, engine, t, added],
  );
  const m = all?.find((x) => x.name === value);
  const info =
    m === undefined
      ? undefined
      : [
          m.last === null
            ? null
            : t("info.last", { price: formatAmount(m.last, stepDecimals(m.tickSize))?.text ?? "" }),
          t("info.minOrder", {
            amount: formatAmount(m.minNotional)?.text ?? m.minNotional,
            quote: displayParts(m).quote,
          }),
          m.maxLeverage === null
            ? null
            : t("info.maxLeverage", { n: formatInteger(m.maxLeverage) }),
        ]
          .filter((x): x is string => x !== null)
          .join(" · ");

  const picker = (
    <Picker
      items={items}
      value={value}
      onChange={onChange}
      disabled={disabled}
      inputProps={inputProps}
      placeholder={t("placeholder")}
      loading={markets.isPending}
      noMatch={(q) => t("noMatch", { q })}
      sheetTitle={t("sheetTitle")}
      info={info}
      selectedLabel={m?.displayName}
    />
  );
  if (!watch || m === undefined || disabled === true) return picker;
  return (
    <div className="flex flex-col gap-1">
      {picker}
      <WatchStar market={m.name} engine={m.engine} label={m.displayName} />
    </div>
  );
}
