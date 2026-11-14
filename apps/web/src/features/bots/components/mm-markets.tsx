"use client";

import { UserRole } from "@drift/shared";
import { Button, ErrorState, Skeleton } from "@drift/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { WorkspaceShell } from "@/components/workspace-shell";
import { formatDateTime } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";
import { useMe } from "@/lib/queries";

import { compactUsd, plain, signed, sortMarkets, useMmMarketCosts, type MmSort } from "../mm-cost";

// Tạo bot Market Making, bước 1 (artboard MM-Markets, DEC-TBD-mm-cost): xếp hạng market Perps theo chi phí / $1M
// khối lượng từ 24 giờ qua. Số quá khứ, không dự báo; market chưa đủ dữ liệu hiện "Not available", xếp cuối.
// Continue mở form như hiện nay với `?market=&engine=perps`.

const HOUR = 3_600_000;

export function MmMarketsPage() {
  const t = useTranslations("createBot.mmMarkets");
  const tc = useTranslations("createBot");
  const tm = useTranslations("common.missing");
  const te = useTranslations("common.errors");
  const me = useMe();
  const router = useRouter();
  const q = useMmMarketCosts();
  const names = useMarketNames();
  const [sort, setSort] = useState<MmSort>("cost");
  const [picked, setPicked] = useState<string | null>(null);

  const data = q.data;
  const rows = data === undefined ? [] : sortMarkets(data.markets, sort);
  const cheapest = data === undefined ? undefined : sortMarkets(data.markets, "cost")[0];
  const cheapestId = cheapest?.totalCostPerMillion == null ? null : cheapest.market;
  // Mặc định chọn market rẻ nhất (artboard), người dùng đổi bằng Choose.
  const chosenId = picked ?? cheapestId;
  const chosen = rows.find((r) => r.market === chosenId);
  const na = tm("notAvailable");
  const label = (m: string) => names.market(m);
  // Dữ liệu cũ hơn 1 giờ (WS rớt…): vẫn hiện số gần nhất kèm thời điểm cập nhật.
  const staleAt =
    data?.updatedAt != null &&
    new Date(data.asOf).getTime() - new Date(data.updatedAt).getTime() > HOUR
      ? data.updatedAt
      : null;
  const builderPct =
    data === undefined ? "0.003%" : `${String(Number(data.builderFeePerMillion) / 10_000)}%`;

  return (
    <WorkspaceShell current="bots" isTeam={me.data?.role === UserRole.team}>
      <div className="flex flex-col gap-4">
        <header className="flex min-w-0 flex-col gap-1">
          <Link href="/bots" className="text-[13px] font-bold no-underline">
            {tc("back")}
          </Link>
          <h1 className="m-0 text-[26px] font-extrabold">{t("pageTitle")}</h1>
          <p className="m-0 text-sm text-ink-2">{t("step")}</p>
        </header>

        <section
          aria-labelledby="mm-markets-title"
          className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-surface p-4 sm:p-[22px]"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <h2 id="mm-markets-title" className="m-0 text-lg font-extrabold">
                {t("title")}
              </h2>
              <p className="m-0 text-sm text-ink-2">{t("subtitle")}</p>
              {staleAt === null ? null : (
                <p className="m-0 text-xs font-bold text-warn">
                  {t("updated", { time: formatDateTime(staleAt) })}
                </p>
              )}
            </div>
            <div role="group" aria-label={t("sortLabel")} className="flex gap-2">
              {(["cost", "volume"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={sort === k}
                  onClick={() => {
                    setSort(k);
                  }}
                  className={`min-h-tap rounded-control border px-3.5 text-[13px] font-bold ${
                    sort === k
                      ? "border-ink bg-ink text-surface"
                      : "border-border bg-surface text-ink hover:bg-surface-2"
                  }`}
                >
                  {t(`sort.${k}`)}
                </button>
              ))}
            </div>
          </div>

          {q.isError ? (
            <ErrorState
              title={t("error")}
              retryLabel={te("retry")}
              onRetry={() => {
                void q.refetch();
              }}
            />
          ) : data === undefined ? (
            <Skeleton className="h-64" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] border-collapse text-sm tabular-nums">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    {(["market", "step", "spread", "swing", "volume", "pnl", "total"] as const).map(
                      (c) => (
                        <th
                          key={c}
                          scope="col"
                          className={`py-2 pr-3 font-bold ${c === "market" ? "" : "text-right"}`}
                        >
                          {t(`col.${c}`)}
                        </th>
                      ),
                    )}
                    <th scope="col" className="py-2 text-right font-bold">
                      <span className="sr-only">{t("col.choose")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const on = r.market === chosenId;
                    const badge =
                      sort === "cost" && r.market === cheapestId
                        ? "cheapest"
                        : r.yourBot
                          ? "yourBot"
                          : null;
                    const pnl = signed(r.pricePnlPerMillion, 0);
                    return (
                      <tr
                        key={r.market}
                        className={`border-t border-border ${on ? "bg-accent-tint" : ""}`}
                      >
                        <th scope="row" className="py-2.5 pr-3 text-left font-extrabold">
                          {label(r.market)}
                          {badge === null ? null : (
                            <span
                              className={`ml-1.5 rounded-full px-2 py-[3px] text-[11px] font-extrabold ${
                                badge === "cheapest"
                                  ? "bg-pos-bg text-pos"
                                  : "bg-surface-2 text-ink-2"
                              }`}
                            >
                              {t(badge)}
                            </span>
                          )}
                        </th>
                        <td className="py-2.5 pr-3 text-right">
                          {r.stepBps === null ? na : t("bps", { v: plain(r.stepBps, 2) ?? "" })}
                        </td>
                        <td className="py-2.5 pr-3 text-right">
                          {r.spreadTicks === null ? na : t("steps", { n: r.spreadTicks })}
                        </td>
                        <td className="py-2.5 pr-3 text-right">
                          {r.swingBps === null ? na : t("bps", { v: plain(r.swingBps, 2) ?? "" })}
                        </td>
                        <td className="py-2.5 pr-3 text-right">{compactUsd(r.volume24h) ?? na}</td>
                        <td
                          className={`py-2.5 pr-3 text-right ${
                            pnl === null ? "" : pnl.startsWith("−") ? "text-neg-ink" : "text-pos"
                          }`}
                        >
                          {pnl ?? na}
                        </td>
                        <td className="py-2.5 pr-3 text-right font-extrabold">
                          {plain(r.totalCostPerMillion, 0) ?? na}
                        </td>
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            aria-pressed={on}
                            aria-label={`${on ? t("chosen") : t("choose")} ${label(r.market)}`}
                            onClick={() => {
                              setPicked(r.market);
                            }}
                            className={`min-h-tap rounded-control border px-3.5 text-[13px] font-bold ${
                              on
                                ? "border-accent bg-accent text-white"
                                : "border-border bg-surface text-ink hover:bg-surface-2"
                            }`}
                          >
                            {on ? t("chosen") : t("choose")}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <details className="rounded-[14px] bg-surface-2 px-4 py-3 text-sm">
            <summary className="min-h-tap cursor-pointer content-center font-bold">
              {t("how.title")}
            </summary>
            <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0 text-ink-2">
              <li>
                <strong className="text-ink">{t("how.totalLead")}</strong>{" "}
                {t("how.total", { pct: builderPct })}
              </li>
              <li>
                <strong className="text-ink">{t("how.pnlLead")}</strong> {t("how.pnl")}
              </li>
              <li>
                <strong className="text-ink">{t("how.stepLead")}</strong> {t("how.stepBody")}
              </li>
              <li>
                {t("how.swingPre")} <strong className="text-ink">{t("how.swingLead")}</strong>{" "}
                {t("how.swingBody")}
              </li>
            </ul>
          </details>
        </section>

        {chosen === undefined ? null : (
          <section
            aria-labelledby="mm-chosen-title"
            className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 sm:px-[22px]"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <h2 id="mm-chosen-title" className="m-0 text-base font-extrabold">
                {t("chosenTitle", { market: label(chosen.market) })}
              </h2>
              <p className="m-0 text-sm text-ink-2">
                {chosen.totalCostPerMillion === null
                  ? t("chosenNone")
                  : t("chosenBody", { total: plain(chosen.totalCostPerMillion, 0) ?? "" })}
              </p>
            </div>
            <Button
              onClick={() => {
                router.push(
                  `/bots/new/volume_maker?market=${encodeURIComponent(chosen.market)}&engine=perps`,
                );
              }}
            >
              {t("continue")}
            </Button>
          </section>
        )}
      </div>
    </WorkspaceShell>
  );
}
