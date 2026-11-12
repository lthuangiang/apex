"use client";

import { platformStatsSchema } from "@drift/shared";
import { MetricCard, SegmentedControl } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { api, ApiError } from "@/lib/api";
import { formatDate, formatDateTime, formatInteger, formatMoney } from "@/lib/format";

import { EquityChart } from "./charts";
import { ConnectFunnel } from "./connect-log";
import { Activation, Health, Insights, Kpis, Stops, Strategies } from "./stats-overview";

// Platform Stats (chỉ role `team`; DEC-98, DEC-139): insight tự sinh và tổng quan ở trên, số chi tiết ở dưới.
// Volume = notional (price × size) của fills; fees = builder fee. Không bao giờ hiện 0 khi thiếu.

const PERIODS = [
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
] as const;

export function StatsPage() {
  const t = useTranslations("platformStats");
  const tm = useTranslations("common.missing");
  const [period, setPeriod] = useState<string>("30");

  const q = useQuery({
    queryKey: ["platform-stats", period],
    queryFn: () => api("GET", `/api/v1/admin/stats?period=${period}`, platformStatsSchema),
  });

  const v = q.data;
  const forbidden = q.error instanceof ApiError && q.error.code === "FORBIDDEN";
  const status = q.isPending ? "loading" : q.isError ? "error" : "ready";

  // Daily chart points (parseFloat OK: notional is numeric string from Postgres)
  const volPoints =
    v?.daily.map((d) => ({
      at: new Date(d.date).getTime(),
      value: parseFloat(d.volume),
    })) ?? [];

  const userPoints =
    v?.daily.map((d) => ({
      at: new Date(d.date).getTime(),
      value: d.newUsers,
    })) ?? [];

  const snapshotAt = v?.snapshotAt;

  return (
    <Workspace current="stats">
      <div className="flex flex-col gap-5">
        <PageHead title={t("title")} subtitle={t("subtitle")} />
        {forbidden ? (
          <Card>
            <p className="m-0">{t("forbidden")}</p>
          </Card>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <SegmentedControl
                label={t("period")}
                options={PERIODS}
                value={period}
                onValueChange={setPeriod}
              />
              {snapshotAt !== undefined ? (
                <p className="m-0 text-xs text-ink-2">
                  {t("snapshot", { time: formatDateTime(snapshotAt) })}
                </p>
              ) : null}
            </div>

            {/* ── Tổng quan (DEC-139): insight trước, rồi KPI, phễu, sức khoẻ, strategy, lý do dừng ── */}
            {v === undefined ? null : (
              <>
                <Insights items={v.overview.insights} />
                <Kpis o={v.overview} period={v.period} />
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                  <Activation o={v.overview} />
                  <Health o={v.overview} />
                </div>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                  <Strategies o={v.overview} period={v.period} />
                  <Stops o={v.overview} period={v.period} />
                </div>
              </>
            )}

            {v !== undefined && volPoints.length >= 2 ? (
              <Card title={t("volumeChart", { period })}>
                <EquityChart
                  points={volPoints}
                  label={t("volumeChart", { period })}
                  formatY={(n, d) => (n === 0 ? "0" : `${n.toFixed(d)} USDC`)}
                  formatX={(at) => formatDate(at)}
                  formatTip={(p) =>
                    `${formatDate(p.at)}: ${formatMoney(p.value.toFixed(2)) ?? ""} USDC`
                  }
                />
              </Card>
            ) : null}

            {v !== undefined ? <ConnectFunnel connect={v.connect} /> : null}

            <h2 className="m-0 mt-2 border-t border-border pt-5 text-lg font-extrabold">
              {t("detailsTitle")}
            </h2>

            {/* ── Users ──────────────────────────────────────────────── */}
            <section aria-labelledby="stats-users" className="flex flex-col gap-3">
              <h2 id="stats-users" className="m-0 text-base font-bold">
                {t("usersSection")}
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MetricCard
                  label={t("totalUsers")}
                  status={status}
                  emptyLabel={tm("notAvailable")}
                  value={v !== undefined ? formatInteger(v.users.total) : undefined}
                />
                <MetricCard
                  label={t("connectedUsers")}
                  status={status}
                  emptyLabel={tm("notAvailable")}
                  value={v !== undefined ? formatInteger(v.users.connected) : undefined}
                />
                <MetricCard
                  label={t("newUsers7d")}
                  status={status}
                  emptyLabel={tm("notAvailable")}
                  value={v !== undefined ? formatInteger(v.users.new7d) : undefined}
                />
                <MetricCard
                  label={t("newUsers30d")}
                  status={status}
                  emptyLabel={tm("notAvailable")}
                  value={v !== undefined ? formatInteger(v.users.new30d) : undefined}
                />
              </div>
            </section>

            {/* ── Volume ─────────────────────────────────────────────── */}
            <section aria-labelledby="stats-volume" className="flex flex-col gap-3">
              <h2 id="stats-volume" className="m-0 text-base font-bold">
                {t("volumeSection")}
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MetricCard
                  label={t("volume24h")}
                  status={status}
                  emptyLabel={tm("notAvailable")}
                  value={v !== undefined ? `${formatMoney(v.volume.h24) ?? ""} USDC` : undefined}
                />
                <MetricCard
                  label={t("volume7d")}
                  status={status}
                  emptyLabel={tm("notAvailable")}
                  value={v !== undefined ? `${formatMoney(v.volume.d7) ?? ""} USDC` : undefined}
                />
                <MetricCard
                  label={t("volume30d")}
                  status={status}
                  emptyLabel={tm("notAvailable")}
                  value={v !== undefined ? `${formatMoney(v.volume.d30) ?? ""} USDC` : undefined}
                />
                <MetricCard
                  label={t("volumeTotal")}
                  status={status}
                  emptyLabel={tm("notAvailable")}
                  value={v !== undefined ? `${formatMoney(v.volume.total) ?? ""} USDC` : undefined}
                />
              </div>
            </section>

            {/* ── Fees ───────────────────────────────────────────────── */}
            <section aria-labelledby="stats-fees" className="flex flex-col gap-3">
              <h2 id="stats-fees" className="m-0 text-base font-bold">
                {t("feesSection")}
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MetricCard
                  label={t("fees24h")}
                  status={status}
                  emptyLabel={tm("notAvailable")}
                  value={v !== undefined ? `${formatMoney(v.fees.h24) ?? ""} USDC` : undefined}
                />
                <MetricCard
                  label={t("fees7d")}
                  status={status}
                  emptyLabel={tm("notAvailable")}
                  value={v !== undefined ? `${formatMoney(v.fees.d7) ?? ""} USDC` : undefined}
                />
                <MetricCard
                  label={t("fees30d")}
                  status={status}
                  emptyLabel={tm("notAvailable")}
                  value={v !== undefined ? `${formatMoney(v.fees.d30) ?? ""} USDC` : undefined}
                />
                <MetricCard
                  label={t("feesTotal")}
                  status={status}
                  emptyLabel={tm("notAvailable")}
                  value={v !== undefined ? `${formatMoney(v.fees.total) ?? ""} USDC` : undefined}
                />
              </div>
            </section>

            {/* ── Bots ───────────────────────────────────────────────── */}
            <section aria-labelledby="stats-bots" className="flex flex-col gap-3">
              <h2 id="stats-bots" className="m-0 text-base font-bold">
                {t("botsSection")}
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <MetricCard
                  label={t("runningBots")}
                  status={status}
                  emptyLabel={tm("notAvailable")}
                  value={v !== undefined ? formatInteger(v.bots.running) : undefined}
                />
                <MetricCard
                  label={t("totalBots")}
                  status={status}
                  emptyLabel={tm("notAvailable")}
                  value={v !== undefined ? formatInteger(v.bots.total) : undefined}
                />
                <MetricCard
                  label={t("botsCreated24h")}
                  status={status}
                  emptyLabel={tm("notAvailable")}
                  value={v !== undefined ? formatInteger(v.bots.created24h) : undefined}
                />
              </div>
            </section>

            {/* ── Charts ─────────────────────────────────────────────── */}
            {v !== undefined && userPoints.length >= 2 ? (
              <Card title={t("usersChart", { period })}>
                <EquityChart
                  points={userPoints}
                  label={t("usersChart", { period })}
                  formatY={(n) => formatInteger(Math.round(n))}
                  formatX={(at) => formatDate(at)}
                  formatTip={(p) =>
                    `${formatDate(p.at)}: ${formatInteger(Math.round(p.value))} new users`
                  }
                />
              </Card>
            ) : null}
          </>
        )}
      </div>
    </Workspace>
  );
}
