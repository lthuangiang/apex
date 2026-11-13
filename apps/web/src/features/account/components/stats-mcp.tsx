"use client";

import type { McpPlatformStats } from "@drift/shared";
import { DataTable, MetricCard, type DataStatus } from "@drift/ui";
import { useTranslations } from "next-intl";

import { formatInteger } from "@/lib/format";

// Mục "Claude (MCP)" ở Stats (role team, DEC-225): chỉ số đếm thật; tỷ lệ không có (0 lượt trong 24h)
// thì hiện "Not available", không phải 0%.

type ToolRow = McpPlatformStats["byTool24h"][number];

export function McpStats({
  status,
  mcp,
}: {
  status: DataStatus;
  mcp: McpPlatformStats | undefined;
}) {
  const t = useTranslations("platformStats.mcp");
  const tm = useTranslations("common.missing");
  // Tỷ lệ null (0 lượt trong 24h) → thẻ ở trạng thái `empty` ("Not available").
  const rate = (v: string | null | undefined): DataStatus =>
    status === "ready" && (v === null || v === undefined) ? "empty" : status;
  const pct = (v: string | null | undefined) =>
    v === null || v === undefined ? undefined : `${v}%`;
  return (
    // `div` (không phải section): vùng dữ liệu bên dưới đã là landmark mang tên "Claude (MCP)", tránh trùng tên (axe).
    <div className="flex flex-col gap-3">
      <h2 id="stats-mcp" className="m-0 text-base font-bold">
        {t("section")}
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard
          label={t("connectedUsers")}
          status={status}
          emptyLabel={tm("notAvailable")}
          value={mcp === undefined ? undefined : formatInteger(mcp.connectedUsers)}
        />
        <MetricCard
          label={t("calls24h")}
          status={status}
          emptyLabel={tm("notAvailable")}
          value={mcp === undefined ? undefined : formatInteger(mcp.calls24h)}
        />
        <MetricCard
          label={t("denied24h")}
          status={rate(mcp?.deniedPct24h)}
          emptyLabel={tm("notAvailable")}
          value={pct(mcp?.deniedPct24h)}
        />
        <MetricCard
          label={t("rateLimited24h")}
          status={rate(mcp?.rateLimitedPct24h)}
          emptyLabel={tm("notAvailable")}
          value={pct(mcp?.rateLimitedPct24h)}
        />
      </div>
      <DataTable
        caption={t("byTool")}
        label={t("section")}
        status={status === "ready" && mcp?.byTool24h.length === 0 ? "empty" : status}
        empty={{ title: t("none") }}
        error={{ title: tm("notAvailable") }}
        rows={mcp?.byTool24h ?? []}
        getRowKey={(r: ToolRow) => r.tool}
        columns={[
          { key: "tool", header: t("cols.tool"), cell: (r: ToolRow) => r.tool },
          {
            key: "calls",
            header: t("cols.calls"),
            numeric: true,
            cell: (r: ToolRow) => formatInteger(r.calls),
          },
          {
            key: "errors",
            header: t("cols.errors"),
            numeric: true,
            cell: (r: ToolRow) => formatInteger(r.errors),
          },
        ]}
      />
    </div>
  );
}
