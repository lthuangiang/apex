"use client";

import { dec, overviewViewSchema, type OverviewView } from "@drift/shared";
import { PnLValue, Skeleton, StatusPill } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { Bot, Plus } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { NotConnected, useSodexMissing } from "@/components/not-connected";
import { Card, PageHead, Workspace } from "@/components/workspace";
import { BotProfit } from "@/features/bots/components/bot-profit";
import { useStateLabel } from "@/features/bots/components/bots-page";
import { api } from "@/lib/api";
import { formatDateTime, formatMoney } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";

import { EquityChart, Meter } from "./charts";
import { WatchlistCard } from "./watchlist-card";

// Overview (artboard "Main" / "Mobile-Home"). Mọi số đến từ backend; thiếu thì "Not available".

const PERIODS = ["1", "7", "30", "all"] as const;
const ACTIVITY_KINDS: readonly string[] = [
  "decision",
  "state",
  "version",
  "risk",
  "error",
  "fill",
  "unknown",
];
const ACTIVITY_TONE: Record<string, string> = {
  fill: "bg-pos-bg text-pos",
  unknown: "bg-unknown-bg text-unknown",
  version: "bg-accent-tint text-accent-ink",
  risk: "bg-warn-bg text-warn",
  error: "bg-neg-bg text-neg-ink",
};
type Period = (typeof PERIODS)[number];

function HeroTile({
  label,
  value,
  hint,
  loading,
}: {
  label: string;
  value: ReactNode;
  hint?: string | undefined;
  loading: boolean;
}) {
  const tm = useTranslations("common.missing");
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-tile bg-surface/80 px-4 py-3.5">
      <span className="text-xs font-semibold text-muted">{label}</span>
      {/* Số không ngắt dòng (UI_REVIEW E2); đang tải là skeleton, không phải "Not available" (E1.3). */}
      <span className="text-base font-extrabold whitespace-nowrap sm:text-lg lg:text-xl">
        {loading ? (
          <Skeleton className="h-7 w-28" />
        ) : value === null ? (
          <span className="text-ink-2">{tm("notAvailable")}</span>
        ) : (
          value
        )}
      </span>
      {hint === undefined ? null : <span className="text-xs text-ink-2">{hint}</span>}
    </div>
  );
}

export function OverviewPage() {
  const t = useTranslations("overview");
  const tm = useTranslations("common.missing");
  const [period, setPeriod] = useState<Period>("1");
  const [table, setTable] = useState(false);
  const q = useQuery({
    queryKey: ["overview", period],
    queryFn: () => api("GET", `/api/v1/overview?period=${period}`, overviewViewSchema),
    refetchInterval: 15_000,
  });
  const v = q.data;
  const loading = q.isPending;
  const names = useMarketNames();
  const pf = v?.portfolio ?? null;
  const stateLabel = useStateLabel();
  const money = (x: string | null) => (x === null ? null : `${formatMoney(x) ?? ""} USDC`);
  const r = v?.risk ?? null;
  const missing = useSodexMissing();
  // Thay đổi equity trong kỳ = điểm cuối − điểm đầu của chuỗi snapshot (gồm cả nạp/rút: SoDEX không
  // có lịch sử nạp, xem "Net deposits"). Ít hơn 2 điểm thì không hiện.
  const curve = v?.equityCurve ?? [];
  const first = curve[0];
  const lastPoint = curve.at(-1);
  const change =
    curve.length < 2 || first === undefined || lastPoint === undefined
      ? null
      : (() => {
          const diff = dec(lastPoint.equity).sub(first.equity);
          return { amount: formatMoney(diff.toString(), true) ?? diff.toString() };
        })();
  const pctOf = (cur: string | null) =>
    cur === null ? null : `${dec(cur).toDecimalPlaces(2).toString()}%`;

  return (
    <Workspace current="overview">
      <div className="flex flex-col gap-5">
        <PageHead title={t("title")} subtitle={t("subtitle")} full />
        {missing ? <NotConnected message={t("noAccount")} /> : null}

        {/* Hero (artboard Main): equity, thay đổi trong kỳ, chọn kỳ, 4 ô chỉ số nằm trong hero. */}
        <section
          aria-labelledby="equity-h"
          className="relative flex flex-wrap justify-between gap-5 overflow-hidden rounded-hero bg-hero px-6 py-6 lg:px-8"
        >
          <svg
            aria-hidden="true"
            width="320"
            height="320"
            viewBox="0 0 320 320"
            fill="none"
            className="pointer-events-none absolute -top-24 -right-20 opacity-60"
          >
            <circle cx="160" cy="160" r="80" className="stroke-surface" strokeWidth="1.5" />
            <circle cx="160" cy="160" r="128" className="stroke-surface" strokeWidth="1.5" />
          </svg>
          {/* 3 dòng thay cho 6 (người dùng góp ý cụm này quá cao): nhãn · số + thay đổi trong kỳ · chi tiết. */}
          <div className="relative flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-x-1.5 text-sm font-semibold text-ink-2">
              <span>{t("welcome")}</span>
              <span aria-hidden="true">·</span>
              <h2 id="equity-h" className="m-0 text-sm font-semibold">
                {t("equity")}
              </h2>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-2 tabular-nums">
              {pf === null ? (
                loading ? (
                  <Skeleton className="h-10 w-56" />
                ) : (
                  <span className="text-[32px] leading-none font-extrabold text-ink-2">
                    {tm("notAvailable")}
                  </span>
                )
              ) : (
                <>
                  <span className="text-[40px] leading-none font-extrabold tracking-[-0.02em] lg:text-5xl">
                    {formatMoney(pf.equity)}
                  </span>
                  <span className="text-xl font-bold text-ink-2">USDC</span>
                </>
              )}
              {change === null ? null : (
                // SoDEX không có lịch sử nạp/rút nên thay đổi equity gồm cả tiền nạp: không hiện %, màu
                // trung tính (UI_REVIEW J1, quy tắc 1.8).
                <span className="inline-flex items-baseline gap-1.5 rounded-full bg-surface/70 px-3 py-1 text-[13px] sm:ml-2">
                  <strong className="font-bold text-ink">
                    {t("change", { amount: change.amount })}
                  </strong>
                  <span className="font-medium text-ink-2">{t(`periodWord.${period}`)}</span>
                </span>
              )}
            </div>
            {pf === null ? null : (
              <span className="text-[13px] font-medium text-ink-2 tabular-nums">
                {t("equitySplit", {
                  spot: formatMoney(pf.accounts.spot.value) ?? "",
                  perps:
                    pf.accounts.perps === null
                      ? tm("notAvailable")
                      : (formatMoney(pf.accounts.perps.accountValue) ?? ""),
                })}
                {change === null ? null : ` · ${t("changeLabel")}`}
              </span>
            )}
          </div>
          <div className="relative flex flex-col items-end gap-3.5">
            <div
              role="group"
              aria-label={t("periodsLabel")}
              className="flex gap-1 rounded-[14px] bg-surface/70 p-1"
            >
              {PERIODS.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={period === p}
                  className={`min-h-9 min-w-[52px] rounded-[10px] px-3 text-[13px] font-bold ${period === p ? "bg-ink text-surface" : "text-ink-2"}`}
                  onClick={() => {
                    setPeriod(p);
                  }}
                >
                  {t(`periods.${p}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="relative grid basis-full grid-cols-2 gap-3 tabular-nums lg:grid-cols-[repeat(auto-fit,minmax(190px,1fr))]">
            <HeroTile
              loading={loading}
              label={t("unrealized")}
              value={
                pf === null ? null : (
                  <PnLValue
                    value={pf.unrealizedPnl}
                    locale="en-US"
                    missingLabel={tm("notAvailable")}
                    suffix=" USDC"
                  />
                )
              }
              hint={
                pf === null || !dec(pf.equity).gt(0)
                  ? undefined
                  : t("ofEquity", {
                      pct: dec(pf.unrealizedPnl)
                        .div(pf.equity)
                        .mul(100)
                        .toDecimalPlaces(2)
                        .toString(),
                    })
              }
            />
            <HeroTile
              loading={loading}
              label={t("realized")}
              value={
                v?.realizedPnl == null ? null : (
                  <PnLValue
                    value={v.realizedPnl}
                    locale="en-US"
                    missingLabel={tm("notAvailable")}
                    suffix=" USDC"
                  />
                )
              }
              hint={t("realizedNote")}
            />
            <HeroTile
              loading={loading}
              label={t("available")}
              value={money(pf?.available ?? null)}
              hint={t("availableNote")}
            />
            <HeroTile
              loading={loading}
              label={t("margin")}
              value={
                pf?.marginInUsePct == null
                  ? null
                  : `${dec(pf.marginInUsePct).toDecimalPlaces(1).toString()}%`
              }
              hint={
                pf === null
                  ? undefined
                  : t("marginNote", { amount: formatMoney(pf.marginInUse) ?? "" })
              }
            />
          </div>
        </section>

        <div className="flex flex-wrap items-stretch gap-5">
          <Card title={t("performance")} className="flex-[2_1_520px]">
            <span className="-mt-2 text-[13px] text-muted">
              {t("performanceCaption", { period: t(`periodWord.${period}`) })}
            </span>
            {loading ? (
              <Skeleton className="h-52 w-full" />
            ) : v === undefined || v.equityCurve.length < 2 ? (
              <p className="m-0 text-sm text-ink-2">{tm("notAvailable")}</p>
            ) : (
              <>
                <div className="flex gap-4 text-xs font-semibold text-ink-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className="h-[3px] w-4 rounded-full bg-accent" />
                    {t("equitySeries")}
                  </span>
                </div>
                <EquityChart
                  points={v.equityCurve.map((p) => ({ at: p.at, value: Number(p.equity) }))}
                  label={t("equitySeries")}
                  formatY={(y, d) =>
                    Math.abs(y) >= 10_000 && d === 0
                      ? `${(y / 1000).toLocaleString("en-US", { maximumFractionDigits: 2 })}k`
                      : y.toLocaleString("en-US", {
                          minimumFractionDigits: d,
                          maximumFractionDigits: d,
                        })
                  }
                  formatX={(at) =>
                    period === "1"
                      ? (formatDateTime(at).split(", ").at(-1)?.slice(0, 5) ?? "")
                      : (formatDateTime(at).split(", ")[0] ?? "")
                  }
                  formatTip={(p) =>
                    `${formatDateTime(p.at)} · ${formatMoney(String(p.value)) ?? ""} USDC`
                  }
                />
              </>
            )}
            <p className="m-0 text-xs text-muted">
              {t("netDeposits")}: {t("netDepositsNote")}
            </p>
            <button
              type="button"
              className="self-start text-sm font-bold text-accent-ink"
              aria-expanded={table}
              onClick={() => {
                setTable(!table);
              }}
            >
              {t("viewTable")}
            </button>
            {table && v !== undefined ? (
              <table className="text-sm tabular-nums">
                <caption className="text-left text-xs text-muted">{t("tableNote")}</caption>
                <tbody>
                  {v.equityCurve.map((p) => (
                    <tr key={p.at}>
                      <td>{formatDateTime(p.at)}</td>
                      <td className="text-right">{formatMoney(p.equity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </Card>

          <AgentCard bots={v?.bots ?? []} activity={v?.activity ?? []} />
        </div>

        <div className="flex flex-wrap items-stretch gap-5">
          <div className="contents">
            <section
              aria-labelledby="risk-h"
              className="flex min-w-0 flex-[1_1_320px] flex-col gap-3.5 rounded-card border border-border bg-surface p-5"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 id="risk-h" className="m-0 text-lg font-extrabold">
                  {t("riskSnapshot")}
                </h2>
                {r === null ? null : (
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-bold ${r.breached === 0 ? "bg-pos-bg text-pos" : "bg-neg-bg text-neg-ink"}`}
                  >
                    {r.breached === 0 ? t("withinLimits") : t("breached", { n: r.breached })}
                  </span>
                )}
              </div>
              {loading ? (
                <div className="flex flex-col gap-3">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : r === null ? (
                <p className="m-0 text-sm text-ink-2">{tm("notAvailable")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-3.5 p-0 text-sm">
                  {(
                    [
                      [
                        "dailyLoss",
                        pctOf(r.dailyLossPct),
                        r.dailyLossPct,
                        r.limits.dailyLossPct,
                        "%",
                        true,
                      ],
                      [
                        "maxDd",
                        pctOf(r.drawdownPct),
                        r.drawdownPct,
                        r.limits.maxDrawdownPct,
                        "%",
                        true,
                      ],
                      [
                        "leverage",
                        r.highestLeverage === null
                          ? null
                          : `${String(r.highestLeverage.leverage)}×`,
                        r.highestLeverage === null ? null : String(r.highestLeverage.leverage),
                        r.limits.maxLeverage,
                        "×",
                        false,
                      ],
                    ] as const
                  ).map(([k, shown, cur, lim, unit, server]) => {
                    const pct =
                      cur === null || lim === null || !dec(lim).gt(0)
                        ? null
                        : dec(cur).div(lim).mul(100).toNumber();
                    // Chưa đặt giới hạn: không vẽ thanh xám đầy (không có gì để so), chỉ số + "Set limit".
                    return (
                      <li key={k} className="flex flex-col gap-1.5">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                          <span className="font-semibold text-ink">{t(k)}</span>
                          <span className="tabular-nums">
                            <strong>{shown ?? tm("notAvailable")}</strong>
                            {lim === null ? null : (
                              <span className="text-muted">
                                {" "}
                                {t(k === "leverage" ? "ofCap" : "ofLimit", {
                                  limit: `${dec(lim).toString()}${unit}`,
                                })}
                              </span>
                            )}
                          </span>
                        </div>
                        {lim === null ? null : (
                          <Meter
                            pct={pct}
                            tone={!server || (pct ?? 0) >= 80 ? "warn" : "normal"}
                            label={t(k)}
                          />
                        )}
                        <span className="flex justify-between gap-2 text-xs text-muted">
                          <span>
                            {server ? t("serverEnforced") : t("uiOnly")}
                            {lim === null ? ` · ${t("notSet")}` : null}
                          </span>
                          {lim === null ? (
                            <Link
                              href="/risk"
                              className="flex-none font-bold whitespace-nowrap text-accent-ink"
                            >
                              {t("setLimit")}
                            </Link>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <Link href="/risk" className="mt-auto text-sm font-bold">
                {t("openRisk")}
              </Link>
            </section>

            <WatchlistCard rows={v?.watchlist} loading={loading} />
          </div>
        </div>

        <section aria-labelledby="bots-h" className="flex flex-col gap-3.5">
          <div className="flex items-center justify-between gap-3">
            <h2 id="bots-h" className="m-0 text-[19px] font-bold">
              {t("myBots")}
            </h2>
            <Link
              href="/bots?tab=catalog"
              className="flex min-h-tap items-center gap-2 rounded-[14px] bg-accent px-[18px] text-sm font-bold text-white no-underline shadow-accent"
            >
              <Plus aria-hidden="true" size={16} strokeWidth={2.4} />
              {t("newBot")}
            </Link>
          </div>
          {loading ? (
            <Skeleton className="h-36 w-full rounded-card" />
          ) : (v?.bots ?? []).length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border-input bg-surface p-6 text-center">
              <span
                aria-hidden="true"
                className="flex size-12 items-center justify-center rounded-[14px] bg-accent-tint text-accent-ink"
              >
                <Bot size={24} />
              </span>
              <p className="m-0 max-w-sm text-sm text-ink-2">{t("noBots")}</p>
              <Link
                href="/bots?tab=catalog"
                className="flex min-h-tap items-center rounded-control bg-accent-tint px-[18px] text-sm font-bold text-accent-ink no-underline"
              >
                {t("agentCard.createBot")}
              </Link>
            </div>
          ) : (
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-3.5 p-0">
              {(v?.bots ?? []).map((b) => (
                <li
                  key={b.id}
                  className={`flex flex-col gap-3 rounded-[22px] border bg-surface px-[18px] py-4 ${attentionOf(stateLabel(b)) === null ? "border-border" : "border-warn-bar/50"}`}
                >
                  {/* Pill chỉ có trạng thái; lý do pause / cần chú ý nằm trong hộp riêng bên dưới (UI_REVIEW J3). */}
                  <div className="flex items-center gap-2.5">
                    <span
                      aria-hidden="true"
                      className="flex size-[34px] flex-none items-center justify-center rounded-full bg-accent-tint text-[13px] font-extrabold text-accent-ink"
                    >
                      {names.market(b.market).slice(0, 1)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <Link href={`/agent/${b.id}`} className="truncate text-[15px] font-extrabold">
                        {b.name}
                      </Link>
                      <span className="truncate text-xs text-muted">{names.market(b.market)}</span>
                    </span>
                    <StatusPill state={b.state} label={stateLabel(b).label} />
                  </div>
                  <AttentionNote text={attentionOf(stateLabel(b))} />
                  <div className="flex justify-between gap-2 tabular-nums">
                    <span className="flex flex-col">
                      <span className="text-xs text-muted">{t("investment")}</span>
                      <strong className="text-lg">
                        {b.capital === null ? tm("notAvailable") : formatMoney(b.capital)}
                      </strong>
                    </span>
                    <span className="flex flex-col items-end">
                      <span className="text-xs text-muted">{t("profit")}</span>
                      {/* "No fills yet" là chữ phụ, không in to như một con số. */}
                      <strong className={b.fills === 0 ? "text-sm font-semibold" : "text-lg"}>
                        <BotProfit bot={b} />
                      </strong>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section
          aria-labelledby="act-h"
          className="flex flex-col gap-3 rounded-card border border-border bg-surface p-5"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 id="act-h" className="m-0 text-lg font-extrabold">
              {t("activity")}
            </h2>
            <Link href="/orders" className="text-[13px] font-bold text-accent-ink">
              {t("allActivity")}
            </Link>
          </div>
          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : v === undefined || v.activity.length === 0 ? (
            <p className="m-0 text-sm text-ink-2">{t("noActivity")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col p-0 text-sm">
              {v.activity.map((e) => {
                const kind = ACTIVITY_KINDS.includes(e.type) ? e.type : "other";
                return (
                  <li
                    key={e.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-2.5 last:border-b-0"
                  >
                    <span className="w-16 text-muted tabular-nums">
                      {formatDateTime(e.occurredAt).split(", ").at(-1)}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-extrabold tracking-[0.04em] ${ACTIVITY_TONE[kind] ?? "bg-surface-2 text-ink-2"}`}
                    >
                      {t(`activityTypes.${kind}`)}
                    </span>
                    <span className="font-semibold">{e.decision ?? ""}</span>
                    <span className="text-muted">· {e.botName}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </Workspace>
  );
}

/** Lý do pause / stop (reason code) hoặc "Needs attention" của một bot; null khi không có gì cần báo. */
function attentionOf(l: { reasonLabel?: string; needsAttentionLabel?: string }): string | null {
  return l.reasonLabel ?? l.needsAttentionLabel ?? null;
}

/** Hộp vàng dưới tên bot (artboard Main, thẻ "Needs attention"), thay cho câu dài chen trong pill. */
function AttentionNote({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <p className="m-0 rounded-control bg-warn-bg px-3 py-2 text-xs leading-normal font-medium text-warn">
      {text}
    </p>
  );
}

/** Thẻ Trading Agent (artboard Main): bot đang chạy nổi bật nhất, hoặc bot cập nhật gần nhất. */
function AgentCard({
  bots,
  activity,
}: {
  bots: OverviewView["bots"];
  activity: OverviewView["activity"];
}) {
  const t = useTranslations("overview.agentCard");
  const names = useMarketNames();
  const ts = useTranslations("createBot.strategies");
  const stateLabel = useStateLabel();
  const bot =
    bots.find((b) => b.state === "running" && !b.needsAttention) ??
    bots.find((b) => b.state === "running") ??
    [...bots].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  // 3 event gần nhất của bot (cùng nguồn với Recent activity, UI_REVIEW J3) thay cho một dòng "Last action".
  const recent = bot === undefined ? [] : activity.filter((e) => e.botId === bot.id).slice(0, 3);
  const to = useTranslations("overview");
  return (
    <section
      aria-labelledby="agent-h"
      className="flex min-w-0 flex-[1_1_320px] flex-col gap-4 rounded-card border border-border bg-surface px-6 py-[22px]"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="agent-h" className="m-0 text-lg font-bold whitespace-nowrap">
          {t("title")}
        </h2>
        {bot === undefined ? null : <StatusPill state={bot.state} label={stateLabel(bot).label} />}
      </div>
      {bot === undefined ? (
        <>
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-[16px] bg-surface-2 p-5 text-center">
            <span
              aria-hidden="true"
              className="flex size-12 items-center justify-center rounded-[14px] bg-accent text-white"
            >
              <Bot size={24} />
            </span>
            <p className="m-0 text-sm text-ink-2">{t("none")}</p>
          </div>
          <Link
            href="/bots?tab=catalog"
            className="mt-auto flex min-h-tap items-center justify-center rounded-control bg-accent text-sm font-bold text-white no-underline"
          >
            {t("createBot")}
          </Link>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-[16px] bg-surface-2 p-3">
            <span
              aria-hidden="true"
              className="flex size-11 flex-none items-center justify-center rounded-[14px] bg-accent text-white"
            >
              <Bot size={22} />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[15px] font-bold">
                {ts(`${bot.strategy}.name`)} · {names.market(bot.market)}
              </span>
              <span className="text-xs text-muted tabular-nums">
                {t("updated", { time: formatDateTime(bot.updatedAt) })}
              </span>
            </div>
          </div>
          <AttentionNote text={attentionOf(stateLabel(bot))} />
          {recent.length === 0 ? (
            <p className="m-0 text-[13px] text-muted">{to("noActivity")}</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <h3 className="m-0 text-xs font-semibold text-muted">{t("recent")}</h3>
              <ul className="m-0 flex list-none flex-col p-0 text-[13px]">
                {recent.map((e) => {
                  const kind = ACTIVITY_KINDS.includes(e.type) ? e.type : "other";
                  return (
                    <li
                      key={e.id}
                      className="flex items-baseline gap-2.5 border-b border-border py-2 last:border-b-0"
                    >
                      <span className="w-11 flex-none text-muted tabular-nums">
                        {formatDateTime(e.occurredAt).split(", ").at(-1)?.slice(0, 5)}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-semibold">
                        {e.decision ?? to(`activityTypes.${kind}`)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <Link
            href={`/agent/${bot.id}`}
            className="mt-auto flex min-h-tap items-center justify-center rounded-control bg-accent-tint text-sm font-bold text-accent-ink no-underline"
          >
            {t("open")}
          </Link>
        </>
      )}
    </section>
  );
}
