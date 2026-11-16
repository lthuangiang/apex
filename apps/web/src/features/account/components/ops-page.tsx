"use client";

import { dec, teamOpsViewSchema, type BotSummary, type TeamOpsView } from "@drift/shared";
import { Button, DataTable, StatusPill } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { useStateLabel } from "@/features/bots";
import { api, ApiError } from "@/lib/api";
import { formatDateTime, formatMoney } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";
import { BELOW_LG, useMediaQuery } from "@/lib/use-media";

// Trang Ops của team (PR C, DEC-276): một hàng mỗi bot Market Making / Volume Farm thật. Số không có →
// "Not available", không bao giờ 0. Làm mới tay hoặc tự động 30 s (không nhanh hơn); 403 thì ngừng làm mới; làm mới
// lỗi thì giữ dữ liệu cũ và ghi rõ là cũ.

type Row = TeamOpsView["bots"][number];

const forbiddenError = (e: unknown) => e instanceof ApiError && e.code === "FORBIDDEN";

/** Bot có vi phạm bất biến gần nhất lên đầu, rồi theo volume / giờ (so bằng decimal). */
export function sortOps(rows: readonly Row[]): Row[] {
  const vol = (r: Row) => dec(r.volumeHour ?? "-1");
  return [...rows].sort((a, b) => {
    const va = a.latestInvariant === null ? 0 : Date.parse(a.latestInvariant.at);
    const vb = b.latestInvariant === null ? 0 : Date.parse(b.latestInvariant.at);
    return vb - va || vol(b).cmp(vol(a));
  });
}

export function OpsPage() {
  const t = useTranslations("teamOps");
  const tm = useTranslations("common.missing");
  const tc = useTranslations("createBot");
  const names = useMarketNames();
  const stateLabel = useStateLabel();
  const isMobile = useMediaQuery(BELOW_LG);
  const q = useQuery({
    queryKey: ["team-ops"],
    queryFn: () => api("GET", "/api/v1/admin/ops", teamOpsViewSchema),
    refetchInterval: (query) => (forbiddenError(query.state.error) ? false : 30_000),
    retry: (n, e) => !forbiddenError(e) && n < 2,
  });
  const forbidden = forbiddenError(q.error);
  const stale = q.isError && q.data !== undefined;
  const na = <span className="text-muted">{tm("notAvailable")}</span>;
  const usd = (v: string | null) => {
    const m = v === null ? null : formatMoney(v);
    return m === null ? na : `${m} USDC`;
  };
  const rows = sortOps(q.data?.bots ?? []);

  const botCell = (r: Row) => (
    <span className="flex flex-col">
      <Link href={`/admin/users/${r.userId}`} className="font-bold">
        {r.name}
      </Link>
      <span className="text-xs text-muted">
        {tc(`strategies.${r.strategy}.name`)} · {names.market(r.market)} · ··{r.botId.slice(-8)}
      </span>
    </span>
  );
  const stateCell = (r: Row) => (
    <StatusPill
      {...stateLabel({
        state: r.state as BotSummary["state"],
        reasonCode: null,
        needsAttention: false,
      })}
    />
  );
  const cells: { key: string; header: string; numeric: boolean; cell: (r: Row) => ReactNode }[] = [
    {
      key: "cpm",
      header: t("cols.costPerMillion"),
      numeric: true,
      cell: (r) => usd(r.costPerMillion),
    },
    { key: "volume", header: t("cols.volumeHour"), numeric: true, cell: (r) => usd(r.volumeHour) },
    {
      key: "requests",
      header: t("cols.requestsPerMinute"),
      numeric: true,
      cell: (r) => r.requestsPerMinute ?? na,
    },
    {
      key: "maker",
      header: t("cols.makerShare"),
      numeric: true,
      cell: (r) => (r.makerSharePct === null ? na : `${r.makerSharePct}%`),
    },
    {
      key: "untracked",
      header: t("cols.untracked"),
      numeric: true,
      cell: (r) => r.untrackedCancels,
    },
    { key: "cuts", header: t("cols.cuts"), numeric: true, cell: (r) => r.positionCuts },
    {
      key: "gap",
      header: t("cols.quoteGap"),
      numeric: true,
      cell: (r) => (r.maxQuoteGapSec === null ? na : `${r.maxQuoteGapSec} s`),
    },
    {
      key: "invariant",
      header: t("cols.invariant"),
      numeric: false,
      cell: (r) =>
        r.latestInvariant === null
          ? t("none")
          : t("invariantValue", {
              invariant: r.latestInvariant.invariant,
              time: formatDateTime(r.latestInvariant.at),
              detail: r.latestInvariant.detail,
            }),
    },
  ];

  return (
    <Workspace current="ops">
      <div className="flex flex-col gap-5">
        <PageHead
          title={t("title")}
          subtitle={t("subtitle")}
          action={
            forbidden ? undefined : (
              <Button
                variant="secondary"
                pending={q.isFetching}
                onClick={() => {
                  void q.refetch();
                }}
              >
                {t("refresh")}
              </Button>
            )
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
            {stale ? (
              <p role="status" className="m-0 text-sm font-semibold text-warn">
                {t("stale")}
              </p>
            ) : null}
            {isMobile && rows.length > 0 ? (
              <ul aria-label={t("title")} className="m-0 flex list-none flex-col gap-2.5 p-0">
                {rows.map((r) => (
                  <li
                    key={r.botId}
                    className="flex flex-col gap-2 rounded-[16px] border border-border p-3.5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      {botCell(r)}
                      {stateCell(r)}
                    </div>
                    <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                      {cells.map((c) => (
                        <div key={c.key} className="flex flex-col">
                          <dt className="text-xs text-muted">{c.header}</dt>
                          <dd className="m-0 font-semibold tabular-nums">{c.cell(r)}</dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                ))}
              </ul>
            ) : (
              <DataTable
                caption={t("title")}
                label={t("title")}
                status={
                  q.data !== undefined
                    ? rows.length === 0
                      ? "empty"
                      : "ready"
                    : q.isPending
                      ? "loading"
                      : "error"
                }
                empty={{ title: t("empty") }}
                error={{ title: t("error") }}
                rows={rows}
                getRowKey={(r: Row) => r.botId}
                columns={[
                  { key: "bot", header: t("cols.bot"), cell: botCell },
                  { key: "state", header: t("cols.state"), cell: stateCell },
                  ...cells.map((c) => ({
                    key: c.key,
                    header: c.header,
                    numeric: c.numeric,
                    cell: c.cell,
                  })),
                ]}
              />
            )}
          </Card>
        )}
      </div>
    </Workspace>
  );
}
