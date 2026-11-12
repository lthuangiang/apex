"use client";

import { dec } from "@drift/shared";
import { Skeleton } from "@drift/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { formatMoney } from "@/lib/format";

import { BalanceChart } from "./balance-chart";
import { PaperChip } from "./paper-chip";
import { usePaperView } from "./paper-view";

// AI Desk › Test results (AI_DESK_RECOMMENDED.md mục 8.5): kết luận là quy tắc cố định (`paperVerdict`), không bao
// giờ kết luận "nên dùng tiền thật". So với chỉ giữ coin luôn hiện, kể cả khi bot thua.

const BTN =
  "flex min-h-tap items-center justify-center rounded-control px-4 text-sm font-bold no-underline";

export function ResultsPage({ id }: { id: string }) {
  const t = useTranslations("desk.results");
  const tp = useTranslations("desk.paper");
  const te = useTranslations("common.errors");
  const tm = useTranslations("common.missing");
  const q = usePaperView(id);
  const v = q.data;
  const limit = v?.lossLimit.kind === "limit" ? v.lossLimit.amount : null;
  const stopped = v?.bot.state === "stopped";
  const made = v?.verdict === "made";
  const sub =
    v === undefined
      ? ""
      : stopped
        ? t("sub.stopped", { day: v.day })
        : v.verdict === "too_early"
          ? t("sub.early", { day: v.day, min: v.minDays })
          : t("sub.running", { day: v.day });
  const holdBetter = v?.hold.amount != null && v.net !== null ? dec(v.hold.amount).gt(v.net) : null;

  return (
    <Workspace current="desk">
      <div className="flex flex-col gap-5">
        <Link href={`/desk/paper/${id}`} className="self-start text-sm font-bold text-accent-ink">
          ← {t("back")}
        </Link>
        {q.isPending ? <Skeleton className="h-64 w-full rounded-card" /> : null}
        {q.isError ? (
          <p role="alert" className="m-0">
            {te("generic")}
          </p>
        ) : null}
        {v === undefined ? null : (
          <>
            <PageHead
              paper
              title={t("title", { name: v.bot.name })}
              subtitle={t("subtitle")}
              action={<PaperChip />}
            />
            <section
              aria-labelledby="verdict"
              className="flex flex-col gap-1 rounded-hero bg-hero px-6 py-6"
            >
              <h2 id="verdict" className="m-0 text-2xl font-extrabold">
                {t(`verdict.${v.verdict}`)}
              </h2>
              <p className="m-0 text-sm text-ink-2">{sub}</p>
            </section>
            <section
              className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3"
              aria-label={t("result")}
            >
              <div className="flex flex-col gap-1 rounded-card border border-border bg-surface p-4">
                <span className="text-xs text-muted">{t("result")}</span>
                <strong className="text-xl font-extrabold tabular-nums">
                  {v.net === null ? tm("notAvailable") : `${formatMoney(v.net, true) ?? ""} USDC`}
                </strong>
                <span className="text-xs text-ink-2 tabular-nums">
                  {t("balance", {
                    balance:
                      v.equity === null
                        ? tm("notAvailable")
                        : `${formatMoney(v.equity) ?? ""} USDC`,
                  })}
                </span>
              </div>
              <div className="flex flex-col gap-1 rounded-card border border-border bg-surface p-4">
                <span className="text-xs text-muted">{t("drop")}</span>
                <strong className="text-xl font-extrabold tabular-nums">
                  {dec(v.maxDrawdown).isZero()
                    ? formatMoney("0")
                    : `−${formatMoney(v.maxDrawdown) ?? ""}`}{" "}
                  USDC
                </strong>
                <span className="text-xs text-ink-2 tabular-nums">
                  {limit === null
                    ? t("noLimit")
                    : t("yourLimit", { limit: formatMoney(limit) ?? limit })}
                </span>
              </div>
              <div className="flex flex-col gap-1 rounded-card border border-border bg-surface p-4">
                <span className="text-xs text-muted">{t("feesTrades")}</span>
                <strong className="text-xl font-extrabold tabular-nums">
                  {formatMoney(v.fees)} USDC
                </strong>
                <span className="text-xs text-ink-2">{t("tradesCount", { count: v.fills })}</span>
              </div>
            </section>
            {v.daily.length < 2 ? null : (
              <Card title={tp("chart")}>
                <BalanceChart
                  points={v.daily}
                  capital={v.capital}
                  label={tp("chart")}
                  caption={tp("chartStart", { capital: formatMoney(v.capital) ?? v.capital })}
                />
              </Card>
            )}
            <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-2">
              <Card title={t("hold", { asset: v.hold.asset })}>
                <strong className="text-lg font-extrabold tabular-nums">
                  {v.hold.amount === null
                    ? t("holdNa")
                    : `${formatMoney(v.hold.amount, true) ?? ""} USDC`}
                </strong>
                {holdBetter === null || v.hold.changePct === null ? null : (
                  <p className="m-0 text-sm text-ink-2">
                    {t(holdBetter ? "holdBetter" : "holdWorse", {
                      asset: v.hold.asset,
                      pct: v.hold.changePct,
                    })}
                  </p>
                )}
              </Card>
              <Card title={t("why")}>
                <ul className="m-0 flex flex-col gap-1.5 pl-4 text-sm">
                  {v.reasons.map((r) => (
                    <li key={r.key}>
                      {r.key === "noFills" || r.key === "stopped"
                        ? t(`reason.${r.key}`)
                        : r.key === "fills"
                          ? t("reason.fills", { count: r.count })
                          : t(`reason.${r.key}`, { pct: r.pct })}
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
            <p className="m-0 text-xs text-muted">{t("disclaimer")}</p>
            <section aria-labelledby="next" className="flex flex-col gap-3">
              <h2 id="next" className="m-0 text-lg font-extrabold">
                {t("next")}
              </h2>
              <div className="flex flex-wrap gap-2.5">
                <Link
                  href={`/desk/paper/${id}/go-live`}
                  className={`${BTN} ${
                    made
                      ? "bg-accent text-white hover:bg-accent-ink"
                      : "border border-border-input bg-surface text-ink hover:bg-surface-2"
                  }`}
                >
                  {t("useReal")}
                </Link>
                {stopped ? null : (
                  <Link
                    href={`/desk/paper/${id}`}
                    className={`${BTN} border border-border-input bg-surface text-ink hover:bg-surface-2`}
                  >
                    {t("keep")}
                  </Link>
                )}
                <Link
                  href="/desk"
                  className={`${BTN} border border-border-input bg-surface text-ink hover:bg-surface-2`}
                >
                  {t("another")}
                </Link>
              </div>
              <p className="m-0 text-xs text-muted">{t("decision")}</p>
            </section>
          </>
        )}
      </div>
    </Workspace>
  );
}
