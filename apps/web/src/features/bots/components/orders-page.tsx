"use client";

import { botListSchema, orderListSchema, UserRole, type OrderView } from "@drift/shared";
import { Button, DataTable } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { NotConnected, useSodexMissing } from "@/components/not-connected";
import { PageHead } from "@/components/workspace";
import { WorkspaceShell } from "@/components/workspace-shell";
import { api } from "@/lib/api";
import { formatAmount, formatDateTime } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";
import { useMe } from "@/lib/queries";

import { orderTail } from "../decision-groups";

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

/** Màu pill trạng thái ở danh sách 390 px (artboard MobileOrders). */
function statusTone(s: OrderView["status"]): string {
  if (s === "filled" || s === "partially_filled") return "bg-pos-bg text-pos";
  if (s === "open") return "bg-accent-tint text-accent-ink";
  if (s === "unknown") return "bg-unknown-bg text-unknown";
  if (s === "rejected") return "bg-neg-bg text-neg-ink";
  return "bg-surface-2 text-ink-2 ring-1 ring-border ring-inset";
}

/** Thời gian làm nổi bật lệnh mở từ Decisions (BD-02): 2.5 s, sau đó chỉ còn nền và nhãn "From Decisions". */
const FLASH_MS = 2_500;

export function OrdersPage({
  botId,
  order,
  decision,
  at: decidedAt,
}: {
  botId?: string;
  /** BD-02: clOrdID mở từ pill Result của Decisions. */
  order?: string;
  /** Tên quyết định và thời điểm, để ghi trên banner. */
  decision?: string;
  at?: string;
}) {
  const t = useTranslations("orders");
  const tf = useTranslations("orders.fromDecisions");
  const router = useRouter();
  const te = useTranslations("common.errors");
  // SoDEX trả mã số; DRIFT tự đặt mã chữ (SELF_TRADE_BLOCKED…). Không đoán nghĩa mã số, chỉ ghi rõ là mã của SoDEX.
  const rejectLabel = (code: string | null) =>
    code === null
      ? ""
      : /^-?\d+$/.test(code)
        ? t("rejectCode", { code })
        : code === "SELF_TRADE_BLOCKED"
          ? t("selfTrade")
          : code;
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
  const tabRows = filtered.filter(TABS[tab]);
  // BD-02: lệnh mở từ Decisions. Có trong danh sách đang hiện → làm nổi bật; không có (cũ hơn trang đang tải hoặc bị bộ
  // lọc ẩn) → lọc theo đúng lệnh đó, có chip để bỏ lọc.
  const [cleared, setCleared] = useState(false);
  const focus = cleared ? undefined : order;
  const onPage = focus !== undefined && tabRows.some((o) => o.clOrdId === focus);
  const local = focus === undefined ? [] : all.filter((o) => o.clOrdId === focus);
  const narrowed = focus !== undefined && orders.isSuccess && !onPage;
  const one = useQuery({
    queryKey: ["orders", botId, "order", focus],
    enabled: narrowed && local.length === 0,
    queryFn: () =>
      api(
        "GET",
        `/api/v1/orders?${new URLSearchParams({ ...(botId === undefined ? {} : { botId }), order: focus ?? "" }).toString()}`,
        orderListSchema,
      ),
  });
  const rows = narrowed ? (local.length > 0 ? local : (one.data?.items ?? [])) : tabRows;
  const narrowPending = narrowed && local.length === 0 && one.isPending;
  const clearFocus = () => {
    setCleared(true);
    router.replace(`/orders${botId === undefined ? "" : `?botId=${botId}`}`, { scroll: false });
  };
  const target = rows.some((o) => o.clOrdId === focus);
  const [flash, setFlash] = useState(true);
  const moved = useRef(false);
  useEffect(() => {
    if (!target || moved.current) return;
    moved.current = true;
    // Dòng đang hiện (bảng hoặc danh sách 390 px): cuộn tới, chuyển focus để Tab / Esc đi tiếp từ đó.
    const el =
      [...document.querySelectorAll<HTMLElement>("[data-from-decisions]")].find(
        (x) => x.offsetParent !== null,
      ) ?? document.querySelector<HTMLElement>("[data-from-decisions]");
    el?.scrollIntoView({ block: "center" });
    el?.focus({ preventScroll: true });
    const id = window.setTimeout(() => {
      setFlash(false);
    }, FLASH_MS);
    return () => {
      window.clearTimeout(id);
    };
  }, [target]);
  const isFocus = (o: OrderView) => focus !== undefined && o.clOrdId === focus;
  const focusClass = () =>
    `bg-accent-tint ${flash ? "outline-2 -outline-offset-2 outline-accent" : ""} transition-[outline-color] duration-500`;
  const status =
    orders.isPending || narrowPending
      ? "loading"
      : orders.isError || (narrowed && one.isError)
        ? "error"
        : rows.length === 0
          ? "empty"
          : "ready";
  const symbols = [...new Set(all.map((o) => o.market))].sort();
  const c = orders.data?.counts;
  // Server đếm trên toàn bộ lệnh, nên số vẫn đúng khi danh sách bị cắt ở 200 dòng (DEC-90).
  const counts =
    c !== undefined && !missing
      ? [
          {
            key: "open",
            value: String(c.open),
            sub: t("counts.partial", { n: c.partiallyFilled }),
          },
          {
            key: "filledToday",
            value: String(c.filledToday),
            sub: t("counts.sinceMidnight"),
          },
          {
            key: "rejectedToday",
            value: String(c.rejectedToday),
            sub: c.lastRejectMessage ?? rejectLabel(c.lastRejectCode),
          },
        ]
      : null;

  return (
    <WorkspaceShell current="orders" isTeam={me.data?.role === UserRole.team}>
      <div className="flex flex-col gap-5">
        <PageHead title={t("title")} subtitle={t("subtitle")} />
        {focus === undefined ? null : (
          <div
            role="status"
            className="flex flex-col gap-1 rounded-[18px] bg-accent-tint px-3.5 py-3 text-[13.5px] text-ink md:flex-row md:flex-wrap md:items-center md:gap-x-3.5 md:gap-y-2 md:px-4 md:text-sm"
          >
            <span>
              {narrowed ? tf("bannerFiltered") : tf("banner")}{" "}
              {decision === undefined || decidedAt === undefined ? null : (
                <strong>
                  {tf("which", {
                    decision,
                    time: formatDateTime(decidedAt).split(", ").at(-1) ?? "",
                  })}
                </strong>
              )}
            </span>
            {botId === undefined ? null : (
              <Link
                href={`/agent/${botId}#decisions-title`}
                className="inline-flex min-h-tap items-center font-bold text-accent-ink no-underline md:ml-auto"
              >
                {tf("back")}
              </Link>
            )}
          </div>
        )}
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
                      {all.length >= ORDER_LIST_LIMIT ? "+" : ""}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {narrowed ? (
                <span className="inline-flex h-10 items-center gap-1.5 rounded-control bg-accent-tint pr-1 pl-3 text-[13px] font-bold text-accent-ink">
                  {tf("chip", { tail: orderTail(focus) })}
                  <button
                    type="button"
                    aria-label={tf("clearOrder")}
                    onClick={clearFocus}
                    className="flex size-8 cursor-pointer items-center justify-center rounded-[10px] border-0 bg-transparent text-base text-accent-ink"
                  >
                    ×
                  </button>
                </span>
              ) : null}
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
          {/* 390 px: danh sách thẻ (artboard MobileOrders); rỗng / đang tải / lỗi dùng chung trạng thái của bảng. */}
          {status === "ready" ? (
            <ul aria-label={t("caption")} className="m-0 list-none p-0 tabular-nums md:hidden">
              {rows.map((o) => {
                const q = names.qtyDigits(o.market);
                return (
                  <li
                    key={o.id}
                    {...(isFocus(o)
                      ? { tabIndex: -1, "aria-current": true, "data-from-decisions": "" }
                      : {})}
                    className={`flex flex-col gap-1 rounded-[14px] px-2.5 py-3 ${isFocus(o) ? focusClass() : "border-b border-border"}`}
                  >
                    <span className="flex justify-between gap-2">
                      <strong className="text-sm">
                        {t(`side.${o.side}`)} ·{" "}
                        {o.price === null
                          ? t("marketPrice")
                          : formatAmount(o.price, names.priceDigits(o.market))?.text}
                      </strong>
                      <span
                        className={`inline-flex min-h-6 items-center rounded-full px-[9px] text-xs font-bold ${statusTone(o.status)}`}
                      >
                        {t(`status.${o.status}`)}
                      </span>
                    </span>
                    <span className="text-[12.5px] text-ink-2">
                      {o.submittedAt === null ? "" : `${formatDateTime(o.submittedAt)} · `}
                      {names.market(o.market)} · {formatAmount(o.filledSize, q)?.text ?? ""} /{" "}
                      {formatAmount(o.size, q)?.text ?? ""}
                    </span>
                    {isFocus(o) ? (
                      <span className="text-[11.5px] font-extrabold text-accent-ink">
                        {tf("label")}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          <div className={status === "ready" ? "hidden md:block" : ""}>
            <DataTable
              caption={t("caption")}
              label={t("caption")}
              status={status}
              getRowProps={(o) =>
                isFocus(o)
                  ? {
                      tabIndex: -1,
                      "aria-current": true,
                      "data-from-decisions": "",
                      className: focusClass(),
                    }
                  : {}
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
                  cell: (o) => (
                    <>
                      {o.submittedAt === null ? "" : formatDateTime(o.submittedAt)}
                      {isFocus(o) ? (
                        <span className="mt-[3px] block text-[11.5px] font-extrabold text-accent-ink">
                          {tf("label")}
                        </span>
                      ) : null}
                    </>
                  ),
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
                        <span className="block text-xs text-muted">
                          {rejectLabel(o.rejectCode)}
                        </span>
                      )}
                      {o.rejectMessage === null ? null : (
                        <span className="block text-xs text-muted wrap-anywhere">
                          {o.rejectMessage}
                        </span>
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
          </div>
          {narrowed && status === "ready" ? (
            <p className="m-0 text-[13px] text-muted">
              {tf("showingOne")}{" "}
              <button
                type="button"
                onClick={clearFocus}
                className="min-h-9 cursor-pointer border-0 bg-transparent px-2.5 font-bold text-accent-ink"
              >
                {t("clearFilters")}
              </button>
            </p>
          ) : null}
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
