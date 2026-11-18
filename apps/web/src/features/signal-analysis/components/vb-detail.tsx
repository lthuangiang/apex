"use client";

import { BottomSheet, Skeleton } from "@drift/ui";
import { useTranslations } from "next-intl";

import { offsetLabel, offsetMinutes } from "@/features/account/market-hours-time";

import { useVbEntry, type VbFilters } from "../api";
import { clock, day, duration, favourTone, price, signed, signedUsd } from "../format";

import { Na } from "./bits";
import { PriceLine } from "./charts";
import { BpBoxes, Panel, Stat, Timeline } from "./detail-bits";
import type { PageCtx } from "./signal-analysis-page";

// Chi tiết một lượt VB (mockup view=trade): giá quanh lượt, phí, MFE / MAE, order timeline, tín hiệu lúc vào, giá đã
// chạy trước lệnh, giá sau khi khớp và what-if phía ngược lại. Mọi số từ API.

const HZ = ["10", "30", "60", "120", "300"] as const;
const PARTS = ["momentum", "wick", "volume", "trade", "book"] as const;

export function VbEntryDetail({
  id,
  f,
  ctx,
  onClose,
}: {
  id: string | null;
  f: VbFilters;
  ctx: PageCtx;
  onClose: () => void;
}) {
  const t = useTranslations("signalAnalysis.detail");
  const tv = useTranslations("signalAnalysis.vb");
  const th = useTranslations("signalAnalysis.hz");
  const q = useVbEntry(id, f, ctx.tz);
  const d = q.data;
  const zone = ctx.utc ? "UTC" : offsetLabel(offsetMinutes(ctx.tz, new Date()));
  const title =
    d === undefined
      ? t("vbTitleLoading")
      : t("vbTitle", {
          side: tv(`sides.${d.entry.side}`),
          when: `${day(d.entry.filledAt, ctx.tz)} ${clock(d.entry.filledAt, ctx.tz)}`,
          zone,
        });
  const na = t("na");
  const entryAt = d === undefined ? 0 : Date.parse(d.entry.filledAt);
  return (
    <BottomSheet
      open={id !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={title}
      description={t("vbSub")}
      closeLabel={t("close")}
      wide
      fullScreen
    >
      {q.isPending ? (
        <Skeleton className="h-64" />
      ) : q.isError || d === undefined ? (
        <p role="alert" className="m-0 text-sm text-ink-2">
          {t("error")}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="flex min-w-0 flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label={t("entry")}
                value={price(d.entryPrice)}
                sub={clock(d.entry.filledAt, ctx.tz)}
              />
              <Stat
                label={t("exit")}
                value={d.exitPrice === null ? <Na /> : price(d.exitPrice)}
                sub={d.exitAt === null ? undefined : clock(d.exitAt, ctx.tz)}
              />
              <Stat
                label={t("held")}
                value={d.heldSecs === null ? <Na /> : duration(d.heldSecs)}
                sub={d.entry.exit === null ? na : tv(`exits.${d.entry.exit}`)}
              />
              <Stat
                label={t("netPnl")}
                value={d.netPnl === null ? <Na /> : `${signedUsd(d.netPnl)} USDC`}
                tone={favourTone(d.netPnl === null ? null : Number(d.netPnl))}
                sub={t("on", { usd: Number(d.notional).toFixed(2) })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <h3 className="m-0 text-[13px] font-extrabold">
                {t("priceAround")}{" "}
                <span className="font-semibold text-muted">
                  · {d.entry.market} · {d.entry.botName}
                </span>
              </h3>
              {d.candles.length === 0 ? (
                <p className="m-0 text-[13px] text-muted">{t("noPrices")}</p>
              ) : (
                <PriceLine
                  label={t("vbChartAria", {
                    entry: price(d.entryPrice),
                    exit: d.exitPrice === null ? na : price(d.exitPrice),
                  })}
                  points={d.candles.map((k) => ({ t: Date.parse(k.t) + 60_000, p: Number(k.c) }))}
                  hlines={[
                    { p: Number(d.entryPrice), label: price(d.entryPrice), tone: "stroke-ink" },
                    ...(d.exitPrice === null
                      ? []
                      : [
                          { p: Number(d.exitPrice), label: price(d.exitPrice), tone: "stroke-neg" },
                        ]),
                  ]}
                  zones={[
                    ...(d.orderAt === null
                      ? []
                      : [
                          {
                            from: Date.parse(d.orderAt) - 3 * 60_000,
                            to: Date.parse(d.orderAt),
                            fill: "fill-warn-bg",
                          },
                        ]),
                    ...(d.exitAt === null
                      ? []
                      : [{ from: entryAt, to: Date.parse(d.exitAt), fill: "fill-accent-tint" }]),
                  ]}
                  marks={[
                    { t: entryAt, p: Number(d.entryPrice), fill: "fill-ink" },
                    ...(d.exitAt === null || d.exitPrice === null
                      ? []
                      : [{ t: Date.parse(d.exitAt), p: Number(d.exitPrice), fill: "fill-neg" }]),
                  ]}
                  tickLabel={(ms) => clock(new Date(ms).toISOString(), ctx.tz, false)}
                />
              )}
              <div className="flex flex-wrap gap-x-4 text-xs text-ink-2">
                <span>{t("legend3min")}</span>
                <span>{t("legendHeld")}</span>
                <span>{t("legendClose")}</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label={t("pricePnl")}
                value={d.pricePnl === null ? <Na /> : `${signedUsd(d.pricePnl)} USDC`}
                tone={favourTone(d.pricePnl === null ? null : Number(d.pricePnl))}
                sub={d.pricePnlBp === null ? undefined : `${signed(d.pricePnlBp)} bp`}
              />
              <Stat
                label={t("fees")}
                value={`${signedUsd(d.fees)} USDC`}
                tone="text-neg"
                sub={d.feesBp === null ? undefined : `${signed(d.feesBp)} bp`}
              />
              <Stat
                label="MFE"
                value={d.mfePct === null ? <Na /> : `${d.mfePct.toFixed(3)}%`}
                sub={t("mfe")}
              />
              <Stat
                label="MAE"
                value={d.maePct === null ? <Na /> : `${d.maePct.toFixed(3)}%`}
                sub={t("mae")}
              />
            </div>
            <Panel title={t("timeline")}>
              <Timeline items={d.timeline} tz={ctx.tz} />
            </Panel>
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <Panel
              title={t("signalAtEntry")}
              tag={
                d.entry.entryType === null ? undefined : (
                  <span className="rounded-full bg-accent-tint px-2 py-0.5 text-[11.5px] font-bold text-accent-ink">
                    {tv(`types.${d.entry.entryType}`)}
                  </span>
                )
              }
            >
              {d.signal === null ? (
                <p className="m-0 text-[13px] text-muted">{t("noSignal")}</p>
              ) : (
                <>
                  <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[13px]">
                    <dt>{t("score")}</dt>
                    <dd className="m-0 text-right font-bold">
                      {d.signal.score === null ? "—" : Math.round(d.signal.score)}
                    </dd>
                    <dt>{t("regime")}</dt>
                    <dd className="m-0 text-right font-bold">{tv(`regimes.${d.signal.regime}`)}</dd>
                    <dt>{t("spreadAtEntry")}</dt>
                    <dd className="m-0 text-right font-bold">
                      {d.signal.spreadBp === null ? na : `${d.signal.spreadBp.toFixed(1)} bp`}
                    </dd>
                  </dl>
                  <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                    {PARTS.map((p) => {
                      const v = d.signal?.parts[p] ?? 50;
                      const neutral = p === "trade";
                      return (
                        <li
                          key={p}
                          className="grid grid-cols-[1fr_96px_34px] items-center gap-2 text-[13px]"
                        >
                          <span>
                            {tv(`parts.${p}`)}
                            <span className="block text-[11.5px] text-muted">
                              {t(`weight.${p}`)}
                            </span>
                          </span>
                          <span
                            role="img"
                            aria-label={t("partAria", {
                              part: tv(`parts.${p}`),
                              v: neutral ? 50 : v,
                            })}
                            className="relative h-2 rounded-full bg-surface"
                          >
                            <span
                              className={`absolute inset-y-0 left-0 rounded-full ${neutral ? "bg-border" : "bg-accent"}`}
                              style={{ width: `${String(v)}%` }}
                            />
                          </span>
                          <span className="text-right font-bold">{neutral ? "—" : v}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="m-0 text-xs text-muted">{t("partsNote")}</p>
                </>
              )}
            </Panel>
            <Panel title={t("moveBefore")}>
              <BpBoxes
                items={(["m1", "m3", "m5"] as const).map((k, i) => ({
                  label: th((["60", "180", "300"] as const)[i] ?? "60"),
                  v: d.moveBefore[k],
                  all: d.moveBeforeAll[k],
                  mark: (d.moveBefore[k] ?? 0) >= 4,
                }))}
              />
            </Panel>
            <Panel title={t("priceAfter")}>
              <BpBoxes
                items={HZ.map((h, i) => ({
                  label: th(h),
                  v: d.markouts[i] ?? null,
                  all: d.markoutsAll[i] ?? null,
                }))}
              />
              <p className="m-0 text-xs text-muted">{t("vbAfterNote")}</p>
            </Panel>
            <Panel
              title={t("opposite")}
              tag={
                <span className="rounded-full bg-warn-bg px-2 py-0.5 text-[11.5px] font-bold text-warn">
                  {t("whatIf")}
                </span>
              }
            >
              {d.opposite === null ? (
                <p className="m-0 text-[13px] text-muted">{t("noOpposite")}</p>
              ) : (
                <>
                  <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[13px]">
                    <dt>
                      {t("oppLine", {
                        side: tv(`sides.${d.opposite.side}`),
                        entry: price(d.opposite.entry),
                        exit: price(d.opposite.exit),
                      })}
                    </dt>
                    <dd
                      className={`m-0 text-right font-bold ${favourTone(Number(d.opposite.pricePnl))}`}
                    >
                      {signedUsd(d.opposite.pricePnl)}
                    </dd>
                    <dt>{t("fees")}</dt>
                    <dd className="m-0 text-right font-bold text-neg">
                      {signedUsd(d.opposite.fees)}
                    </dd>
                    <dt className="font-bold">{t("net")}</dt>
                    <dd
                      className={`m-0 text-right font-extrabold ${favourTone(Number(d.opposite.net))}`}
                    >
                      {signedUsd(d.opposite.net)}
                      {d.opposite.netBp === null ? null : (
                        <span className="font-semibold text-muted">
                          {" "}
                          · {signed(d.opposite.netBp)} bp
                        </span>
                      )}
                    </dd>
                  </dl>
                  <p className="m-0 text-xs text-muted">{tv("assumption")}</p>
                </>
              )}
            </Panel>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}
