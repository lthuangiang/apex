"use client";

import { botSummarySchema, dec } from "@drift/shared";
import { Button, ConfirmDialog, Skeleton } from "@drift/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { api, ApiError } from "@/lib/api";
import { formatAmount, formatDateTime, formatMoney } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";

import { BalanceChart } from "./balance-chart";
import { PaperChip } from "./paper-chip";
import { usePaperView } from "./paper-view";

// AI Desk › Fake-money test (AI_DESK_RECOMMENDED.md mục 8.4): mọi số là mô phỏng, có nhãn PAPER. Stop test không cần
// 2FA vì không có tiền thật (DEC-105).

export function PaperPage({ id }: { id: string }) {
  const t = useTranslations("desk.paper");
  const te = useTranslations("common.errors");
  const tm = useTranslations("common.missing");
  const names = useMarketNames();
  const qc = useQueryClient();
  const q = usePaperView(id);
  const [confirm, setConfirm] = useState(false);
  const key = useRef(crypto.randomUUID());
  const stop = useMutation({
    mutationFn: () =>
      api("POST", `/api/v1/bots/${id}/actions/stop`, botSummarySchema, {
        idempotencyKey: key.current,
        body: {},
      }),
    onSuccess: async () => {
      setConfirm(false);
      await qc.invalidateQueries({ queryKey: ["desk"] });
    },
    onSettled: () => {
      key.current = crypto.randomUUID();
    },
  });
  const v = q.data;
  const stopped = v !== undefined && (v.bot.state === "stopped" || v.bot.state === "stopping");
  const limit = v?.lossLimit.kind === "limit" ? v.lossLimit.amount : null;

  return (
    <Workspace current="desk">
      <div className="flex flex-col gap-5">
        <Link href="/desk" className="self-start text-sm font-bold text-accent-ink">
          ← {t("back")}
        </Link>
        {q.isPending ? <Skeleton className="h-64 w-full rounded-card" /> : null}
        {q.isError ? (
          <p role="alert" className="m-0">
            {q.error instanceof ApiError && q.error.code === "BOT_NOT_FOUND"
              ? t("notFound")
              : te("generic")}
          </p>
        ) : null}
        {v === undefined ? null : (
          <>
            <PageHead paper title={v.bot.name} subtitle={t("subtitle")} action={<PaperChip />} />
            <div className="lg:hidden">
              <PaperChip />
            </div>
            <section
              className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4"
              aria-label={t("balance")}
            >
              <div className="col-span-2 flex flex-col gap-1 rounded-card border border-border bg-surface p-4 lg:col-span-1">
                <span className="text-xs text-muted">{t("balance")}</span>
                <strong className="text-2xl font-extrabold tabular-nums">
                  {v.equity === null ? tm("notAvailable") : `${formatMoney(v.equity) ?? ""} USDC`}
                </strong>
                {v.net === null ? null : (
                  <span
                    className={`text-xs font-bold tabular-nums ${dec(v.net).lt(0) ? "text-neg-ink" : "text-pos"}`}
                  >
                    {t("afterFees", { net: formatMoney(v.net, true) ?? "", day: v.day })}
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-1 rounded-card border border-border bg-surface p-4">
                <span className="text-xs text-muted">{t("fees")}</span>
                <strong className="text-lg font-extrabold tabular-nums">
                  {formatMoney(v.fees)} USDC
                </strong>
              </div>
              <div className="flex flex-col gap-1 rounded-card border border-border bg-surface p-4">
                <span className="text-xs text-muted">{t("trades")}</span>
                <strong className="text-lg font-extrabold tabular-nums">{v.fills}</strong>
              </div>
              <div className="flex flex-col gap-1 rounded-card border border-border bg-surface p-4">
                <span className="text-xs text-muted">{t("drop")}</span>
                <strong className="text-lg font-extrabold tabular-nums">
                  {dec(v.maxDrawdown).isZero()
                    ? `${formatMoney("0") ?? ""} USDC`
                    : `−${formatMoney(v.maxDrawdown) ?? ""} USDC`}
                </strong>
              </div>
            </section>
            {v.fills > 0 &&
            (v.bot.strategy === "spot_grid" || v.bot.strategy === "futures_grid") ? (
              <p className="m-0 rounded-tile bg-surface-2 px-3.5 py-3 text-sm text-ink-2">
                {t("gridStart")}
              </p>
            ) : null}
            <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <Card title={t("chart")}>
                {v.fills === 0 ? (
                  <p className="m-0 text-sm text-ink-2">{t("waiting")}</p>
                ) : v.daily.length < 2 ? (
                  <p className="m-0 text-sm text-ink-2">{tm("notAvailable")}</p>
                ) : (
                  <BalanceChart
                    points={v.daily}
                    capital={v.capital}
                    label={t("chart")}
                    caption={t("chartStart", { capital: formatMoney(v.capital) ?? v.capital })}
                  />
                )}
              </Card>
              <Card title={t("limit")}>
                {limit === null ? (
                  <p className="m-0 text-sm text-ink-2">{t("noLimit")}</p>
                ) : (
                  <>
                    <p className="m-0 text-sm font-bold tabular-nums">
                      {t("worst", {
                        drop: formatMoney(v.maxDrawdown) ?? "",
                        limit: formatMoney(limit) ?? limit,
                      })}
                    </p>
                    <div
                      className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
                      role="presentation"
                    >
                      <div
                        className="h-full rounded-full bg-warn-bar"
                        style={{
                          width: `${String(Math.min(100, (Number(v.maxDrawdown) / Math.max(Number(limit), 1e-9)) * 100))}%`,
                        }}
                      />
                    </div>
                    <p className="m-0 text-xs text-muted">
                      {t("stopsNear", { limit: formatMoney(limit) ?? limit })}
                    </p>
                  </>
                )}
              </Card>
            </div>
            <Card title={t("did")}>
              {v.activity.length === 0 ? (
                <p className="m-0 text-sm text-ink-2">{t("nothingYet")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col p-0">
                  {v.activity.map((a, i) => (
                    <li
                      key={`${a.at}${String(i)}`}
                      className="flex flex-col gap-0.5 border-b border-border py-2.5 last:border-b-0 sm:flex-row sm:gap-4"
                    >
                      <span className="w-36 flex-none text-xs text-muted tabular-nums">
                        {formatDateTime(a.at)}
                      </span>
                      <span className="text-sm">
                        {a.kind === "fill"
                          ? t(a.side === "buy" ? "bought" : "sold", {
                              size:
                                formatAmount(a.size, names.qtyDigits(a.market ?? ""))?.text ?? "",
                              price:
                                formatAmount(a.price, names.priceDigits(a.market ?? ""))?.text ??
                                "",
                            })
                          : `${a.decision ?? ""}${a.why === null ? "" : ` · ${a.why}`}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <p className="m-0 text-xs text-muted">{t("disclaimer")}</p>
            {stopped ? <p className="m-0 text-sm font-bold">{t("stopped")}</p> : null}
            {stop.isError ? (
              <p role="alert" className="m-0 text-sm text-neg-ink">
                {te("generic")}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2.5">
              {stopped ? null : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setConfirm(true);
                  }}
                >
                  {t("stop")}
                </Button>
              )}
              <Link
                href={`/desk/paper/${id}/results`}
                className="flex min-h-tap items-center rounded-control bg-accent px-4 text-sm font-bold text-white no-underline hover:bg-accent-ink"
              >
                {t("results")}
              </Link>
            </div>
            <ConfirmDialog
              open={confirm}
              onOpenChange={setConfirm}
              title={t("stopTitle")}
              consequencesLabel={t("stopList")}
              consequences={[t("stopOne"), t("stopTwo")]}
              confirmLabel={t("stop")}
              cancelLabel={t("cancel")}
              pending={stop.isPending}
              pendingLabel={t("stopping")}
              onConfirm={() => {
                stop.mutate();
              }}
            />
          </>
        )}
      </div>
    </Workspace>
  );
}
