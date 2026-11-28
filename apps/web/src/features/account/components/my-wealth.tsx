"use client";

import {
  dec,
  ErrorCode,
  WEALTH_BUSY_REASON,
  wealthMeResponseSchema,
  type WealthHolding,
  type WealthMeResponse,
} from "@drift/shared";
import { DataTable, PnLValue, Skeleton } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { NotConnected } from "@/components/not-connected";
import { Card } from "@/components/workspace";
import { api, ApiError } from "@/lib/api";
import { formatAmount, formatDateTime, formatMoney } from "@/lib/format";

// Portfolio › My Wealth (#592, DEC-402, bản phác `docs/mockups/us-market` màn 05): CHỈ ĐỌC những gì SoDEX Wealth trả
// cho master wallet của tài khoản (`GET /api/v1/wealth/me`, mặc định không đọc recurring-buys / pnl-history).
// Quy tắc 1: không có nút nạp / rút / chuyển. Quy tắc 8: trường null hiện "Not provided", không bao giờ "0"; ví không
// có gì thì hiện empty state thay cho các ô 0. Hết ngân sách weight của chính DeskLabs (429 `sodex_wealth_budget`) thì
// hiện câu "busy", không hiện "Not provided".

/** Cùng khoá với dải "Your SoDEX Wealth" của `/markets/us` (#591): một lần đọc cho cả hai. */
export const WEALTH_ME_KEY = ["wealth", "me"] as const;

/**
 * Trang SoDEX Wealth cho nút "Open SoDEX Wealth ↗" (link ra ngoài, DEC-402). Chưa có URL đã chốt nên để null: nút không
 * hiện, không đoán URL (cùng cách với #591).
 */
export const SODEX_WEALTH_URL: string | null = null;

type WealthOk = Extract<WealthMeResponse, { status: "ok" }>;
type Activity = Extract<WealthOk["activity"], { status: "ok" }>["items"][number];

export function useMyWealth(enabled: boolean) {
  return useQuery({
    queryKey: WEALTH_ME_KEY,
    queryFn: () => api("GET", "/api/v1/wealth/me", wealthMeResponseSchema),
    // api cache 90 s theo địa chỉ: đọc lại sớm hơn chỉ nhận lại bản cache.
    staleTime: 60_000,
    refetchInterval: 90_000,
    // Busy (429) không thử lại ngay: lần đọc kế tiếp theo `refetchInterval` hoặc nút thử lại.
    retry: (count, error) => !isBusy(error) && count < 1,
    enabled,
  });
}

export function isBusy(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.code === ErrorCode.rateLimited &&
    error.details.reason === WEALTH_BUSY_REASON
  );
}

/** "$1,234.56"; `signed` thêm + / −. null → null (người gọi hiện "Not provided"). */
export function usd(value: string | null, signed = false): string | null {
  if (value === null) return null;
  const negative = dec(value).isNegative() && !dec(value).isZero();
  const abs = formatMoney(dec(value).abs().toString());
  if (abs === null) return null;
  const sign = negative ? "−" : signed && abs !== "0.00" ? "+" : "";
  return `${sign}$${abs}`;
}

function Missing() {
  const tm = useTranslations("common.missing");
  return <span className="text-muted">{tm("notProvided")}</span>;
}

function Money({ value, signed = false }: { value: string | null; signed?: boolean }) {
  const text = usd(value, signed);
  if (text === null) return <Missing />;
  if (!signed) return <>{text}</>;
  const tone = dec(value ?? "0").isZero()
    ? "text-ink-2"
    : dec(value ?? "0").isNegative()
      ? "text-neg-ink"
      : "text-pos";
  return <span className={`font-semibold ${tone}`}>{text}</span>;
}

function Shares({ value }: { value: string | null }) {
  const f = formatAmount(value, 2);
  if (f === null) return <Missing />;
  return f.full === null ? <>{f.text}</> : <span title={f.full}>{f.text}</span>;
}

function sharesText(value: string): string {
  return formatAmount(value, 2)?.text ?? value;
}

/** Tổng `count` của các ô in-flight; null khi không đọc được hoặc có ô thiếu `count` (không đoán). */
function requestCount(w: WealthOk): number | null {
  if (w.inFlight.status !== "ok") return null;
  let n = 0;
  for (const row of w.inFlight.items) {
    if (row.count === null) return null;
    n += row.count;
  }
  return n;
}

/** Ví không có gì trên Wealth: không quỹ, không lệnh đang xử lý, không hoạt động (phần nào không đọc được thì không kết luận). */
export function isEmptyWealth(w: WealthOk): boolean {
  return (
    w.holdings.length === 0 &&
    w.inFlight.status === "ok" &&
    w.inFlight.items.length === 0 &&
    w.activity.status === "ok" &&
    w.activity.items.length === 0
  );
}

function Tile({
  label,
  value,
  hint,
  hero = false,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  hero?: boolean;
}) {
  return (
    <section
      aria-label={label}
      className={`flex min-w-0 flex-col gap-1 rounded-tile border p-4 ${hero ? "border-ink bg-ink text-surface" : "border-border bg-surface"}`}
    >
      <span
        className={`text-xs font-extrabold tracking-[0.04em] uppercase ${hero ? "text-surface/75" : "text-muted"}`}
      >
        {label}
      </span>
      <strong className="text-[26px] leading-tight font-extrabold tabular-nums">{value}</strong>
      {hint === undefined || hint === null ? null : (
        <span className={`text-xs ${hero ? "text-surface/75" : "text-ink-2"}`}>{hint}</span>
      )}
    </section>
  );
}

function Summary({ w }: { w: WealthOk }) {
  const t = useTranslations("myWealth");
  const s = w.summary;
  const n = requestCount(w);
  const total = usd(s.totalValue);
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
        <Tile hero label={t("kpi.totalValue")} value={total ?? <Missing />} />
        <Tile label={t("kpi.totalCost")} value={<Money value={s.totalCost} />} />
        <Tile
          label={t("kpi.totalResult")}
          value={<Money value={s.totalPnl} signed />}
          hint={
            s.totalRealizedPnl === null || s.totalUnrealizedPnl === null
              ? undefined
              : t("kpi.resultSplit", {
                  realized: usd(s.totalRealizedPnl, true) ?? "",
                  open: usd(s.totalUnrealizedPnl, true) ?? "",
                })
          }
        />
        <Tile label={t("kpi.pnl24h")} value={<Money value={s.totalPnl24h} signed />} />
        <Tile
          label={t("kpi.inFlight")}
          value={<Money value={s.inFlightValue} />}
          hint={n === null ? undefined : t("kpi.requests", { n })}
        />
      </div>
      {s.complete === false ? <p className="m-0 text-xs text-muted">{t("incomplete")}</p> : null}
    </div>
  );
}

function OpenSodex() {
  const t = useTranslations("myWealth");
  if (SODEX_WEALTH_URL === null) return null;
  return (
    <a
      href={SODEX_WEALTH_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-h-tap items-center rounded-control border border-border-input bg-surface px-4 text-sm font-bold text-ink no-underline"
    >
      {t("holdings.openSodex")}
    </a>
  );
}

function fundTypeLabel(t: ReturnType<typeof useTranslations>, h: WealthHolding): string | null {
  // Theo tài liệu SoDEX: `escrow_vault`, `bridged_vault`, `clob`. Chỉ đặt nhãn cho loại vault; loại khác không đoán nhãn.
  return h.fundType !== null && h.fundType.endsWith("vault") ? t("holdings.type.vault") : null;
}

function Holdings({ w }: { w: WealthOk }) {
  const t = useTranslations("myWealth");
  const te = useTranslations("common.errors");
  return (
    // Vùng có tên là bảng bên trong (DataTable `label`), khung ngoài chỉ là thẻ để không trùng landmark.
    <div className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="wealth-holdings-title" className="m-0 text-lg font-extrabold">
          {t("holdings.title")}
        </h2>
        <OpenSodex />
      </div>
      <DataTable
        caption={t("holdings.title")}
        label={t("holdings.title")}
        status={w.holdings.length === 0 ? "empty" : "ready"}
        empty={{ title: t("holdings.none") }}
        error={{ title: te("generic") }}
        rows={w.holdings}
        getRowKey={(h) => h.fundId}
        columns={[
          {
            key: "fund",
            header: t("holdings.cols.fund"),
            cell: (h) => {
              const type = fundTypeLabel(t, h);
              const redeeming =
                h.pendingRedeemShares !== null && !dec(h.pendingRedeemShares).isZero()
                  ? t("holdings.redeeming", { shares: sharesText(h.pendingRedeemShares) })
                  : null;
              const sub = [type, redeeming].filter((x) => x !== null).join(" · ");
              return (
                <div className="flex flex-col">
                  <strong>{h.name ?? h.fundId}</strong>
                  {sub === "" ? null : <span className="text-xs text-muted">{sub}</span>}
                </div>
              );
            },
          },
          {
            key: "shares",
            header: t("holdings.cols.shares"),
            numeric: true,
            cell: (h) => <Shares value={h.shares} />,
          },
          {
            key: "price",
            header: t("holdings.cols.price"),
            numeric: true,
            cell: (h) => <Money value={h.price} />,
          },
          {
            key: "value",
            header: t("holdings.cols.value"),
            numeric: true,
            cell: (h) => <Money value={h.marketValue} />,
          },
          {
            key: "avgCost",
            header: t("holdings.cols.avgCost"),
            numeric: true,
            cell: (h) => <Money value={h.avgCost} />,
          },
          {
            key: "result",
            header: t("holdings.cols.result"),
            numeric: true,
            cell: (h) => <Money value={h.unrealizedPnl} signed />,
          },
          {
            key: "pnl24h",
            header: t("holdings.cols.pnl24h"),
            numeric: true,
            cell: (h) => <Money value={h.pnl24h} signed />,
          },
        ]}
      />
    </div>
  );
}

/** Nhãn "What" theo `transactionType` / `kind` của SoDEX (docs Wealth API › User fund history); lạ thì hiện nguyên văn. */
const WHAT_KEYS: Readonly<Record<string, string>> = {
  recurring_buy: "recurringBuy",
  subscribe: "invest",
  deposit: "invest",
  redeem: "redeem",
  airdrop: "airdrop",
  liquidation: "liquidation",
  transfer_in: "transferIn",
  transfer_out: "transferOut",
};
const STATUS_KEYS: Readonly<Record<string, { key: string; tone: string }>> = {
  processing: { key: "processing", tone: "bg-accent-tint text-accent-ink" },
  completed: { key: "completed", tone: "bg-pos-bg text-pos" },
  failed: { key: "failed", tone: "bg-neg-bg text-neg-ink" },
  rejected: { key: "rejected", tone: "bg-neg-bg text-neg-ink" },
  cancelled: { key: "cancelled", tone: "bg-surface-2 text-ink-2" },
};

function ActivityTable({ w }: { w: WealthOk }) {
  const t = useTranslations("myWealth");
  const te = useTranslations("common.errors");
  const what = (a: Activity) => {
    const key = WHAT_KEYS[a.transactionType ?? ""] ?? WHAT_KEYS[a.kind];
    return key === undefined ? (a.transactionType ?? a.kind) : t(`activity.kind.${key}`);
  };
  const amount = (a: Activity) => {
    const isRedeem = a.kind === "redeem";
    if (!isRedeem && a.cost !== null) return <Money value={a.cost} />;
    if (a.shares !== null)
      return <>{t("activity.amountShares", { shares: sharesText(a.shares) })}</>;
    return <Missing />;
  };
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-5">
      <h2 id="wealth-activity-title" className="m-0 text-lg font-extrabold">
        {t("activity.title")}
      </h2>
      {w.activity.status !== "ok" ? (
        <section aria-labelledby="wealth-activity-title">
          <Missing />
        </section>
      ) : (
        <DataTable
          caption={t("activity.title")}
          label={t("activity.title")}
          status={w.activity.items.length === 0 ? "empty" : "ready"}
          empty={{ title: t("activity.none") }}
          error={{ title: te("generic") }}
          rows={w.activity.items}
          getRowKey={(a) => `${a.fundId}:${a.kind}:${a.requestedAt ?? ""}:${a.at ?? ""}`}
          columns={[
            {
              key: "when",
              header: t("activity.cols.when"),
              cell: (a) => {
                const at = a.at ?? a.requestedAt;
                const text = at === null ? "" : formatDateTime(at);
                return text === "" ? <Missing /> : <span className="tabular-nums">{text}</span>;
              },
            },
            {
              key: "fund",
              header: t("activity.cols.fund"),
              cell: (a) => a.name ?? a.fundId,
            },
            { key: "what", header: t("activity.cols.what"), cell: what },
            {
              key: "amount",
              header: t("activity.cols.amount"),
              numeric: true,
              cell: amount,
            },
            {
              key: "status",
              header: t("activity.cols.status"),
              cell: (a) => {
                const s = STATUS_KEYS[a.status];
                return (
                  <span
                    className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-extrabold whitespace-nowrap ${s?.tone ?? "bg-surface-2 text-ink-2"}`}
                  >
                    {s === undefined ? a.status : t(`activity.status.${s.key}`)}
                  </span>
                );
              },
            },
          ]}
        />
      )}
    </div>
  );
}

function CanDo() {
  const t = useTranslations("myWealth");
  const row = (label: string, value: string, tone: string) => (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-sm text-ink-2">{label}</dt>
      <dd className={`m-0 text-sm font-extrabold ${tone}`}>{value}</dd>
    </div>
  );
  return (
    <Card title={t("can.title")}>
      <dl className="m-0 flex flex-col gap-2">
        {row(t("can.see"), t("can.yes"), "text-pos")}
        {row(t("can.alerts"), t("can.yes"), "text-pos")}
        {row(t("can.move"), t("can.never"), "text-neg-ink")}
      </dl>
      <p className="m-0 text-xs text-muted">{t("can.note")}</p>
    </Card>
  );
}

function EmptyWealth() {
  const t = useTranslations("myWealth");
  return (
    <section
      aria-labelledby="wealth-empty-title"
      className="flex flex-col items-center gap-2.5 rounded-card border border-border bg-surface px-5 py-9 text-center"
    >
      <h2 id="wealth-empty-title" className="m-0 text-[15px] font-extrabold">
        {t("empty.title")}
      </h2>
      <p className="m-0 max-w-[460px] text-[13px] text-ink-2">{t("empty.body")}</p>
      <OpenSodex />
    </section>
  );
}

/** Nội dung tab My Wealth (dưới hàng tab của Portfolio). */
export function MyWealthView({ query }: { query: ReturnType<typeof useMyWealth> }) {
  const t = useTranslations("myWealth");
  const te = useTranslations("common.errors");
  if (query.isPending)
    return (
      <div aria-busy="true" className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-[92px]" />
        ))}
      </div>
    );
  if (query.isError) {
    const busy = isBusy(query.error);
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-5"
      >
        <p className="m-0 text-sm font-semibold">{busy ? t("busy") : te("generic")}</p>
        <button
          type="button"
          onClick={() => {
            void query.refetch();
          }}
          className="flex min-h-tap items-center rounded-control bg-accent-tint px-4 text-sm font-bold text-accent-ink"
        >
          {te("retry")}
        </button>
      </div>
    );
  }
  const w = query.data;
  if (w.status === "not_connected") return <NotConnected message={t("notConnected")} />;
  if (isEmptyWealth(w))
    return (
      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[1.6_1_480px] flex-col">
          <EmptyWealth />
        </div>
        <div className="flex min-w-0 flex-[1_1_300px] flex-col">
          <CanDo />
        </div>
      </div>
    );
  return (
    <div className="flex flex-col gap-5">
      <Summary w={w} />
      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[1.6_1_480px] flex-col gap-5">
          <Holdings w={w} />
          <ActivityTable w={w} />
        </div>
        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-5">
          <CanDo />
        </div>
      </div>
    </div>
  );
}
