"use client";

import { dec, DEPTH_THIN_USD, type UsMarketRow } from "@drift/shared";
import { useTranslations } from "next-intl";

import { formatMoney } from "@/lib/format";

import { depthFitOf, largestPositionOf, type DepthFit, type LargestKind } from "../depth-hint";
import { useDepthCapMarkets, usMarketRowOf, useUsMarkets } from "../queries";
import { marketLabel, secondsSince, usd } from "../shape";

import { BookStatusPill, DepthLabelPill, useNow } from "./parts";

// Bảng độ sâu sổ lệnh và dòng "Largest position" trong form tạo bot (bản phác màn 03, DEC-402 mục 5). Chỉ hiện cho market
// trong `depthCapMarkets` của `/features` (api quyết định, #597) và khi `/markets/us` có dòng của market đó. Chỉ là gợi ý:
// server kiểm lại khi tạo (`VALIDATION_FAILED reason order_book_depth`). Không có "Spread" (api không trả giá tốt nhất).

export interface DepthHint {
  market: string;
  row: UsMarketRow;
  readAt: string;
  largest: { notional: string; kind: LargestKind } | null;
  fit: DepthFit | null;
}

export function useDepthHint(
  strategy: string,
  market: string,
  config: Record<string, unknown>,
): DepthHint | null {
  const caps = useDepthCapMarkets();
  const capped = market !== "" && caps.includes(market);
  const markets = useUsMarkets(capped);
  if (!capped) return null;
  const row = usMarketRowOf(markets.data, market);
  if (row === null || markets.data === undefined) return null;
  const largest = largestPositionOf(strategy, config);
  const closed = row.bookStatus === "empty" || row.bookStatus === "halted";
  const fit =
    largest !== null
      ? depthFitOf(largest.notional, row.bookStatus, row.depth)
      : closed
        ? ({ kind: "empty" } as const)
        : null;
  return { market, row, readAt: markets.data.readAt, largest, fit };
}

/** Web chặn Start khi vị thế chắc chắn không vừa sổ (server vẫn kiểm lại). */
export const depthBlocks = (hint: DepthHint | null): boolean =>
  hint?.fit?.kind === "too_large" || hint?.fit?.kind === "empty";

/** Thanh tỉ lệ (trang trí): notional / ngưỡng `Thin`, tối đa 100%. */
const barPct = (notional: string): number =>
  Math.min(100, dec(notional).div(DEPTH_THIN_USD).mul(100).toDecimalPlaces(0).toNumber());

export function OrderBookPanel({ hint }: { hint: DepthHint }) {
  const t = useTranslations("usMarket.panel");
  const tm = useTranslations("common.missing");
  const now = useNow();
  const { row } = hint;
  const depth = row.depth;
  const name = marketLabel(row.symbol);
  return (
    <section
      aria-labelledby="order-book-panel"
      data-testid="order-book-panel"
      className="flex min-w-0 flex-col gap-2.5 rounded-card border border-border bg-surface p-[18px]"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="order-book-panel" className="m-0 text-[17px] font-extrabold">
          {t("title", { market: name })}
        </h2>
        {depth !== null && row.bookStatus === "trading" ? (
          <DepthLabelPill label={depth.label} />
        ) : (
          <BookStatusPill status={row.bookStatus} />
        )}
      </div>
      {(["bids", "asks"] as const).map((side) => {
        const v = depth === null ? null : side === "bids" ? depth.bidsNotional : depth.asksNotional;
        return (
          <div key={side} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-ink-2">{t(side)}</span>
              <b className="tabular-nums">{usd(v) ?? tm("notAvailable")}</b>
            </div>
            <div
              aria-hidden="true"
              className="flex h-2.5 overflow-hidden rounded-full bg-surface-2"
            >
              {v === null ? null : (
                <i
                  className={`block h-full ${side === "bids" ? "bg-pos" : "bg-neg"}`}
                  style={{ width: `${String(barPct(v))}%` }}
                />
              )}
            </div>
          </div>
        );
      })}
      {depth?.maxPositionUsd == null ? null : (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-ink-2">{t("largest")}</span>
          <b className="tabular-nums">{usd(depth.maxPositionUsd)}</b>
        </div>
      )}
      <p className="m-0 text-[12.5px] text-ink-2">
        {t("note", { n: secondsSince(hint.readAt, now) })}
      </p>
    </section>
  );
}

export function LargestPositionLine({ hint }: { hint: DepthHint }) {
  const t = useTranslations("usMarket.largest");
  const name = marketLabel(hint.row.symbol);
  const { largest, fit } = hint;
  if (fit === null || fit.kind === "no_cap") return null;
  if (fit.kind === "empty")
    return (
      <p role="status" className="m-0 text-[13px] font-bold text-neg-text">
        {t("empty", { market: name })}
      </p>
    );
  if (largest === null) return null;
  const limit = formatMoney(fit.limit) ?? fit.limit;
  const tooLarge = fit.kind === "too_large";
  const perps = largest.kind === "grid_perps" || largest.kind === "dca_perps";
  return (
    <div className="flex flex-col gap-1.5" data-testid="largest-position">
      <span className="text-[12.5px] font-extrabold text-ink-body">{t(largest.kind)}</span>
      <div
        className={`flex h-11 items-center justify-between rounded-control border px-3.5 font-bold tabular-nums ${tooLarge ? "border-neg-border bg-neg-soft" : "border-pos-border bg-pos-bg"}`}
      >
        {formatMoney(largest.notional) ?? largest.notional}
        <span className="text-xs font-semibold text-ink-2">USDC</span>
      </div>
      <p
        role="status"
        className={`m-0 text-[12.5px] font-bold ${tooLarge ? "text-neg-text" : "text-pos"}`}
      >
        {tooLarge
          ? t(perps ? "tooLarge" : "tooLargeSpot", { market: name, limit })
          : t("fits", { market: name, limit })}
      </p>
    </div>
  );
}
