"use client";

import type { BookStatus, DepthLabel, MarketDepth } from "@drift/shared";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { agoParts, usd } from "../shape";

// Mảnh dùng chung của trang US Market và bảng độ sâu trong form tạo bot (DEC-402, #591).

const PILL =
  "inline-flex items-center gap-1.5 rounded-full px-[11px] py-1 text-xs font-extrabold whitespace-nowrap";

/** Đồng hồ cho "read N s ago" / "N days ago"; render đầu dùng `Date.now()` lúc mount. */
export function useNow(intervalMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}

/** Trạng thái sổ lệnh lấy từ dữ liệu thật: Trading / Empty / Halted; null → "Not provided". */
export function BookStatusPill({ status }: { status: BookStatus | null }) {
  const t = useTranslations("usMarket.book");
  const tm = useTranslations("common.missing");
  if (status === null) return <span className="text-xs text-ink-2">{tm("notProvided")}</span>;
  const tone =
    status === "trading"
      ? "bg-pos-bg text-pos"
      : status === "halted"
        ? "bg-neg-soft text-neg-text"
        : "bg-surface-2 text-ink-2";
  return (
    <span className={`${PILL} ${tone}`}>
      {status === "trading" ? <span aria-hidden="true">●</span> : null}
      {t(status)}
    </span>
  );
}

/** Nhãn `Thin` / `Very thin`; sổ đủ sâu thì không có nhãn. */
export function DepthLabelPill({ label }: { label: DepthLabel }) {
  const t = useTranslations("usMarket.depth");
  if (label === "ok") return null;
  return <span className={`${PILL} bg-warn-bg text-warn`}>{t(label)}</span>;
}

/** "$2,449.00 / $1,955.00" + nhãn; không có độ sâu → "–". */
export function DepthPair({ depth }: { depth: MarketDepth | null }) {
  const t = useTranslations("usMarket.depth");
  if (depth === null) return <span>–</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      {t("pair", { bids: usd(depth.bidsNotional) ?? "", asks: usd(depth.asksNotional) ?? "" })}
      <DepthLabelPill label={depth.label} />
    </span>
  );
}

/** "3 days ago" / "5 min ago"; null → "Not provided". */
export function useAgo() {
  const t = useTranslations("usMarket.ago");
  return (iso: string, now: number): string => {
    const { unit, n } = agoParts(iso, now);
    return t(unit, { n });
  };
}
