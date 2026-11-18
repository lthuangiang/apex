"use client";

import { BottomSheet, Skeleton } from "@drift/ui";
import { useTranslations } from "next-intl";

import { offsetLabel, offsetMinutes } from "@/features/account/market-hours-time";

import { useMmFill, type MmFilters } from "../api";
import { clock, day, favourTone, price, signed, signedUsd } from "../format";

import { Na } from "./bits";
import { PriceLine } from "./charts";
import { BpBoxes, Panel, Stat, Timeline } from "./detail-bits";
import type { PageCtx } from "./signal-analysis-page";

// Chi tiết một fill Market Making (mockup view=fill): giá quanh fill (mid theo giây khi còn, nếu không thì nến 1 phút),
// báo giá lúc fill, giá sau khi khớp, tiền đi đâu sau 1 phút, order timeline. Mọi số từ API.

const HZ = ["0", "10", "30", "60", "120", "300"] as const;

export function MmFillDetail({
  id,
  f,
  ctx,
  onClose,
}: {
  id: string | null;
  f: MmFilters;
  ctx: PageCtx;
  onClose: () => void;
}) {
  const t = useTranslations("signalAnalysis.detail");
  const tm = useTranslations("signalAnalysis.mm");
  const th = useTranslations("signalAnalysis.hz");
  const q = useMmFill(id, f, ctx.tz);
  const d = q.data;
  const zone = ctx.utc ? "UTC" : offsetLabel(offsetMinutes(ctx.tz, new Date()));
  const na = t("na");
  const title =
    d === undefined
      ? t("mmTitleLoading")
      : t("mmTitle", {
          side: tm(`sides.${d.fill.side}`),
          when: `${day(d.fill.filledAt, ctx.tz)} ${clock(d.fill.filledAt, ctx.tz)}`,
          zone,
        });
  const at = d === undefined ? 0 : Date.parse(d.fill.filledAt);
  const q0 = d?.quote;
  return (
    <BottomSheet
      open={id !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={title}
      description={t("mmSub")}
      closeLabel={t("close")}
      wide
      fullScreen
    >
      {q.isPending ? (
        <Skeleton className="h-64" />
      ) : q.isError || d === undefined || q0 === undefined ? (
        <p role="alert" className="m-0 text-sm text-ink-2">
          {t("error")}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="flex min-w-0 flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label={t("fillPrice")}
                value={price(d.price)}
                sub={t("fillSub", {
                  side: tm(`sides.${d.fill.side}`),
                  size: d.size,
                  usd: Number(d.fill.usd).toFixed(2),
                })}
              />
              <Stat
                label={tm("kSpread")}
                value={d.fill.spread === null ? <Na /> : `${signed(d.fill.spread)} bp`}
                tone={favourTone(d.fill.spread)}
                sub={d.mid === null ? na : t("midAt", { mid: price(d.mid) })}
              />
              <Stat
                label={t("kind")}
                value={tm(`kinds.${d.fill.kind}`)}
                sub={
                  d.fill.level === null
                    ? undefined
                    : tm(`levels.${String(Math.min(3, d.fill.level)) as "0"}`)
                }
              />
              <Stat
                label={t("net1m")}
                value={d.split.net === null ? <Na /> : `${signedUsd(d.split.net, 4)} USDC`}
                tone={favourTone(d.split.net === null ? null : Number(d.split.net))}
                sub={d.fill.netAfterFees === null ? undefined : `${signed(d.fill.netAfterFees)} bp`}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <h3 className="m-0 text-[13px] font-extrabold">
                {t("priceAroundFill")}{" "}
                <span className="font-semibold text-muted">
                  · {d.fill.market} · {d.fill.botName}
                </span>
              </h3>
              {d.prices.length === 0 ? (
                <p className="m-0 text-[13px] text-muted">{t("noPrices")}</p>
              ) : (
                <PriceLine
                  label={t("mmChartAria", { price: price(d.price) })}
                  points={d.prices.map((p) => ({
                    t: Date.parse(p.t) + (d.priceSource === "candles" ? 60_000 : 0),
                    p: Number(p.p),
                  }))}
                  hlines={[{ p: Number(d.price), label: price(d.price), tone: "stroke-ink" }]}
                  zones={[{ from: at, to: at + 60_000, fill: "fill-accent-tint" }]}
                  marks={[{ t: at, p: Number(d.price), fill: "fill-ink" }]}
                  tickLabel={(ms) => clock(new Date(ms).toISOString(), ctx.tz, false)}
                />
              )}
              <p className="m-0 text-xs text-muted">
                {d.priceSource === "mid" ? t("sourceMid") : t("sourceCandles")}
              </p>
            </div>
            <Panel title={t("timeline")}>
              <Timeline items={d.timeline} tz={ctx.tz} />
            </Panel>
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <Panel title={t("quoteAtFill")}>
              <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[13px]">
                <dt>{tm("whereToQuote")}</dt>
                <dd className="m-0 text-right font-bold">
                  {q0.level === null
                    ? na
                    : tm(`levelsLong.${String(Math.min(3, q0.level)) as "0"}`)}
                </dd>
                <dt>{tm("smart")}</dt>
                <dd className="m-0 text-right font-bold">
                  {q0.smart === null ? na : tm(`onOff.${q0.smart ? "on" : "off"}`)}
                </dd>
                <dt>{t("clamp")}</dt>
                <dd className="m-0 text-right font-bold">
                  {q0.clamp === null
                    ? na
                    : q0.clamp === "hit"
                      ? t("clampHit")
                      : q0.insideLimitBp === null
                        ? t("clampNot")
                        : t("clampNotInside", { bp: q0.insideLimitBp.toFixed(1) })}
                </dd>
                <dt>{t("spreadAtQuote")}</dt>
                <dd className="m-0 text-right font-bold">
                  {q0.spreadBp === null ? na : `${q0.spreadBp.toFixed(1)} bp`}
                </dd>
                <dt>{t("onBook")}</dt>
                <dd className="m-0 text-right font-bold">
                  {q0.bookSecs === null ? na : `${q0.bookSecs.toFixed(1)} s`}
                </dd>
                <dt>{t("position")}</dt>
                <dd className="m-0 text-right font-bold">
                  {q0.positionBefore === null
                    ? na
                    : q0.positionOrders === null
                      ? q0.positionBefore
                      : t("positionOrders", { v: q0.positionOrders.toFixed(1) })}
                </dd>
              </dl>
            </Panel>
            <Panel title={t("priceAfter")}>
              <BpBoxes
                items={HZ.map((h, i) => ({
                  label: th(h),
                  v: d.markouts[i] ?? null,
                  all: d.markoutsAll[i] ?? null,
                }))}
              />
              <p className="m-0 text-xs text-muted">{t("mmAfterNote")}</p>
            </Panel>
            <Panel title={t("where")}>
              <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[13px]">
                <dt className="text-muted">
                  <span className="sr-only">{t("item")}</span>
                </dt>
                <dd className="m-0 text-right text-xs font-bold text-muted">USDC</dd>
                <dt>{t("splitSpread")}</dt>
                <dd
                  className={`m-0 text-right font-bold ${favourTone(d.split.spread === null ? null : Number(d.split.spread))}`}
                >
                  {d.split.spread === null ? <Na /> : signedUsd(d.split.spread, 4)}
                </dd>
                <dt>{t("splitAgainst")}</dt>
                <dd
                  className={`m-0 text-right font-bold ${favourTone(d.split.priceAgainst === null ? null : Number(d.split.priceAgainst))}`}
                >
                  {d.split.priceAgainst === null ? <Na /> : signedUsd(d.split.priceAgainst, 4)}
                </dd>
                <dt>{t("splitSodex")}</dt>
                <dd className="m-0 text-right font-bold text-neg">
                  {signedUsd(d.split.sodexFee, 4)}
                </dd>
                <dt>{t("splitBuilder")}</dt>
                <dd className="m-0 text-right font-bold text-neg">
                  {signedUsd(d.split.builderFee, 4)}
                </dd>
                <dt className="font-bold">{t("splitNet")}</dt>
                <dd
                  className={`m-0 text-right font-extrabold ${favourTone(d.split.net === null ? null : Number(d.split.net))}`}
                >
                  {d.split.net === null ? <Na /> : signedUsd(d.split.net, 4)}
                </dd>
              </dl>
            </Panel>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}
