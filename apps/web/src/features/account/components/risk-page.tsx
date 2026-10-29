"use client";

import { dec, riskViewSchema, type RiskLimitKey, type RiskView } from "@drift/shared";
import { Button, ConfirmDialog, Field, inputClassName, Skeleton } from "@drift/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, OctagonX, ShieldCheck, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { z } from "zod";

import { NotConnected } from "@/components/not-connected";
import { Card, PageHead, Workspace } from "@/components/workspace";
import { useBotErrorText } from "@/features/bots/components/bot-errors";
import { api } from "@/lib/api";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";

import { negativeUsdc } from "./accounts-row";
import { Meter } from "./charts";
import { usePortfolio } from "./portfolio-page";

// Risk Center (artboard "Desktop · Risk Center"): giới hạn, mức hiện tại, ai chặn; alert; Emergency halt (2FA).

const response = z.object({ risk: riskViewSchema.nullable() });
const ITEMS: readonly { key: RiskLimitKey; server: boolean; unit: "%" | "×" | "" }[] = [
  { key: "dailyLossPct", server: true, unit: "%" },
  { key: "maxDrawdownPct", server: true, unit: "%" },
  { key: "perTradePct", server: true, unit: "%" },
  { key: "maxLeverage", server: false, unit: "×" },
  { key: "maxPositions", server: false, unit: "" },
];

/** Giá trị hiện tại dạng số (để tính % so với giới hạn); null khi backend không có. */
function currentNumber(r: RiskView, key: RiskLimitKey): string | null {
  const s = r.status;
  switch (key) {
    case "dailyLossPct":
      return s.dailyLossPct;
    case "maxDrawdownPct":
      return s.drawdownPct;
    case "perTradePct":
      return s.largestOrderTodayPct;
    case "maxLeverage":
      return s.highestLeverage === null ? null : String(s.highestLeverage.leverage);
    case "maxPositions":
      return s.openPositions === null ? null : String(s.openPositions);
  }
}

function current(r: RiskView, key: RiskLimitKey): string | null {
  const s = r.status;
  switch (key) {
    case "dailyLossPct":
      return s.dailyLossPct === null
        ? null
        : `${dec(s.dailyLossPct).toDecimalPlaces(2).toString()}%`;
    case "maxDrawdownPct":
      return s.drawdownPct === null ? null : `${dec(s.drawdownPct).toDecimalPlaces(2).toString()}%`;
    case "perTradePct":
      return s.largestOrderTodayPct === null
        ? null
        : `${dec(s.largestOrderTodayPct).toDecimalPlaces(2).toString()}%`;
    case "maxLeverage":
      return s.highestLeverage === null ? null : `${String(s.highestLeverage.leverage)}×`;
    case "maxPositions":
      return s.openPositions === null ? null : String(s.openPositions);
  }
}

export function RiskPage() {
  const t = useTranslations("risk");
  const ta = useTranslations("portfolio.accounts");
  const tm = useTranslations("common.missing");
  const names = useMarketNames();
  const qc = useQueryClient();
  const errorText = useBotErrorText();
  const q = useQuery({
    queryKey: ["risk"],
    queryFn: () => api("GET", "/api/v1/risk", response),
    refetchInterval: 15_000,
  });
  const r = q.data?.risk ?? null;
  const [edit, setEdit] = useState<RiskLimitKey | null>(null);
  const [value, setValue] = useState("");
  const [haltOpen, setHaltOpen] = useState(false);
  const [code, setCode] = useState("");
  const [halted, setHalted] = useState(false);
  const key = useRef(crypto.randomUUID());

  const save = useMutation({
    mutationFn: (v: string | null) =>
      api("PUT", "/api/v1/risk/limits", response, {
        idempotencyKey: key.current,
        body: { key: edit, value: v },
      }),
    onSuccess: async () => {
      setEdit(null);
      await qc.invalidateQueries({ queryKey: ["risk"] });
    },
    onSettled: () => {
      key.current = crypto.randomUUID();
    },
  });
  const ack = useMutation({
    mutationFn: (id: string) =>
      api("POST", `/api/v1/risk/alerts/${id}/ack`, z.unknown(), {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["risk"] });
    },
  });
  const halt = useMutation({
    mutationFn: () =>
      api("POST", "/api/v1/risk/halt", z.object({ stopping: z.number() }), {
        idempotencyKey: key.current,
        body: { twoFactorCode: code },
      }),
    onSuccess: async () => {
      setHaltOpen(false);
      setHalted(true);
      setCode("");
      await qc.invalidateQueries({ queryKey: ["risk"] });
    },
    onSettled: () => {
      key.current = crypto.randomUUID();
    },
  });

  const openAlerts = r?.alerts.filter((a) => a.resolvedAt === null) ?? [];
  const label = (k: RiskLimitKey) => t(`items.${k}.label`);
  const pf = usePortfolio().data?.portfolio ?? null;
  const negative = negativeUsdc(pf);
  const loading = q.isPending;

  /** Một thẻ giới hạn (artboard Risk / M-Risk): badge, số "of X", thanh tiến độ, dòng phụ, Edit. */
  const limitCard = (it: (typeof ITEMS)[number], rv: RiskView | null) => {
    const limRaw = rv?.limits[it.key] ?? null;
    const lim = limRaw === null ? null : String(limRaw);
    const cur = rv === null ? null : current(rv, it.key);
    const raw = rv === null ? null : currentNumber(rv, it.key);
    const pct =
      raw === null || lim === null || !dec(lim).gt(0)
        ? null
        : dec(raw).div(lim).mul(100).toNumber();
    const near = pct !== null && pct >= 80;
    const foot =
      rv === null
        ? null
        : it.key === "maxDrawdownPct" && rv.status.peakEquity !== null && rv.status.peakAt !== null
          ? t("items.maxDrawdownPct.peak", {
              amount: formatMoney(rv.status.peakEquity) ?? "",
              date: formatDate(rv.status.peakAt),
            })
          : it.key === "perTradePct"
            ? t("items.perTradePct.largest")
            : it.key === "maxLeverage" && rv.status.highestLeverage !== null
              ? t("items.maxLeverage.highest", {
                  market: names.market(rv.status.highestLeverage.market),
                  lev: rv.status.highestLeverage.leverage,
                })
              : null;
    return (
      <li
        key={it.key}
        className={`flex min-w-0 flex-col gap-2.5 rounded-tile border bg-surface p-4 ${near ? "border-[1.5px] border-warn-bar" : "border-border"}`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <strong className="text-sm">{label(it.key)}</strong>
            <span className="text-xs text-muted">{t(`items.${it.key}.sub`)}</span>
          </div>
          <span
            className={`flex-none rounded-full px-2.5 py-1 text-[11px] font-bold whitespace-nowrap ${rv === null ? "bg-surface-2 text-ink-2" : it.server ? "bg-pos-bg text-pos" : "bg-warn-bg text-warn"}`}
          >
            {rv === null ? (
              t("notAvailable")
            ) : (
              <>
                <span className="md:hidden">{it.server ? t("serverShort") : t("uiShort")}</span>
                <span className="hidden md:inline">
                  {it.server ? t("serverEnforced") : t("uiOnly")}
                </span>
              </>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 tabular-nums">
          {loading ? (
            <Skeleton className="h-7 w-24" />
          ) : (
            <span className="text-xl font-extrabold">{cur ?? t("notAvailable")}</span>
          )}
          <span className="text-xs text-muted">
            {lim === null ? t("noLimitSet") : t("of", { limit: `${lim}${it.unit}` })}
          </span>
        </div>
        {/* Chưa có giới hạn: không vẽ thanh tiến độ, chỉ còn nút "Set limit" (UI_REVIEW J6). */}
        {lim === null ? null : (
          <Meter
            pct={pct}
            tone={near || !it.server ? "warn" : "normal"}
            label={label(it.key)}
            size="md"
          />
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted">{foot ?? t(`items.${it.key}.body`)}</span>
          {rv === null ? null : (
            <button
              type="button"
              aria-label={`${lim === null ? t("setLimit") : t("edit")} ${label(it.key)}`}
              className="flex min-h-tap flex-none items-center rounded-control border border-border-input px-3 text-[13px] font-bold text-accent-ink"
              onClick={() => {
                setEdit(it.key);
                setValue(lim ?? "");
              }}
            >
              {lim === null ? t("setLimit") : t("edit")}
            </button>
          )}
        </div>
        {edit === it.key && rv !== null ? (
          <form
            className="flex flex-col gap-2 border-t border-border pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(value.trim() === "" ? null : value.trim());
            }}
          >
            <span className="text-sm font-bold">
              {t("editDialog.title", { label: label(it.key).toLowerCase() })}
            </span>
            <span className="text-xs text-ink-2">
              {t("editDialog.current")}: {lim === null ? t("notSet") : `${lim}${it.unit}`}
            </span>
            <Field
              label={t("editDialog.new")}
              unit={it.unit}
              {...(save.error === null ? {} : { error: errorText(save.error) })}
            >
              {(p) => (
                <input
                  {...p}
                  className={inputClassName}
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                  }}
                />
              )}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" pending={save.isPending}>
                {t("editDialog.send")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setEdit(null);
                }}
              >
                {t("editDialog.cancel")}
              </Button>
            </div>
          </form>
        ) : null}
      </li>
    );
  };

  const limitsCard = (rv: RiskView | null) => (
    <section
      aria-labelledby="limits-title"
      className="flex flex-col gap-4 rounded-card border border-border bg-surface p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="limits-title" className="m-0 text-lg font-extrabold">
          {t("limits")}
        </h2>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <Lock aria-hidden="true" size={14} className="text-pos" />
            {t("legendServer")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <TriangleAlert aria-hidden="true" size={14} className="text-warn" />
            {t("legendUi")}
          </span>
        </div>
      </div>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-3 p-0">
        {ITEMS.map((it) => limitCard(it, rv))}
        <li className="flex flex-col gap-2 rounded-tile border border-dashed border-border-input bg-surface-2 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <strong className="text-sm">{t("items.concentration.label")}</strong>
              <span className="text-xs text-muted">{t("items.concentration.sub")}</span>
            </div>
            <span className="flex-none rounded-full bg-surface px-2.5 py-1 text-[11px] font-bold whitespace-nowrap text-ink-2">
              {t("notAvailable")}
            </span>
          </div>
          <span className="text-xl font-extrabold text-ink-2">{t("notSet")}</span>
          <span className="text-xs text-muted">{t("items.concentration.body")}</span>
        </li>
      </ul>
      {rv === null ? null : <p className="m-0 text-xs text-muted">{t("pendingNote")}</p>}
    </section>
  );

  return (
    <Workspace current="risk">
      <div className="flex flex-col gap-5">
        <PageHead
          title={t("title")}
          subtitle={t("subtitle")}
          back={{ href: "/", label: t("title") }}
          updated={
            r?.checkedAt == null
              ? null
              : { label: (ago) => t("checked", { time: ago }), at: r.checkedAt }
          }
        />
        {negative === null ? null : (
          <p
            role="alert"
            className="m-0 rounded-card border border-neg-border bg-neg-soft px-5 py-4 text-sm text-neg-text"
          >
            {ta("negativeUsdc", { amount: `${formatMoney(negative) ?? negative} USDC` })}
          </p>
        )}
        {q.isSuccess && r === null ? (
          <>
            <NotConnected message={t("noAccount")} />
            {/* Giữ khung trang khi chưa kết nối: cùng các section, giá trị "Not available". */}
            {limitsCard(null)}
            <div className="flex flex-wrap items-start gap-5">
              <Card title={t("alerts")} className="flex-[2_1_420px]">
                <p className="m-0 text-sm text-ink-2">{tm("notAvailable")}</p>
              </Card>
              <section
                aria-labelledby="halt-title"
                className="flex min-w-0 flex-[1_1_280px] flex-col gap-2 rounded-card border border-neg-border bg-neg-soft p-5"
              >
                <h2 id="halt-title" className="m-0 text-lg font-extrabold text-neg-text">
                  {t("halt.title")}
                </h2>
                <p className="m-0 text-sm text-neg-text">{tm("notAvailable")}</p>
              </section>
            </div>
          </>
        ) : null}
        {r === null ? null : (
          <>
            {/* Banner trạng thái (artboard Risk): gradient, icon khiên, nút See alerts. */}
            <section
              role="status"
              className={`flex flex-wrap items-center gap-4 rounded-card p-5 ${openAlerts.length === 0 ? "bg-hero" : "bg-neg-bg"}`}
            >
              <span
                aria-hidden="true"
                className={`flex size-12 flex-none items-center justify-center rounded-[14px] bg-surface ${openAlerts.length === 0 ? "text-pos" : "text-neg-ink"}`}
              >
                <ShieldCheck size={26} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <strong className="text-base">
                  {openAlerts.length === 0
                    ? t("within")
                    : t("breachedTitle", { n: openAlerts.length })}
                </strong>
                <span className="text-sm text-ink-body">
                  {openAlerts.length > 0
                    ? t("breachedBody")
                    : t("passCount", { n: ITEMS.filter((i) => i.server).length })}
                </span>
              </div>
              {openAlerts.length === 0 ? null : (
                <a
                  href="#alerts"
                  className="flex min-h-tap items-center rounded-control bg-surface px-4 text-sm font-bold text-accent-ink no-underline"
                >
                  {t("seeAlerts")}
                </a>
              )}
            </section>

            {limitsCard(r)}

            <div className="flex flex-wrap items-start gap-5">
              <section
                id="alerts"
                aria-labelledby="alerts-title"
                className="flex min-w-0 flex-[2_1_420px] flex-col gap-3 rounded-card border border-border bg-surface p-5"
              >
                <h2 id="alerts-title" className="m-0 text-lg font-extrabold">
                  {t("alerts")}
                </h2>
                {r.alerts.length === 0 ? (
                  <p className="m-0 text-sm text-ink-2">{t("noAlerts")}</p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-3 p-0">
                    {r.alerts.map((a) => (
                      <li
                        key={a.id}
                        className="flex flex-col gap-1 rounded-tile border border-border p-3 text-sm"
                      >
                        <span
                          className={`self-start rounded-full px-2 py-0.5 text-[11px] font-bold ${a.severity === "critical" ? "bg-neg-bg text-neg-ink" : a.severity === "warning" ? "bg-warn-bg text-warn" : "bg-accent-tint text-accent-ink"}`}
                        >
                          {t(`severity.${a.severity}`)}
                        </span>
                        <strong>
                          {t(
                            `alert.${a.kind === "daily_loss" ? "daily_loss" : "max_drawdown"}.title`,
                          )}
                        </strong>
                        <span>
                          {t(
                            `alert.${a.kind === "daily_loss" ? "daily_loss" : "max_drawdown"}.body`,
                            {
                              loss:
                                typeof a.data.lossPct === "string"
                                  ? dec(a.data.lossPct).toDecimalPlaces(2).toString()
                                  : "",
                              dd:
                                typeof a.data.drawdownPct === "string"
                                  ? dec(a.data.drawdownPct).toDecimalPlaces(2).toString()
                                  : "",
                            },
                          )}
                        </span>
                        <span className="text-xs text-muted">
                          {formatDateTime(a.occurredAt)}
                          {a.resolvedAt === null
                            ? ""
                            : ` · ${t("resolved", { time: formatDateTime(a.resolvedAt) })}`}
                        </span>
                        {a.acknowledgedAt === null ? (
                          <Button
                            variant="secondary"
                            className="self-start"
                            onClick={() => {
                              ack.mutate(a.id);
                            }}
                          >
                            {t("ack")}
                          </Button>
                        ) : (
                          <span className="text-xs text-muted">{t("acked")}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section
                id="halt"
                aria-labelledby="halt-title"
                className="flex min-w-0 flex-[1_1_280px] flex-col gap-3 rounded-card border border-neg-border bg-neg-soft p-5 text-neg-text"
              >
                <span
                  aria-hidden="true"
                  className="flex size-11 items-center justify-center rounded-[14px] bg-neg-bg text-neg-ink"
                >
                  <OctagonX size={22} />
                </span>
                <h2 id="halt-title" className="m-0 text-lg font-extrabold">
                  {t("halt.title")}
                </h2>
                <ul className="m-0 flex flex-col gap-1.5 pl-[18px] text-sm leading-[1.45]">
                  <li>
                    {t("haltStops", {
                      agents: t("halt.agents", { n: r.halt.running + r.halt.paused }),
                      running: r.halt.running,
                      paused: r.halt.paused,
                    })}
                  </li>
                  <li>
                    {t("haltCancels", { orders: t("halt.orders", { n: r.halt.openOrders }) })}
                  </li>
                  <li>
                    {t("haltNoClose", {
                      positions:
                        r.halt.positions === null
                          ? t("notAvailable")
                          : t("halt.positions", { n: r.halt.positions }),
                    })}
                  </li>
                </ul>
                <button
                  type="button"
                  className="flex min-h-12 items-center justify-center rounded-[14px] bg-neg text-[15px] font-extrabold text-white"
                  onClick={() => {
                    setHaltOpen(true);
                  }}
                >
                  {t("halt.cta")}
                </button>
                <p className="m-0 text-xs">{t("halt.note")}</p>
                {halted ? (
                  <p role="status" className="m-0 text-sm font-bold">
                    {t("halt.done")}
                  </p>
                ) : null}
              </section>
            </div>

            <ConfirmDialog
              open={haltOpen}
              onOpenChange={setHaltOpen}
              title={t("halt.dialog")}
              consequencesLabel={t("halt.title")}
              consequences={[
                t("halt.agents", { n: r.halt.running + r.halt.paused }),
                t("halt.orders", { n: r.halt.openOrders }),
              ]}
              confirmLabel={t("halt.confirm")}
              cancelLabel={t("halt.cancel")}
              tone="danger"
              twoFactor={{
                label: t("halt.twoFactor"),
                value: code,
                onChange: setCode,
                ...(halt.error === null ? {} : { error: errorText(halt.error) }),
              }}
              pending={halt.isPending}
              onConfirm={() => {
                halt.mutate();
              }}
            />
          </>
        )}
      </div>
    </Workspace>
  );
}
