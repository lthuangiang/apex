"use client";

import { ErrorState, Skeleton } from "@drift/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { useMarketNames } from "@/lib/markets";

import { plain, signed, useMmMarkout } from "../mm-cost";

// Trading Agent của bot Market Making (artboard MM-Markout, DEC-227): Price PnL đến từ đâu, đo trên fill thật
// của chính bot 24 giờ qua, và "Ways to lower it" (mở Edit điền sẵn, người dùng tự lưu). Thiếu số → "Not available".

function Tile({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[12px] bg-surface-2 px-3.5 py-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="m-0 text-lg font-extrabold tabular-nums">{value}</dd>
      {note === undefined ? null : <dd className="m-0 text-xs text-ink-2">{note}</dd>}
    </div>
  );
}

export function MmMarkoutCard({
  botId,
  config,
}: {
  botId: string;
  /** Config đang chạy của bot: hiện trạng thái thật của từng cài đặt; null = chưa biết (không hiện). */
  config: Record<string, unknown> | null;
}) {
  const t = useTranslations("agent.mmMarkout");
  const tm = useTranslations("common.missing");
  const te = useTranslations("common.errors");
  const tf = useTranslations("createBot.fields");
  const names = useMarketNames();
  const q = useMmMarkout(botId);
  const m = q.data;
  const na = tm("notAvailable");
  const level = typeof config?.quoteLevel === "number" ? config.quoteLevel : null;
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

      <section
        aria-labelledby="mm-ways-title"
        className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4 sm:p-[22px]"
      >
        <h2 id="mm-ways-title" className="m-0 text-base font-extrabold">
          {t("ways.title")}
        </h2>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          <li>
            <Link
              href={`/bots/${botId}/edit?suggest=quote-back`}
              className="flex min-h-tap flex-col gap-0.5 rounded-[12px] border border-border px-3.5 py-3 text-ink no-underline hover:bg-surface-2"
            >
              <strong className="text-sm">{t("ways.quoteBack")}</strong>
              <span className="text-[13px] text-ink-2">{t("ways.quoteBackBody")}</span>
              <span className="text-xs text-muted">
                {level === null
                  ? t("ways.setting", { name: tf("quoteLevel.label") })
                  : t("ways.settingValue", { name: tf("quoteLevel.label"), value: level })}
              </span>
            </Link>
          </li>
          {([["pause-fast", "pauseFast", "pauseOnFastMoves"]] as const).map(
            ([suggest, key, field]) => (
              <li key={suggest}>
                <Link
                  href={`/bots/${botId}/edit?suggest=${suggest}`}
                  className="flex min-h-tap flex-col gap-0.5 rounded-[12px] border border-border px-3.5 py-3 text-ink no-underline hover:bg-surface-2"
                >
                  <strong className="text-sm">{t(`ways.${key}`)}</strong>
                  <span className="text-[13px] text-ink-2">{t(`ways.${key}Body`)}</span>
                  {config === null ? null : (
                    // Trạng thái thật theo config của bot (không dùng nhãn "New setting" của artboard).
                    <span
                      className={`self-start rounded-full px-2 py-[2px] text-[11px] font-extrabold ${
                        config[field] === true ? "bg-pos-bg text-pos" : "bg-surface-2 text-ink-2"
                      }`}
                    >
                      {config[field] === true ? t("ways.on") : t("ways.off")}
                    </span>
                  )}
                </Link>
              </li>
            ),
          )}
          <li>
            <Link
              href="/bots/new/volume_maker"
              className="flex min-h-tap flex-col gap-0.5 rounded-[12px] border border-border px-3.5 py-3 text-ink no-underline hover:bg-surface-2"
            >
              <strong className="text-sm">{t("ways.cheaper")}</strong>
              <span className="text-[13px] text-ink-2">{t("ways.cheaperBody")}</span>
              <span className="text-xs font-bold text-accent-ink">{t("ways.compare")}</span>
            </Link>
          </li>
        </ul>
        <p className="m-0 text-xs text-ink-2">{t("ways.note")}</p>
      </section>
    </div>
  );
}
