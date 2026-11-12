"use client";

import { dec, orderbookViewSchema, orderListSchema, type OrderView } from "@drift/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { formatAmount } from "@/lib/format";

import { fmtPrice } from "../preview";

// Sổ lệnh trực tiếp của Market Making ở Trading Agent (DEC-99), trình bày như sổ lệnh của sàn (DEC-135): giá, khối
// lượng theo USDC, tổng cộng dồn, thanh độ sâu, giá giữa kèm spread (bps) và tỷ lệ mua / bán. Mức nào trùng giá với
// lệnh đang mở của bot thì tô và gắn "YOU". Lệnh của bot lấy từ /api/v1/orders (đã lưu ở backend), không đoán.
// Lệnh có giá tốt hơn giá tốt nhất của sổ là lệnh vừa huỷ (sổ và danh sách lệnh làm mới lệch nhau vài giây): không
// hiện, không đếm. Các lần khớp của bot nằm ở bảng Fills bên dưới (bot-fills.tsx).

const OPEN: readonly OrderView["status"][] = ["open", "partially_filled"];

interface Level {
  price: string;
  /** Khối lượng của mức, USDC. */
  usd: number;
  /** Cộng dồn từ giá tốt nhất ra ngoài, USDC. */
  sum: number;
  you: boolean;
}

const usd = (v: number) => formatAmount(v.toFixed(0), null)?.text ?? v.toFixed(0);

/** Số mức mỗi phía: mặc định, và giới hạn khi giãn theo chiều cao (DEC-147). */
const LEVELS = { base: 10, min: 5, max: 20 } as const;

/**
 * Desktop (lg): khung sổ lệnh cao theo ô lưới (bằng cột Market Making + Fills), đo chiều cao rồi chọn số mức mỗi
 * phía vừa khung. Dưới lg giữ 10 mức, khung cao theo nội dung.
 */
function useFitLevels() {
  const box = useRef<HTMLDivElement>(null);
  const [n, setN] = useState<number>(LEVELS.base);
  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const fit = () => {
      if (!mq.matches) {
        setN(LEVELS.base);
        return;
      }
      const row = el.querySelector("li")?.getBoundingClientRect().height ?? 26;
      // Phần cố định: dòng tiêu đề cột, giá giữa, thanh mua / bán (≈ 110 px).
      const k = Math.floor((el.clientHeight - 110) / (2 * (row + 2)));
      setN(Math.max(LEVELS.min, Math.min(LEVELS.max, k)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    mq.addEventListener("change", fit);
    return () => {
      ro.disconnect();
      mq.removeEventListener("change", fit);
    };
  }, []);
  return { box, n };
}

export function LiveQuotes({
  botId,
  market,
  stopped = false,
}: {
  botId: string;
  market: string;
  /** Bot đã dừng: vẫn hiện sổ lệnh của market, kèm một dòng cho biết bot không còn báo giá. */
  stopped?: boolean;
}) {
  const t = useTranslations("agent.quotes");
  const { box, n } = useFitLevels();
  const book = useQuery({
    queryKey: ["orderbook", market],
    queryFn: () =>
      api("GET", `/api/v1/markets/${encodeURIComponent(market)}/orderbook`, orderbookViewSchema),
    refetchInterval: 2_000,
  });
  const orders = useQuery({
    queryKey: ["orders", botId],
    queryFn: () => api("GET", `/api/v1/orders?botId=${botId}`, orderListSchema),
    refetchInterval: stopped ? false : 3_000,
  });
  const b = book.data;
  const bestBid = b?.bids[0]?.price;
  const bestAsk = b?.asks[0]?.price;
  // Lệnh đang mở của bot, bỏ lệnh có giá tốt hơn giá tốt nhất của sổ (lệnh vừa huỷ, chưa kịp cập nhật).
  const mine = (orders.data?.items ?? []).filter((o) => {
    if (!OPEN.includes(o.status) || o.price === null) return false;
    if (o.side === "buy" && bestBid !== undefined && dec(o.price).gt(bestBid)) return false;
    if (o.side === "sell" && bestAsk !== undefined && dec(o.price).lt(bestAsk)) return false;
    return true;
  });
  const isMine = (side: "buy" | "sell", price: string) =>
    mine.some((o) => o.side === side && o.price !== null && dec(o.price).eq(price));

  const levels = (side: "buy" | "sell", raw: readonly { price: string; size: string }[]) => {
    let sum = 0;
    return raw.map((l): Level => {
      const v = Number(l.price) * Number(l.size);
      sum += v;
      return { price: l.price, usd: v, sum, you: isMine(side, l.price) };
    });
  };
  const bids = b === undefined ? [] : levels("buy", b.bids.slice(0, n));
  const asks = b === undefined ? [] : levels("sell", b.asks.slice(0, n));
  const maxSum = Math.max(bids.at(-1)?.sum ?? 0, asks.at(-1)?.sum ?? 0, 1);
  const mid =
    bestBid !== undefined && bestAsk !== undefined ? dec(bestBid).add(bestAsk).div(2) : null;
  const spreadBps =
    mid !== null && bestBid !== undefined && bestAsk !== undefined
      ? dec(bestAsk).sub(bestBid).div(mid).mul(10_000).toNumber()
      : null;
  const totalBid = bids.at(-1)?.sum ?? 0;
  const totalAsk = asks.at(-1)?.sum ?? 0;
  const buyPct = totalBid + totalAsk > 0 ? (totalBid / (totalBid + totalAsk)) * 100 : null;

  // Lệnh của bot nằm xa hơn mức cuối đang hiện: ghim ở cuối phía đó, sau dấu ⋯.
  const beyond = (side: "buy" | "sell", shown: readonly Level[]) =>
    mine
      .filter((o) => o.side === side && !shown.some((l) => dec(l.price).eq(o.price ?? "0")))
      .sort((x, y) => dec(x.price ?? "0").comparedTo(y.price ?? "0") * (side === "buy" ? -1 : 1))
      .map((o) => ({
        id: o.id,
        price: o.price ?? "0",
        usd: Number(o.price ?? "0") * Number(dec(o.size).sub(o.filledSize).toString()),
      }));

  const row = (side: "buy" | "sell", l: Level) => {
    const buy = side === "buy";
    return (
      <li
        key={`${side}${l.price}`}
        className={`relative grid grid-cols-[1.2fr_1fr_1fr] items-center gap-2 overflow-hidden rounded-[6px] px-2 py-[5px] ${
          l.you ? "ring-2 ring-accent ring-inset" : ""
        }`}
      >
        {/* Thanh độ sâu: dài theo tổng cộng dồn, neo bên phải như sổ lệnh của sàn. */}
        <span
          aria-hidden="true"
          className={`absolute inset-y-0 right-0 ${buy ? "bg-pos-dot/15" : "bg-neg/12"}`}
          style={{ width: `${String((l.sum / maxSum) * 100)}%` }}
        />
        <span
          className={`relative flex items-center gap-1.5 font-semibold ${buy ? "text-pos" : "text-neg-ink"}`}
        >
          {fmtPrice(l.price)}
          {l.you ? (
            <span className="rounded-[4px] bg-accent px-1 text-[10px] leading-4 font-extrabold text-white">
              {t("you")}
            </span>
          ) : null}
        </span>
        <span className="relative text-right">{usd(l.usd)}</span>
        <span className="relative text-right text-ink-2">{usd(l.sum)}</span>
      </li>
    );
  };

  const pinned = (side: "buy" | "sell", rows: { id: string; price: string; usd: number }[]) =>
    rows.length === 0
      ? []
      : [
          <li
            key={`${side}-gap`}
            aria-hidden="true"
            className="px-2 text-center text-xs leading-4 text-muted"
          >
            ⋯
          </li>,
          ...rows.map((o) => (
            <li
              key={`${side}-mine-${o.id}`}
              title={t("outside")}
              className="grid grid-cols-[1.2fr_1fr_1fr] items-center gap-2 rounded-[6px] px-2 py-[5px] ring-2 ring-accent ring-inset"
            >
              <span
                className={`flex items-center gap-1.5 font-semibold ${side === "buy" ? "text-pos" : "text-neg-ink"}`}
              >
                {fmtPrice(o.price)}
                <span className="rounded-[4px] bg-accent px-1 text-[10px] leading-4 font-extrabold text-white">
                  {t("you")}
                </span>
                <span className="sr-only"> · {t("outside")}</span>
              </span>
              <span className="text-right">{usd(o.usd)}</span>
              <span />
            </li>
          )),
        ];

  return (
    <section
      aria-labelledby="vm-quotes-title"
      className="flex h-full flex-col gap-3 rounded-card border border-border bg-surface p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="vm-quotes-title" className="m-0 text-lg font-extrabold">
          {t("title")}
        </h2>
        {stopped ? null : (
          <span className="text-xs text-muted tabular-nums" aria-live="polite">
            {t("summary", {
              bids: mine.filter((o) => o.side === "buy").length,
              asks: mine.filter((o) => o.side === "sell").length,
            })}
          </span>
        )}
      </div>
      {stopped ? (
        <p role="status" className="m-0 rounded-[10px] bg-surface-2 px-3 py-2 text-sm text-ink-2">
          {t("stopped")}
        </p>
      ) : null}
      <div ref={box} className="lg:relative lg:min-h-0 lg:flex-1">
        {b === undefined ? (
          <p role="status" className="m-0 text-sm text-ink-2">
            {book.isError ? t("unavailable") : t("loading")}
          </p>
        ) : (
          <div className="flex flex-col gap-0.5 text-[13px] tabular-nums lg:absolute lg:inset-0 lg:overflow-hidden">
            <div className="grid grid-cols-[1.2fr_1fr_1fr] gap-2 px-2 pb-1 text-xs text-muted">
              <span>{t("price")}</span>
              <span className="text-right">{t("sizeUsd")}</span>
              <span className="text-right">{t("sumUsd")}</span>
            </div>
            <ul className="m-0 flex list-none flex-col-reverse gap-0.5 p-0" aria-label={t("asks")}>
              {asks.map((l) => row("sell", l))}
              {pinned("sell", beyond("sell", asks))}
            </ul>
            <div className="my-1 flex items-baseline justify-between gap-2 border-y border-border px-2 py-2">
              <strong className="text-lg font-extrabold">
                {mid === null ? t("noMid") : fmtPrice(mid.toString())}
              </strong>
              <span className="text-xs font-bold text-ink-2">
                {spreadBps === null ? "" : t("spread", { bps: spreadBps.toFixed(3) })}
              </span>
            </div>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label={t("bids")}>
              {bids.map((l) => row("buy", l))}
              {pinned("buy", beyond("buy", bids))}
            </ul>
            {buyPct === null ? null : (
              <div className="mt-2 flex items-center gap-2 px-2 text-xs font-bold tabular-nums">
                <span className="text-pos">{t("buyShare", { pct: buyPct.toFixed(1) })}</span>
                <span
                  aria-hidden="true"
                  className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-neg/40"
                >
                  <span className="h-full bg-pos-dot" style={{ width: `${String(buyPct)}%` }} />
                </span>
                <span className="text-neg-ink">
                  {t("sellShare", { pct: (100 - buyPct).toFixed(1) })}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
