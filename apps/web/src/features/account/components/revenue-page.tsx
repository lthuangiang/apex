"use client";

import { builderRevenueViewSchema, dec } from "@drift/shared";
import { DataTable, MetricCard, SegmentedControl } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { api, ApiError } from "@/lib/api";
import { formatDateTime, formatInteger, formatMoney } from "@/lib/format";

// Builder Revenue (chỉ role `team`, SODEX.md mục 5.4): doanh thu chỉ tính phần đã đối soát; phần chênh để pending.
// Không bao giờ trộn vào equity / PnL của người dùng.

function months(now: Date): string[] {
  const a = now.toISOString().slice(0, 7);
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);
  return [a, prev];
}
const monthLabel = (m: string) =>
  new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${m}-01T00:00:00Z`),
  );

export function RevenuePage() {
  const t = useTranslations("revenue");
  const tm = useTranslations("common.missing");
  const [period, setPeriod] = useState(() => months(new Date())[0] ?? "all");
  const q = useQuery({
    queryKey: ["builder-revenue", period],
    queryFn: () =>
      api("GET", `/api/v1/admin/builder-revenue?period=${period}`, builderRevenueViewSchema),
  });
  const v = q.data;
  const forbidden = q.error instanceof ApiError && q.error.code === "FORBIDDEN";
  const status = q.isPending ? "loading" : q.isError ? "error" : "ready";
  const eligible =
    v?.balances.spot != null &&
    v.balances.perps !== null &&
    dec(v.balances.spot).gte(100) &&
    dec(v.balances.perps).gte(100);

  return (
    <Workspace current="revenue">
      <div className="flex flex-col gap-5">
        <PageHead title={t("title")} subtitle={t("subtitle")} />
        {forbidden ? (
          <Card>
            <p className="m-0">{t("forbidden")}</p>
          </Card>
        ) : (
          <>
            <SegmentedControl
              label={t("period")}
              options={[
                ...months(new Date()).map((m) => ({ value: m, label: monthLabel(m) })),
                { value: "all", label: t("all") },
              ]}
              value={period}
              onValueChange={setPeriod}
            />
            {v === undefined ? null : (
              <Card title={t("account", { id: v.builderId })}>
                <span className="text-sm tabular-nums">
                  Spot{" "}
                  {v.balances.spot === null
                    ? tm("notAvailable")
                    : `${formatMoney(v.balances.spot) ?? ""} vUSDC`}{" "}
                  · Perps{" "}
                  {v.balances.perps === null
                    ? tm("notAvailable")
                    : `${formatMoney(v.balances.perps) ?? ""} vUSDC`}
                </span>
                <strong className={eligible ? "text-pos" : "text-warn"}>
                  {eligible ? t("eligible") : t("notEligible")}
                </strong>
                {v.balances.at === null ? null : (
                  <span className="text-xs text-muted">
                    {t("synced", { time: formatDateTime(v.balances.at) })}
                  </span>
                )}
              </Card>
            )}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label={t("earned")}
                status={status}
                value={v === undefined ? null : formatMoney(v.totals.recognized)}
                emptyLabel={tm("notAvailable")}
                hint={t("earnedNote")}
              />
              <MetricCard
                label={t("perps")}
                status={status}
                value={v === undefined ? null : formatMoney(v.totals.perps)}
                emptyLabel={tm("notAvailable")}
                hint={t("perpsNote")}
              />
              <MetricCard
                label={t("spot")}
                status={status}
                value={v === undefined ? null : formatMoney(v.totals.spot)}
                emptyLabel={tm("notAvailable")}
                hint={t("spotNote")}
              />
              <MetricCard
                label={t("fills")}
                status={status}
                value={
                  v === undefined
                    ? null
                    : `${formatInteger(v.totals.fills)} · ${formatMoney(v.totals.notional) ?? ""}`
                }
                emptyLabel={tm("notAvailable")}
                hint={
                  v?.totals.effectivePct == null
                    ? undefined
                    : t("effective", { pct: v.totals.effectivePct })
                }
              />
            </div>
            <p className="m-0 text-xs text-muted">{t("realtime")}</p>

            <Card title={t("reconciliation")}>
              <p className="m-0 text-xs text-muted">{t("reconNote")}</p>
              <DataTable
                caption={t("reconciliation")}
                label={t("reconciliation")}
                status={status === "ready" && v?.days.length === 0 ? "empty" : status}
                empty={{ title: t("noDays") }}
                error={{ title: tm("notAvailable") }}
                rows={v?.days ?? []}
                getRowKey={(d) => `${d.date}:${d.engine}`}
                columns={[
                  { key: "day", header: t("cols.day"), cell: (d) => d.date },
                  {
                    key: "engine",
                    header: t("cols.engine"),
                    cell: (d) => (d.engine === "perps" ? t("perps") : t("spot")),
                  },
                  {
                    key: "from",
                    header: t("cols.fromFills"),
                    numeric: true,
                    cell: (d) => formatMoney(d.fromFills),
                  },
                  {
                    key: "delta",
                    header: t("cols.delta"),
                    numeric: true,
                    cell: (d) => formatMoney(d.balanceDelta) ?? tm("notAvailable"),
                  },
                  {
                    key: "diff",
                    header: t("cols.diff"),
                    numeric: true,
                    cell: (d) => formatMoney(d.difference, true) ?? tm("notAvailable"),
                  },
                  {
                    key: "status",
                    header: t("cols.status"),
                    cell: (d) =>
                      d.status === "matched"
                        ? t("matched")
                        : d.difference === null
                          ? t("pendingNoBalance")
                          : t("pending", {
                              amount: formatMoney(dec(d.difference).abs().toString()) ?? "",
                            }),
                  },
                ]}
              />
            </Card>

            {v === undefined ? null : (
              <Card title={t("approvals")}>
                <dl className="m-0 grid grid-cols-3 gap-3 text-sm tabular-nums">
                  {(["approved", "revoked", "never"] as const).map((k) => (
                    <div key={k}>
                      <dt className="text-ink-2">{t(k)}</dt>
                      <dd className="m-0 text-lg font-bold">{formatInteger(v.approvals[k])}</dd>
                    </div>
                  ))}
                </dl>
                <p className="m-0 text-xs text-muted">{t("approvalsNote")}</p>
              </Card>
            )}
            <Card title={t("notProfit")}>
              <p className="m-0 text-sm">{t("notProfitBody")}</p>
            </Card>
          </>
        )}
      </div>
    </Workspace>
  );
}
