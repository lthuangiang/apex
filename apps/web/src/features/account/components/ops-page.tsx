"use client";

import { teamOpsViewSchema, type BotSummary, type TeamOpsView } from "@drift/shared";
import { Button, DataTable, StatusPill } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { api, ApiError } from "@/lib/api";
import { formatDateTime, formatMoney } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";

import { useStateLabel } from "../../bots/components/bots-page";

// Trang Ops của team (PR C, DEC-TBD-ops-page): một hàng mỗi bot Market Making / Volume Farm thật. Số không có →
// "Not available", không bao giờ 0. Làm mới tay hoặc tự động 30 s (không nhanh hơn).

type Row = TeamOpsView["bots"][number];

/** Bot có vi phạm bất biến gần nhất lên đầu, rồi theo volume / giờ. */
export function sortOps(rows: readonly Row[]): Row[] {
  const vol = (r: Row) => (r.volumeHour === null ? -1 : Number(r.volumeHour));
  return [...rows].sort((a, b) => {
    const va = a.latestInvariant === null ? 0 : Date.parse(a.latestInvariant.at);
    const vb = b.latestInvariant === null ? 0 : Date.parse(b.latestInvariant.at);
    return vb - va || vol(b) - vol(a);
  });
}

export function OpsPage() {
  const t = useTranslations("teamOps");
  const tm = useTranslations("common.missing");
  const tc = useTranslations("catalog");
  const names = useMarketNames();
  const stateLabel = useStateLabel();
  const q = useQuery({
    queryKey: ["team-ops"],
    queryFn: () => api("GET", "/api/v1/admin/ops", teamOpsViewSchema),
    refetchInterval: 30_000,
  });
  const forbidden = q.error instanceof ApiError && q.error.code === "FORBIDDEN";
  const na = <span className="text-muted">{tm("notAvailable")}</span>;
  const usd = (v: string | null) => (v === null ? na : `${formatMoney(v) ?? ""} USDC`);
  const rows = sortOps(q.data?.bots ?? []);

  return (
    <Workspace current="ops">
      <div className="flex flex-col gap-5">
        <PageHead
          title={t("title")}
          subtitle={t("subtitle")}
          action={
            <Button
              variant="secondary"
              pending={q.isFetching}
              onClick={() => {
                void q.refetch();
              }}
            >
              {t("refresh")}
            </Button>
          }
        />
        {forbidden ? (
          <Card>
            <p className="m-0">{t("forbidden")}</p>
          </Card>
        ) : (
          <Card>
            {q.data === undefined ? null : (
              <p className="m-0 text-xs text-ink-2">
                {t("checked", { time: formatDateTime(q.data.checkedAt) })}
              </p>
            )}
            <DataTable
              caption={t("title")}
              label={t("title")}
              status={
                q.isPending
                  ? "loading"
                  : q.isError
                    ? "error"
                    : rows.length === 0
                      ? "empty"
                      : "ready"
              }
              empty={{ title: t("empty") }}
              error={{ title: tm("notAvailable") }}
              rows={rows}
              getRowKey={(r: Row) => r.botId}
              columns={[
                {
                  key: "bot",
                  header: t("cols.bot"),
                  cell: (r: Row) => (
                    <span className="flex flex-col">
                      <Link href={`/agent/${r.botId}`} className="font-bold">
                        {r.name}
                      </Link>
                      <span className="text-xs text-muted">
                        {tc(`strategies.${r.strategy}.name`)} · {names.market(r.market)} · ··
                        {r.botId.slice(-4)}
                      </span>
                    </span>
                  ),
                },
                {
                  key: "state",
                  header: t("cols.state"),
                  cell: (r: Row) => (
                    <StatusPill
                      {...stateLabel({
                        state: r.state as BotSummary["state"],
                        reasonCode: null,
                        needsAttention: false,
                      })}
                    />
                  ),
                },
                {
                  key: "cpm",
                  header: t("cols.costPerMillion"),
                  numeric: true,
                  cell: (r: Row) => usd(r.costPerMillion),
                },
                {
                  key: "volume",
                  header: t("cols.volumeHour"),
                  numeric: true,
                  cell: (r: Row) => usd(r.volumeHour),
                },
                {
                  key: "requests",
                  header: t("cols.requestsPerMinute"),
                  numeric: true,
                  cell: (r: Row) => r.requestsPerMinute ?? na,
                },
                {
                  key: "maker",
                  header: t("cols.makerShare"),
                  numeric: true,
                  cell: (r: Row) => (r.makerSharePct === null ? na : `${r.makerSharePct}%`),
                },
                {
                  key: "untracked",
                  header: t("cols.untracked"),
                  numeric: true,
                  cell: (r: Row) => r.untrackedCancels,
                },
                {
                  key: "cuts",
                  header: t("cols.cuts"),
                  numeric: true,
                  cell: (r: Row) => r.positionCuts,
                },
                {
                  key: "gap",
                  header: t("cols.quoteGap"),
                  numeric: true,
                  cell: (r: Row) => (r.maxQuoteGapSec === null ? na : `${r.maxQuoteGapSec} s`),
                },
                {
                  key: "invariant",
                  header: t("cols.invariant"),
                  cell: (r: Row) =>
                    r.latestInvariant === null
                      ? t("none")
                      : t("invariantValue", {
                          invariant: r.latestInvariant.invariant,
                          time: formatDateTime(r.latestInvariant.at),
                          detail: r.latestInvariant.detail,
                        }),
                },
              ]}
            />
          </Card>
        )}
      </div>
    </Workspace>
  );
}
