"use client";

import { botFillListSchema, dec, type BotFillView } from "@drift/shared";
import { Button, DataTable } from "@drift/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

import { fmt, fmtPrice } from "../preview";

// Bảng khớp lệnh của bot ở Trading Agent (Market Making): mỗi dòng là một trade SoDEX đã ghi trong `fills`,
// không suy ra từ trạng thái lệnh. Value = price × size do backend tính. 20 dòng mỗi trang (server phân trang);
// chỉ trang đầu tự làm mới, để trang cũ không bị đẩy dòng khi có lần khớp mới.

export function BotFills({ botId }: { botId: string }) {
  const t = useTranslations("agent.fills");
  const tm = useTranslations("common.missing");
  const [page, setPage] = useState(1);
  const fills = useQuery({
    queryKey: ["bot-fills", botId, page],
    queryFn: () =>
      api("GET", `/api/v1/bots/${botId}/fills?page=${String(page)}`, botFillListSchema),
    refetchInterval: page === 1 ? 3_000 : false,
    placeholderData: keepPreviousData,
  });
  const rows = fills.data?.items ?? [];
  const pages =
    fills.data === undefined ? 1 : Math.max(1, Math.ceil(fills.data.total / fills.data.pageSize));
  return (
    <section
      aria-labelledby="fills-title"
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-5"
    >
      <div className="flex flex-col gap-0.5">
        <h2 id="fills-title" className="m-0 text-lg font-extrabold">
          {t("title")}
        </h2>
        <p className="m-0 text-xs text-muted">{t("subtitle")}</p>
      </div>
      <DataTable<BotFillView>
        caption={t("title")}
        label={t("title")}
        status={
          fills.isPending
            ? "loading"
            : fills.isError
              ? "error"
              : rows.length === 0
                ? "empty"
                : "ready"
        }
        empty={{ title: t("empty") }}
        error={{ title: t("error") }}
        rows={rows}
        getRowKey={(f) => f.id}
        columns={[
          { key: "time", header: t("cols.time"), cell: (f) => formatDateTime(f.filledAt) },
          {
            key: "side",
            header: t("cols.side"),
            cell: (f) => (
              <strong className={f.side === "buy" ? "text-pos" : "text-neg-ink"}>
                {t(f.side)}
              </strong>
            ),
          },
          { key: "type", header: t("cols.type"), cell: (f) => t(f.close ? "close" : "open") },
          { key: "price", header: t("cols.price"), numeric: true, cell: (f) => fmtPrice(f.price) },
          { key: "size", header: t("cols.size"), numeric: true, cell: (f) => fmt(dec(f.size), 4) },
          {
            key: "value",
            header: t("cols.value"),
            numeric: true,
            cell: (f) => fmt(dec(f.value), 2),
          },
          { key: "fee", header: t("cols.fee"), numeric: true, cell: (f) => fmt(dec(f.fee), 4) },
          {
            key: "liquidity",
            header: t("cols.liquidity"),
            cell: (f) => (f.liquidity === null ? tm("notAvailable") : t(f.liquidity)),
          },
        ]}
      />
      {pages <= 1 ? null : (
        <nav aria-label={t("pagesLabel")} className="flex items-center justify-between gap-3">
          <Button
            variant="secondary"
            disabled={page <= 1 || fills.isFetching}
            onClick={() => {
              setPage((p) => p - 1);
            }}
          >
            {t("prev")}
          </Button>
          <span className="text-sm tabular-nums">{t("page", { page, pages })}</span>
          <Button
            variant="secondary"
            disabled={page >= pages || fills.isFetching}
            onClick={() => {
              setPage((p) => p + 1);
            }}
          >
            {t("next")}
          </Button>
        </nav>
      )}
    </section>
  );
}
