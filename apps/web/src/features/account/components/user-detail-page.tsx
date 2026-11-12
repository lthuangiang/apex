"use client";

import { adminUserDetailSchema, type AdminUserDetail } from "@drift/shared";
import { DataTable, ErrorState, Skeleton, StatusPill } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { BotProfit, useStateLabel } from "@/features/bots";
import { api, ApiError } from "@/lib/api";
import { formatAmount, formatDate, formatDateTime, shortAddress } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";
import { useMe } from "@/lib/queries";

import { BuilderFeeCard } from "./builder-fee-card";
import { ConnectAttempts } from "./connect-log";

// Chi tiết một user cho team (DEC-93): số liệu, bot và lệnh gần đây. Chỉ đọc, trừ builder fee riêng (DEC-159);
// thao tác khác vẫn ở danh sách Users.
// api tự kiểm tra role và ghi audit mỗi lần xem.

type Bot = AdminUserDetail["bots"][number];
type Order = AdminUserDetail["orders"][number];

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-tile bg-surface-2 p-3.5">
      <span className="text-[13px] text-ink-2">{label}</span>
      <strong className="text-xl font-extrabold tabular-nums">{value}</strong>
      {note === undefined ? null : <span className="text-xs text-muted">{note}</span>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 border-b border-border py-2.5 text-sm last:border-b-0">
      <span className="text-ink-2">{label}</span>
      <span className="font-semibold">{children}</span>
    </div>
  );
}

export function UserDetailPage({ id }: { id: string }) {
  const t = useTranslations("adminUser");
  const tu = useTranslations("adminUsers");
  const tc = useTranslations("createBot");
  const tm = useTranslations("common.missing");
  const names = useMarketNames();
  const me = useMe();
  const stateLabel = useStateLabel();
  const query = useQuery({
    queryKey: ["admin-user", id],
    queryFn: () => api("GET", `/api/v1/admin/users/${id}`, adminUserDetailSchema),
    retry: false,
  });
  const v = query.data;
  const tz = me.data?.timezone;
  const money = (x: string) => formatAmount(x, 2)?.text ?? x;
  const code = query.error instanceof ApiError ? query.error.code : null;

  return (
    <Workspace current="users">
      <div className="flex flex-col gap-5">
        <Link href="/admin/users" className="text-sm font-bold text-accent-ink">
          ← {t("back")}
        </Link>
        {query.isError ? (
          <Card>
            {code === "FORBIDDEN" ? (
              <p className="m-0">{tu("forbidden")}</p>
            ) : code === "NOT_FOUND" ? (
              <p className="m-0">{t("notFound")}</p>
            ) : (
              <ErrorState
                title={tm("notAvailable")}
                retryLabel={tc("chart.retry")}
                onRetry={() => {
                  void query.refetch();
                }}
              />
            )}
          </Card>
        ) : v === undefined ? (
          <Skeleton className="h-72 w-full" />
        ) : (
          <>
            <PageHead
              title={v.user.email}
              subtitle={t("subtitle", {
                date: formatDate(Date.parse(v.user.createdAt)),
                seen:
                  v.user.lastSeenAt === null
                    ? t("never")
                    : formatDateTime(Date.parse(v.user.lastSeenAt), tz),
              })}
            />
            <Card>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-2.5">
                <Stat
                  label={t("stats.equity")}
                  value={v.user.equity === null ? tm("notAvailable") : money(v.user.equity)}
                  {...(v.stats.equityAt === null
                    ? {}
                    : {
                        note: t("stats.equityAt", {
                          time: formatDateTime(Date.parse(v.stats.equityAt), tz),
                        }),
                      })}
                />
                <Stat label={t("stats.botProfit")} value={money(v.stats.botProfit)} />
                <Stat label={t("stats.volume24h")} value={money(v.stats.volume24h)} />
                <Stat label={t("stats.volume7d")} value={money(v.stats.volume7d)} />
                <Stat label={t("stats.volumeAll")} value={money(v.stats.volumeAll)} />
                <Stat label={t("stats.fills")} value={String(v.stats.fills)} />
                <Stat label={t("stats.builderFees")} value={money(v.stats.builderFees)} />
              </div>
              <p className="m-0 text-xs text-muted">{t("profitNote")}</p>
            </Card>
            <Card>
              <h2 className="m-0 text-lg font-extrabold">{t("account")}</h2>
              <div>
                <Row label={t("sodex")}>
                  {v.user.sodex === null ? (
                    tu("notConnected")
                  ) : (
                    <span className="font-mono text-xs" title={v.user.sodex.address}>
                      {shortAddress(v.user.sodex.address)} · #{v.user.sodex.accountId} ·{" "}
                      {tu(`status.${v.user.sodex.status}`)}
                    </span>
                  )}
                </Row>
                <Row label={t("builderFee")}>
                  {v.user.builderFee === null ? tm("notAvailable") : tu(`fee.${v.user.builderFee}`)}
                </Row>
                <Row label={t("twoFactor")}>{v.user.twoFactor ? tu("on") : tu("off")}</Row>
                <Row label={t("volumeBots")}>{v.user.volumeBots ? tu("on") : tu("off")}</Row>
              </div>
            </Card>
            <BuilderFeeCard userId={id} rows={v.builderFees} />
            <ConnectAttempts connect={v.connect} tz={tz} />
            <Card>
              <h2 className="m-0 text-lg font-extrabold">{t("bots")}</h2>
              <DataTable
                caption={t("bots")}
                label={t("bots")}
                status={v.bots.length === 0 ? "empty" : "ready"}
                empty={{ title: t("noBots") }}
                error={{ title: tm("notAvailable") }}
                rows={v.bots}
                getRowKey={(b: Bot) => b.id}
                columns={[
                  { key: "name", header: t("cols.bot"), cell: (b: Bot) => b.name },
                  {
                    key: "market",
                    header: t("market"),
                    cell: (b: Bot) => b.marketLabel ?? names.market(b.market),
                  },
                  {
                    key: "strategy",
                    header: t("cols.strategy"),
                    cell: (b: Bot) => tc(`strategies.${b.strategy}.name`),
                  },
                  {
                    key: "status",
                    header: t("cols.status"),
                    cell: (b: Bot) => <StatusPill {...stateLabel(b)} />,
                  },
                  {
                    key: "profit",
                    header: t("cols.profit"),
                    numeric: true,
                    cell: (b: Bot) => <BotProfit bot={b} />,
                  },
                  {
                    key: "fills",
                    header: t("cols.fills"),
                    numeric: true,
                    cell: (b: Bot) => b.fills,
                  },
                  {
                    key: "updated",
                    header: t("cols.updated"),
                    cell: (b: Bot) => formatDateTime(Date.parse(b.updatedAt), tz),
                  },
                ]}
              />
            </Card>
            <Card>
              <h2 className="m-0 text-lg font-extrabold">{t("orders")}</h2>
              <DataTable
                caption={t("orders")}
                label={t("orders")}
                status={v.orders.length === 0 ? "empty" : "ready"}
                empty={{ title: t("noOrders") }}
                error={{ title: tm("notAvailable") }}
                rows={v.orders}
                getRowKey={(o: Order) => o.id}
                columns={[
                  {
                    key: "time",
                    header: t("cols.time"),
                    cell: (o: Order) => formatDateTime(Date.parse(o.at), tz),
                  },
                  { key: "bot", header: t("cols.bot"), cell: (o: Order) => o.botName },
                  {
                    key: "market",
                    header: t("cols.market"),
                    cell: (o: Order) => names.market(o.market),
                  },
                  {
                    key: "side",
                    header: t("cols.side"),
                    cell: (o: Order) => `${o.side} · ${o.type}`,
                  },
                  {
                    key: "price",
                    header: t("cols.price"),
                    numeric: true,
                    cell: (o: Order) =>
                      o.price === null ? "—" : (formatAmount(o.price)?.text ?? o.price),
                  },
                  {
                    key: "size",
                    header: t("cols.size"),
                    numeric: true,
                    cell: (o: Order) => formatAmount(o.size)?.text ?? o.size,
                  },
                  { key: "status", header: t("cols.status"), cell: (o: Order) => o.status },
                ]}
              />
            </Card>
            <p className="m-0 text-xs text-muted">{t("viewNote")}</p>
          </>
        )}
      </div>
    </Workspace>
  );
}
