"use client";

import { Skeleton } from "@drift/ui";
import { useTranslations } from "next-intl";
import { useId, useState, type ReactNode } from "react";

import { shortAddress } from "@/lib/format";

import {
  formatCoefficient,
  formatCount,
  formatDayTime,
  formatTokenAmount,
  formatUsd,
  levelDotClass,
  secToMs,
  sortByCoefficient,
} from "../format";
import { useRewardsFeed, useRewardsVolumeWeights, useRewardsWeekInfo } from "../queries";

// Dữ liệu công khai của SoDEX rewards (bản phác 08, 09): tuần hiện tại (`sopoints/week/info`), cặp có hệ số nhân
// (`sopoints/volume-weights`), live feed (`lottery/feed`). Đọc được cả khi chưa ký.

export const CARD =
  "flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface px-5 py-[18px]";

/**
 * `weekStatus` của SoDEX là chuỗi ([confirm] danh sách giá trị). Chỉ hiện "LIVE" khi giá trị nói rõ tuần đang chạy;
 * giá trị khác thì không hiện nhãn (không đoán).
 */
export function weekIsLive(status: string | null | undefined): boolean {
  return status != null && /^(live|ongoing|active|open|in[_\s-]?progress|running)$/i.test(status);
}

export function LivePill() {
  const t = useTranslations("rewards.week");
  return (
    <span className="inline-flex flex-none items-center gap-1.5 rounded-full bg-pos-bg px-2 py-0.5 text-[11px] font-extrabold text-pos">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-pos-dot" />
      {t("live")}
    </span>
  );
}

function Missing() {
  const tm = useTranslations("common.missing");
  return <span className="font-semibold text-ink-2">{tm("notAvailable")}</span>;
}

/** Giá trị đã định dạng, hoặc "Not available" khi SoDEX không trả (quy tắc 8). */
export function Value({ text }: { text: string | null | undefined }) {
  return text == null || text === "" ? <Missing /> : <>{text}</>;
}

/**
 * Thẻ không có dữ liệu vì lỗi: chỉ ghi "Not available"; lý do và nút thử lại nằm ở một dải chung của trang
 * (`RewardsProblem`), để 429 chỉ đếm ngược ở một chỗ.
 */
export function CardUnavailable() {
  return (
    <p className="m-0 text-sm">
      <Missing />
    </p>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-6 w-full" />
      ))}
    </div>
  );
}

function H({ id, children, big }: { id: string; children: ReactNode; big?: boolean }) {
  return (
    <h2
      id={id}
      className={`m-0 font-extrabold ${big === true ? "text-[22px] leading-tight" : "text-lg"}`}
    >
      {children}
    </h2>
  );
}

/** "This week on SoDEX" (bản phác 08). */
export function WeekCard({ tz }: { tz: string }) {
  const t = useTranslations("rewards.week");
  const q = useRewardsWeekInfo();
  const id = useId();
  const w = q.data;
  const rows: [string, string | null][] =
    w === undefined
      ? []
      : [
          [t("week"), w.weekName],
          [t("pool"), formatCount(w.weekPoolPoints)],
          [t("ends"), formatDayTime(secToMs(w.nextWeekStartTime), tz)],
          [t("next"), formatDayTime(secToMs(w.distributionTime), tz)],
        ];
  return (
    <section aria-labelledby={id} className={CARD}>
      <div className="flex items-center justify-between gap-2">
        <H id={id}>{t("title")}</H>
        {w !== undefined && weekIsLive(w.weekStatus) ? <LivePill /> : null}
      </div>
      {q.isPending && q.fetchStatus !== "idle" ? (
        <ListSkeleton rows={4} />
      ) : w === undefined ? (
        <CardUnavailable />
      ) : (
        <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm tabular-nums">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink-2">{k}</dt>
              <dd className="m-0 text-right font-bold">
                <Value text={v} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      <span className="mt-auto text-xs text-muted">{t("public")}</span>
    </section>
  );
}

const MARKETS_SHOWN = 4;

/** "Markets with a volume multiplier": hệ số cao nhất trước, bằng nhau theo thứ tự SoDEX (quyết định PM). */
export function MultipliersCard({
  tz,
  shown = MARKETS_SHOWN,
  big = false,
}: {
  tz: string;
  shown?: number;
  big?: boolean;
}) {
  const t = useTranslations("rewards.multipliers");
  const q = useRewardsVolumeWeights();
  const id = useId();
  const listId = useId();
  const [all, setAll] = useState(false);
  const v = q.data;
  const weights = v === undefined ? [] : sortByCoefficient(v.weights);
  const visible = all ? weights : weights.slice(0, shown);
  return (
    <section aria-labelledby={id} className={CARD}>
      <H id={id} big={big}>
        {t("title")}
      </H>
      {q.isPending && q.fetchStatus !== "idle" ? (
        <ListSkeleton rows={shown} />
      ) : v === undefined ? (
        <CardUnavailable />
      ) : (
        <>
          <p className="m-0 text-sm text-ink-2">
            {t("setBy", {
              round: v.round.round_id,
              time: formatDayTime(v.round.end_ts_ms, tz) ?? "",
            })}
          </p>
          {weights.length === 0 ? (
            <p className="m-0 text-sm text-ink-2">{t("empty")}</p>
          ) : (
            <ul id={listId} className="m-0 flex list-none flex-col p-0 text-sm tabular-nums">
              {visible.map((w, i) => (
                <li
                  key={`${w.market_type}:${w.symbol}:${String(i)}`}
                  className="flex min-h-[46px] items-center justify-between gap-3 border-b border-border last:border-b-0"
                >
                  <span className="min-w-0 truncate">
                    <b className="font-bold">{w.symbol}</b>{" "}
                    <span className="text-xs text-muted">{w.market_type}</span>
                  </span>
                  <span className="flex-none rounded-full bg-accent-tint px-2.5 py-0.5 text-xs font-extrabold text-accent-ink">
                    <Value text={formatCoefficient(w.coefficient)} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {weights.length > shown ? (
            <button
              type="button"
              aria-expanded={all}
              aria-controls={listId}
              onClick={() => {
                setAll(!all);
              }}
              className="min-h-tap self-start text-sm font-bold text-accent-ink"
            >
              {all ? t("showLess") : t("showAll", { count: weights.length })}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

const FEED_SHOWN = 3;

/** "Live feed": các lần mở lớn gần đây trên SoDEX (công khai, ví đã được SoDEX rút gọn). */
export function FeedCard({ tz }: { tz: string }) {
  const t = useTranslations("rewards.feed");
  const q = useRewardsFeed();
  const id = useId();
  const items = (q.data?.items ?? []).slice(0, FEED_SHOWN);
  return (
    <section aria-labelledby={id} className={CARD}>
      <H id={id}>{t("title")}</H>
      <p className="m-0 text-sm text-ink-2">{t("body")}</p>
      {q.isPending && q.fetchStatus !== "idle" ? (
        <ListSkeleton rows={FEED_SHOWN} />
      ) : q.data === undefined ? (
        <CardUnavailable />
      ) : items.length === 0 ? (
        <p className="m-0 text-sm text-ink-2">{t("empty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0 text-sm tabular-nums">
          {items.map((it) => {
            const amount = formatTokenAmount(it.reward?.amount);
            const usd = formatUsd(it.rewardUsd);
            return (
              <li
                key={`${String(it.tokenId)}:${String(it.tsMs)}`}
                className="flex items-start justify-between gap-3 border-b border-border py-2.5 last:border-b-0"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    <b className="font-bold">
                      {it.wallet.startsWith("0x") && it.wallet.length > 12
                        ? shortAddress(it.wallet)
                        : it.wallet}
                    </b>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1.5 font-extrabold">
                      <span
                        aria-hidden="true"
                        className={`size-3 rounded-[4px] ${levelDotClass(it.level)}`}
                      />
                      {it.level}
                    </span>
                    {it.pfp === true ? (
                      <span className="rounded-full bg-unknown-bg px-1.5 py-px text-[11px] font-extrabold text-unknown">
                        {t("pfp")}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted">{formatDayTime(it.tsMs, tz)}</span>
                </span>
                <span className="flex flex-none flex-col items-end gap-0.5">
                  <b className="font-bold">
                    {amount === null || it.reward == null ? (
                      <Missing />
                    ) : (
                      `${amount} ${it.reward.asset.symbol}`
                    )}
                  </b>
                  {usd === null ? null : <span className="text-xs text-muted">{usd}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
