"use client";

import { ErrorState, Skeleton } from "@drift/ui";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { useMarketNames } from "@/lib/markets";

import { plain, signed, useMmMarkout } from "../mm-cost";

// Trading Agent của bot Market Making (artboard MM-Markout, DEC-227): Price PnL đến từ đâu, đo trên fill thật
// của chính bot 24 giờ qua. Thiếu số → "Not available". "Ways to lower it" đã ẩn (DEC-241): gợi ý chưa đúng.

function Tile({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[12px] bg-surface-2 px-3.5 py-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="m-0 text-lg font-extrabold tabular-nums">{value}</dd>
      {note === undefined ? null : <dd className="m-0 text-xs text-ink-2">{note}</dd>}
    </div>
  );
}

export function MmMarkoutCard({ botId }: { botId: string }) {
  const t = useTranslations("agent.mmMarkout");
  const tm = useTranslations("common.missing");
  const te = useTranslations("common.errors");
  const names = useMarketNames();
  const q = useMmMarkout(botId);
  const m = q.data;
  const na = tm("notAvailable");
  const bps = (v: string | null) => {
    const s = signed(v, 2);
    return s === null ? na : t("bps", { v: s });
  };

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-labelledby="mm-markout-title"
        className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4 sm:p-[22px]"
      >
        <div className="flex flex-col gap-1">
          <h2 id="mm-markout-title" className="m-0 text-base font-extrabold">
            {t("title")}
          </h2>
          <p className="m-0 text-sm text-ink-2">{t("subtitle")}</p>
        </div>
        {q.isError ? (
          <ErrorState
            title={t("error")}
            retryLabel={te("retry")}
            onRetry={() => {
              void q.refetch();
            }}
          />
        ) : m === undefined ? (
          <Skeleton className="h-40" />
        ) : (
          <>
            {m.fills === 0 ? <p className="m-0 text-sm text-ink-2">{t("noFills")}</p> : null}
            <dl className="m-0 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Tile label={t("after5")} value={bps(m.markout.s5)} />
              <Tile label={t("after30")} value={bps(m.markout.s30)} />
              <Tile label={t("after60")} value={bps(m.markout.s60)} />
            </dl>
            <dl className="m-0 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Tile
                label={t("step", { market: names.market(m.market) })}
                value={m.stepBps === null ? na : t("bps", { v: plain(m.stepBps, 2) ?? "" })}
                note={t("stepNote")}
              />
              <Tile
                label={t("losing")}
                value={
                  m.roundTrips === null
                    ? na
                    : t("losingValue", { n: m.roundTrips.losing, m: m.roundTrips.total })
                }
                {...(m.roundTrips?.losersLoseMore === true ? { note: t("losersMore") } : {})}
              />
            </dl>
            {m.inShort ? (
              <p className="m-0 rounded-[12px] bg-warn-bg px-3.5 py-3 text-sm">
                <strong>{t("inShortLead")}</strong> {t("inShort")}
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
