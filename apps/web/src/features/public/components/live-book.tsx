"use client";

import { orderbookViewSchema } from "@drift/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { api } from "@/lib/api";

// Thẻ Market Making trong hero Landing (DEC-155): sổ lệnh BTC-USD trực tiếp từ SoDEX (/api/v1/public/orderbook, 2 s
// một lần), 3 mức mỗi phía; "YOU" luôn ở giá tốt nhất hai bên, như một bot Market Making báo giá ở quote level 0. Chưa
// tải được (hoặc lỗi) thì dùng sổ lệnh mẫu và ghi rõ là minh hoạ.

interface Row {
  price: number;
  usd: number;
  sum: number;
}

const SAMPLE = {
  asks: [
    { price: "74601", size: "0.765" },
    { price: "74602", size: "0.764" },
    { price: "74603", size: "0.672" },
  ],
  bids: [
    { price: "74600", size: "0.532" },
    { price: "74599", size: "0.406" },
    { price: "74598", size: "0.887" },
  ],
};

const usd = (v: number) => Math.round(v).toLocaleString("en-US");
const px = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });

function rows(levels: readonly { price: string; size: string }[]): Row[] {
  let sum = 0;
  return levels.slice(0, 3).map((l) => {
    const price = Number(l.price);
    const v = price * Number(l.size);
    sum += v;
    return { price, usd: v, sum };
  });
}

export function LiveBook() {
  const t = useTranslations("landing.hero");
  const q = useQuery({
    queryKey: ["public-orderbook", "BTC-USD"],
    queryFn: () => api("GET", "/api/v1/public/orderbook?market=BTC-USD", orderbookViewSchema),
    refetchInterval: 2_000,
    retry: 1,
  });
  const live = q.data !== undefined && q.data.bids.length > 0 && q.data.asks.length > 0;
  const book = live ? q.data : SAMPLE;
  const asks = rows(book.asks);
  const bids = rows(book.bids);
  const max = Math.max(asks.at(-1)?.sum ?? 1, bids.at(-1)?.sum ?? 1);
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0;

  const row = (side: "ask" | "bid", l: Row, you: boolean) => (
    <div
      key={`${side}-${String(l.price)}`}
      className={`relative grid grid-cols-[1.2fr_1fr_1fr] gap-2 overflow-hidden rounded-[6px] px-2 py-[5px] ${you ? "ring-2 ring-accent ring-inset" : ""}`}
    >
      <span
        className={`absolute inset-y-0 right-0 transition-[width] duration-700 ${side === "ask" ? "bg-neg/12" : "bg-pos-dot/15"}`}
        style={{ width: `${String(Math.min(100, (l.sum / max) * 100))}%` }}
      />
      <span
        className={`relative flex items-center gap-1.5 font-semibold ${side === "ask" ? "text-neg-ink" : "text-pos"}`}
      >
        {px(l.price)}
        {you ? (
          <span className="rounded-[4px] bg-accent px-1 text-[10px] leading-4 font-extrabold text-white">
            {t("you")}
          </span>
        ) : null}
      </span>
      <span className="relative text-right">{usd(l.usd)}</span>
      <span className="relative text-right text-ink-2">{usd(l.sum)}</span>
    </div>
  );

  return (
    <figure className="m-0 flex min-w-0 flex-[1_1_380px] flex-col gap-2.5 md:max-w-[500px]">
      <div
        role="img"
        aria-label={t("cardLabel")}
        className="flex flex-col gap-4 rounded-card border border-border bg-surface p-5 shadow-[0_24px_60px_-30px_rgb(20_30_80/0.35)]"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 flex-col">
            <strong className="text-[17px] font-extrabold">{t("cardTitle")}</strong>
            <span className="text-[13px] text-muted">{t("cardSub")}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-pos-bg px-2.5 py-1 text-xs font-extrabold text-fits">
            <span className={`size-[7px] rounded-full bg-fits ${live ? "animate-pulse" : ""}`} />
            {live ? t("live") : t("cardStatus")}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 text-[13px] tabular-nums">
          <div className="grid grid-cols-[1.2fr_1fr_1fr] gap-2 px-2 pb-1 text-xs text-muted">
            <span>{t("price")}</span>
            <span className="text-right">{t("size")}</span>
            <span className="text-right">{t("sum")}</span>
          </div>
          {[...asks].reverse().map((l) => row("ask", l, l.price === bestAsk))}
          <div className="my-1 flex items-baseline justify-between gap-2 border-y border-border px-2 py-2">
            <strong className="text-lg font-extrabold">{px(mid)}</strong>
            <span className="text-xs font-bold text-ink-2">
              {t("spread", { bps: spreadBps.toFixed(3) })}
            </span>
          </div>
          {bids.map((l) => row("bid", l, l.price === bestBid))}
        </div>
        <div className="flex flex-col gap-2 border-t border-border pt-3 text-[13px]">
          <span className="text-xs font-extrabold tracking-[0.04em] text-muted">
            {t("decisions")}
          </span>
          <span>
            <strong>{t("dec1")}</strong> <span className="text-ink-2">· {t("dec1Why")}</span>
          </span>
          <span>
            <strong>{t("dec2")}</strong> <span className="text-ink-2">· {t("dec2Why")}</span>
          </span>
        </div>
      </div>
      <figcaption className="self-center text-center text-xs text-ink-2">
        {live ? t("liveNote") : t("cardNote")}
      </figcaption>
    </figure>
  );
}
