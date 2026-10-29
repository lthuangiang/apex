"use client";

import { botListSchema, orderListSchema, UserRole, type OrderView } from "@drift/shared";
import { Button, DataTable } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { NotConnected, useSodexMissing } from "@/components/not-connected";
import { PageHead } from "@/components/workspace";
import { WorkspaceShell } from "@/components/workspace-shell";
import { api } from "@/lib/api";
import { formatAmount, formatDateTime } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";
import { useMe } from "@/lib/queries";

import { BOTS_KEY } from "./bots-page";

// Execution & Orders (SCREENS.md mục 8.5, artboard "Orders"): mọi lệnh DRIFT gửi và kết quả SoDEX báo.
// Lệnh `unknown` không bao giờ được gửi lại trước khi đối soát (quy tắc 1.7); trang chỉ hiển thị.

const STATUS_ICON = {
  open: "○",
  partially_filled: "◐",
  filled: "✓",
  cancelled: "–",
  rejected: "✕",
  unknown: "?",
  not_placed: "–",
} as const;

const TABS = {
  all: () => true,
  open: (o: OrderView) => o.status === "open" || o.status === "partially_filled",
  fills: (o: OrderView) => o.status === "filled" || o.status === "partially_filled",
  issues: (o: OrderView) =>
    o.status === "rejected" || o.status === "unknown" || o.status === "not_placed",
} as const;
type Tab = keyof typeof TABS;
/** Số lệnh tối đa `GET /api/v1/orders` trả về (apps/api listOrders). */
const ORDER_LIST_LIMIT = 200;
const TIME_DAYS = { today: 0, d7: 7, d30: 30 } as const;
type TimeKey = keyof typeof TIME_DAYS;

/** Mốc lọc thời gian: "Today" = từ 00:00 giờ máy người dùng; 7/30 ngày tính lùi từ bây giờ. */
function sinceOf(key: TimeKey, now: number): number {
  if (key === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return now - TIME_DAYS[key] * 86_400_000;
}

export function OrdersPage({ botId }: { botId?: string }) {
  const t = useTranslations("orders");
  const te = useTranslations("common.errors");
  const tm = useTranslations("common.missing");
  const me = useMe();
  const names = useMarketNames();
  const orders = useQuery({
    queryKey: ["orders", botId],
    queryFn: () =>
      api("GET", `/api/v1/orders${botId === undefined ? "" : `?botId=${botId}`}`, orderListSchema),
    refetchInterval: 5_000,
  });
  const bots = useQuery({
    queryKey: BOTS_KEY,
    queryFn: () => api("GET", "/api/v1/bots", botListSchema),
  });
  const botName = new Map((bots.data?.items ?? []).map((b) => [b.id, b.name]));
  const missing = useSodexMissing();
  const [tab, setTab] = useState<Tab>("all");
  const [symbol, setSymbol] = useState("all");
  const [side, setSide] = useState<"all" | "buy" | "sell">("all");
  const [time, setTime] = useState<TimeKey>("d7");
  const all = orders.data?.items ?? [];
  const unknown = all.filter((o) => o.status === "unknown").length;
  const now = Date.now();
  const since = sinceOf(time, now);
  const today = sinceOf("today", now);
  const at = (o: OrderView) => (o.submittedAt === null ? null : Date.parse(o.submittedAt));
  const inWindow = (o: OrderView, from: number) => {
    const ms = at(o);
    return ms !== null && ms >= from;
  };
  const filtered = all.filter(
    (o) =>
      (symbol === "all" || o.market === symbol) &&
      (side === "all" || o.side === side) &&
      inWindow(o, since),
  );
  const rows = filtered.filter(TABS[tab]);
  const symbols = [...new Set(all.map((o) => o.market))].sort();
  const openCount = all.filter(TABS.open).length;
  const partial = all.filter((o) => o.status === "partially_filled").length;
  const filledToday = all.filter((o) => o.status === "filled" && inWindow(o, today)).length;
  const rejectedToday = all.filter((o) => o.status === "rejected" && inWindow(o, today));
  // API trả tối đa ORDER_LIST_LIMIT lệnh mới nhất: khi bị cắt, chỉ đếm được cửa sổ nằm trọn trong danh
  // sách; ngoài ra hiện "Not available" thay vì một con số có thể thiếu (quy tắc 1.8).
  const truncated = all.length >= ORDER_LIST_LIMIT;
  const oldest = all.reduce<number | null>((m, o) => {
    const ms = at(o);
    return ms === null ? m : m === null ? ms : Math.min(m, ms);
  }, null);
  const todayComplete = !truncated || (oldest !== null && oldest < today);
  const counts =
    orders.isSuccess && !missing
      ? [
          {
            key: "open",
            value: truncated ? null : String(openCount),
            sub: truncated ? "" : t("counts.partial", { n: partial }),
          },
          {
            key: "filledToday",
            value: todayComplete ? String(filledToday) : null,
            sub: t("counts.sinceMidnight"),
          },
          {
            key: "rejectedToday",
            value: todayComplete ? String(rejectedToday.length) : null,
            sub: rejectedToday[0]?.rejectCode ?? "",
          },
        ]
      : null;

  return (
    <WorkspaceShell current="orders" isTeam={me.data?.role === UserRole.team}>
      <div className="flex flex-col gap-5">
        <PageHead title={t("title")} subtitle={t("subtitle")} />
        {unknown > 0 ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3.5 rounded-[18px] border border-unknown/30 bg-unknown-bg px-[18px] py-4 text-unknown"
          >
            <span
              aria-hidden="true"
              className="flex size-9 flex-none items-center justify-center rounded-full bg-surface font-extrabold"
            >
              ?
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <strong>{t("unknownBanner", { count: unknown })}</strong>
              <span className="text-sm">{t("unknownBody")}</span>
            </span>
            <button
              type="button"
              className="flex min-h-tap items-center rounded-control bg-surface px-4 text-sm font-bold text-unknown"
              onClick={() => {
                setTab("issues");
              }}
            >
              {t("reviewOrder")}
            </button>
          </div>
        ) : null}
        {missing ? <NotConnected /> : null}
        <section
          aria-label={t("counts.label")}
          className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 tabular-nums"
        >
          {(["open", "filledToday", "rejectedToday"] as const).map((k, i) => (
            <div
              key={k}
              className="flex flex-col gap-1 rounded-tile border border-border bg-surface px-4 py-3.5"
            >
              <span className="text-xs font-semibold text-muted">{t(`counts.${k}`)}</span>
              <span className="text-xl font-extrabold">
                {counts?.[i]?.value ?? tm("notAvailable")}
              </span>
              {counts?.[i]?.sub ? (
                <span className="text-xs text-ink-2">{counts[i].sub}</span>
              ) : null}
            </div>
          ))}
        </section>
        {/* Chưa lưu giá tham chiếu nên chưa tính được slippage: dòng phụ thay cho một ô tổng trống (UI_REVIEW J5). */}
        <p className="-mt-2 text-xs text-muted">
          {t("counts.slippage")} · {tm("notAvailable")} · {t("counts.noReference")}
        </p>
        <section
          aria-labelledby="ord-h"
          className="flex flex-col gap-3.5 rounded-card border border-border bg-surface px-[22px] py-5"
        >
          <h2 id="ord-h" className="m-0 text-lg font-extrabold">
            {t("caption")}
          </h2>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              role="tablist"
              aria-label={t("tabs.label")}
              className="flex flex-wrap gap-1 rounded-control bg-surface-2 p-1"
            >
              {(Object.keys(TABS) as Tab[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  onClick={() => {
                    setTab(k);
                  }}
                  className={`flex min-h-9 items-center gap-2 rounded-[9px] px-3 text-[13px] font-bold ${tab === k ? "bg-surface text-ink shadow-sm" : "text-ink-2"}`}
                >
                  {t(`tabs.${k}`)}
                  {missing || !orders.isSuccess ? null : (
                    <span
                      className={`rounded-full px-[7px] py-px text-[11px] tabular-nums ${tab === k ? "bg-accent text-white" : "bg-border text-ink-2"}`}
                    >
                      {filtered.filter(TABS[k]).length}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Filter
                label={t("filters.symbol")}
                value={symbol}
                options={[
                  { value: "all", label: t("filters.all") },
                  ...symbols.map((m) => ({ value: m, label: names.market(m) })),
                ]}
                onChange={setSymbol}
              />
              <Filter
                label={t("filters.side")}
                value={side}
                options={[
                  { value: "all", label: t("filters.all") },
                  { value: "buy", label: t("side.buy") },
                  { value: "sell", label: t("side.sell") },
                ]}
                onChange={(v) => {
                  setSide(v === "buy" || v === "sell" ? v : "all");
                }}
              />
              <Filter
                label={t("filters.time")}
                value={time}
                options={(Object.keys(TIME_DAYS) as TimeKey[]).map((k) => ({
                  value: k,
                  label: t(`filters.${k}`),
                }))}
                onChange={(v) => {
                  setTime(v in TIME_DAYS ? (v as TimeKey) : "today");
                }}
              />
            </div>
          </div>
          <DataTable
            caption={t("caption")}
            label={t("caption")}
            status={
              orders.isPending
                ? "loading"
                : orders.isError
                  ? "error"
                  : rows.length === 0
                    ? "empty"
                    : "ready"
            }
            empty={
              all.length === 0
                ? { title: t("emptyNone") }
                : {
                    title: t("empty"),
                    action: (
                      <span className="flex flex-wrap justify-center gap-2">
                        {time === "d30" ? null : (
                          <Button
                            variant="tonal"
                            onClick={() => {
                              setTime("d30");
                            }}
                          >
                            {t("showLast30")}
                          </Button>
                        )}
                        <Button
                          variant="tonal"
                          onClick={() => {
                            setTab("all");
                            setSymbol("all");
                            setSide("all");
                            setTime("d7");
                          }}
                        >
                          {t("clearFilters")}
                        </Button>
                      </span>
                    ),
                  }
            }
            error={{
              title: te("generic"),
              retryLabel: te("retry"),
              onRetry: () => {
                void orders.refetch();
              },
            }}
            rows={rows}
            getRowKey={(o) => o.id}
            columns={[
              {
                key: "time",
                header: t("cols.time"),
                cell: (o) => (o.submittedAt === null ? "" : formatDateTime(o.submittedAt)),
              },
              {
                key: "symbol",
                header: t("cols.symbol"),
                cell: (o) => <strong>{names.market(o.market)}</strong>,
              },
              {
                key: "side",
                header: t("cols.side"),
                cell: (o) => `${t(`side.${o.side}`)} · ${t(`type.${o.type}`)}`,
              },
              {
                key: "price",
                header: t("cols.price"),
                numeric: true,
                cell: (o) =>
                  o.price === null
                    ? t("marketPrice")
                    : formatAmount(o.price, names.priceDigits(o.market))?.text,
              },
              {
                key: "filled",
                header: t("cols.filled"),
                numeric: true,
                cell: (o) => {
                  const q = names.qtyDigits(o.market);
                  return `${formatAmount(o.filledSize, q)?.text ?? ""} / ${formatAmount(o.size, q)?.text ?? ""}`;
                },
              },
              {
                key: "status",
                header: t("cols.status"),
                cell: (o) => (
                  <span>
                    {STATUS_ICON[o.status]} {t(`status.${o.status}`)}
                    {o.rejectCode === null ? null : (
                      <span className="block text-xs text-muted">{o.rejectCode}</span>
                    )}
                  </span>
                ),
              },
              {
                key: "source",
                header: t("cols.source"),
                cell: (o) => botName.get(o.botId) ?? tm("notAvailable"),
              },
            ]}
          />
        </section>
      </div>
    </WorkspaceShell>
  );
}

function Filter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex h-10 items-center gap-2 rounded-control border border-border-input px-3 text-[13px] text-muted">
      {label}
      <select
        className="border-0 bg-transparent text-sm font-semibold text-ink"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
