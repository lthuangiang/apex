"use client";

import type { PlatformOverview, StatsInsight } from "@drift/shared";
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { formatDateTime, formatInteger, formatMoney } from "@/lib/format";

// Phần tổng quan của Platform Stats (DEC-139): insight tự sinh, KPI so với kỳ trước, phễu kích hoạt, sức khoẻ hệ
// thống, số liệu theo strategy và lý do bot dừng. Mọi số đến từ api; UI chỉ trình bày.

const SEV = {
  critical: { box: "border-neg-border bg-neg-soft", text: "text-neg-ink", Icon: OctagonAlert },
  warning: { box: "border-warn-bar/40 bg-warn-bg", text: "text-warn", Icon: AlertTriangle },
  info: { box: "border-border bg-surface", text: "text-accent-ink", Icon: Info },
  good: { box: "border-border bg-pos-bg", text: "text-pos", Icon: CheckCircle2 },
} as const;

function Panel({ title, children, sub }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-base font-extrabold">{title}</h2>
        {sub === undefined ? null : <span className="text-xs text-muted">{sub}</span>}
      </div>
      {children}
    </section>
  );
}

export function Insights({ items }: { items: readonly StatsInsight[] }) {
  const t = useTranslations("platformStats.ov");
  const ts = useTranslations("createBot.strategies");
  const tr = useTranslations("reasons");
  const tc = useTranslations("platformStats.ov.connectStep");
  if (items.length === 0)
    return (
      <p className="m-0 rounded-card border border-border bg-pos-bg px-4 py-3 text-sm font-bold text-pos">
        {t("allClear")}
      </p>
    );
  const params = (i: StatsInsight) => {
    const p: Record<string, string | number> = { ...i.params };
    if (typeof p.strategy === "string") p.strategy = ts(`${p.strategy}.name`);
    if (typeof p.reason === "string" && p.reason !== "") p.reason = tr(p.reason);
    if (typeof p.from === "string") p.from = tc(p.from);
    if (typeof p.to === "string") p.to = tc(p.to);
    return p;
  };
  return (
    <section aria-label={t("insightsTitle")} className="flex flex-col gap-2">
      {items.map((i) => {
        const s = SEV[i.severity];
        return (
          <div
            key={i.key}
            className={`flex items-start gap-3 rounded-[14px] border px-4 py-3 ${s.box}`}
          >
            <s.Icon
              aria-hidden="true"
              size={18}
              strokeWidth={2.4}
              className={`mt-0.5 shrink-0 ${s.text}`}
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <strong className={`text-sm ${s.text}`}>
                {t(`insight.${i.key}.title`, params(i))}
              </strong>
              <span className="text-sm text-ink-2">{t(`insight.${i.key}.body`, params(i))}</span>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function Delta({ cur, prev }: { cur: number; prev: number }) {
  const t = useTranslations("platformStats.ov");
  if (prev <= 0)
    return <span className="text-xs text-muted">{cur > 0 ? t("newThisPeriod") : t("noPrev")}</span>;
  const ch = ((cur - prev) / prev) * 100;
  const up = ch >= 0;
  return (
    <span className={`text-xs font-bold ${up ? "text-pos" : "text-neg-ink"}`}>
      {t("vsPrev", { sign: up ? "+" : "−", pct: Math.abs(ch).toFixed(0) })}
    </span>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-card border border-border bg-surface p-4">
      <span className="text-xs font-bold text-muted">{label}</span>
      <strong className="text-2xl font-extrabold tracking-tight tabular-nums">{value}</strong>
      <span>{sub}</span>
    </div>
  );
}

export function Kpis({ o, period }: { o: PlatformOverview; period: number }) {
  const t = useTranslations("platformStats.ov");
  const k = o.kpis;
  const signed = o.activation.find((a) => a.step === "signedUp")?.users ?? 0;
  const conn = o.activation.find((a) => a.step === "connected")?.users ?? 0;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi
        label={t("kpiActive", { period })}
        value={formatInteger(k.activeUsers.cur)}
        sub={<Delta cur={k.activeUsers.cur} prev={k.activeUsers.prev} />}
      />
      <Kpi
        label={t("kpiVolume", { period })}
        value={`${formatMoney(k.volume.cur) ?? "0"} USDC`}
        sub={<Delta cur={Number(k.volume.cur)} prev={Number(k.volume.prev)} />}
      />
      <Kpi
        label={t("kpiRevenue", { period })}
        value={`${formatMoney(k.revenue.cur) ?? "0"} USDC`}
        sub={
          <span className="text-xs text-muted">
            {k.revenuePerMillion === null
              ? t("noVolume")
              : t("perMillion", { v: formatMoney(k.revenuePerMillion) ?? k.revenuePerMillion })}
          </span>
        }
      />
      <Kpi
        label={t("kpiActivation")}
        value={signed > 0 ? `${((conn / signed) * 100).toFixed(0)}%` : "—"}
        sub={<span className="text-xs text-muted">{t("activationSub", { conn, signed })}</span>}
      />
    </div>
  );
}

export function Activation({ o }: { o: PlatformOverview }) {
  const t = useTranslations("platformStats.ov");
  const top = Math.max(1, o.activation[0]?.users ?? 1);
  return (
    <Panel title={t("activationTitle")} sub={t("activationHint")}>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {o.activation.map((a, i) => {
          const prev = i === 0 ? null : (o.activation[i - 1]?.users ?? 0);
          const lost = prev === null ? 0 : Math.max(0, prev - a.users);
          return (
            <li key={a.step} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-bold">{t(`step.${a.step}`)}</span>
                <span className="tabular-nums">
                  <strong>{formatInteger(a.users)}</strong>{" "}
                  <span className="text-xs text-muted">
                    {((a.users / top) * 100).toFixed(0)}%
                    {lost > 0 ? ` · ${t("lost", { n: lost })}` : ""}
                  </span>
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${String(Math.min(100, (a.users / top) * 100))}%` }}
                />
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

export function Health({ o }: { o: PlatformOverview }) {
  const t = useTranslations("platformStats.ov");
  const h = o.health;
  const priceOk = h.priceAgeSec !== null && h.priceAgeSec <= 60;
  const rows: { label: string; value: string; ok: boolean }[] = [
    {
      label: t("hPrice"),
      value: h.priceAgeSec === null ? t("hNoPrice") : t("hSecsAgo", { s: h.priceAgeSec }),
      ok: priceOk,
    },
    { label: t("hAttention"), value: formatInteger(h.needsAttention), ok: h.needsAttention === 0 },
    { label: t("hRejected"), value: formatInteger(h.rejected24h), ok: h.rejected24h < 50 },
    {
      label: t("hLastFill"),
      value: h.lastFillAt === null ? "—" : formatDateTime(h.lastFillAt),
      ok: true,
    },
  ];
  return (
    <Panel title={t("healthTitle")}>
      <dl className="m-0 flex flex-col gap-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-3 text-sm">
            <dt className="flex items-center gap-2 text-ink-2">
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${r.ok ? "bg-pos-dot" : "bg-neg"}`}
              />
              {r.label}
            </dt>
            <dd className="m-0 font-bold tabular-nums">{r.value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

export function Strategies({ o, period }: { o: PlatformOverview; period: number }) {
  const t = useTranslations("platformStats.ov");
  const ts = useTranslations("createBot.strategies");
  const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(0)}%`);
  return (
    <Panel title={t("strategiesTitle")} sub={t("strategiesHint", { period })}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm tabular-nums">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th scope="col" className="py-2 pr-3 font-bold">
                {t("colStrategy")}
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-bold">
                {t("colBots")}
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-bold">
                {t("colVolume")}
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-bold">
                {t("colFeeM")}
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-bold">
                {t("colFill")}
              </th>
              <th scope="col" className="py-2 text-right font-bold">
                {t("colReject")}
              </th>
            </tr>
          </thead>
          <tbody>
            {o.strategies.map((s) => (
              <tr key={s.strategy} className="border-t border-border">
                <td className="py-2 pr-3 font-bold">{ts(`${s.strategy}.name`)}</td>
                <td className="py-2 pr-3 text-right">
                  {s.running > 0 ? (
                    <span className="text-pos">{t("runningOf", { r: s.running, n: s.bots })}</span>
                  ) : (
                    formatInteger(s.bots)
                  )}
                </td>
                <td className="py-2 pr-3 text-right">{formatMoney(s.volume) ?? "0"}</td>
                <td className="py-2 pr-3 text-right">
                  {s.feePerMillion === null ? "—" : `$${s.feePerMillion}`}
                </td>
                <td
                  className={`py-2 pr-3 text-right ${s.fillRatePct !== null && s.fillRatePct < 25 ? "font-bold text-neg-ink" : ""}`}
                >
                  {pct(s.fillRatePct)}
                </td>
                <td
                  className={`py-2 text-right ${s.rejectRatePct !== null && s.rejectRatePct >= 20 ? "font-bold text-neg-ink" : ""}`}
                >
                  {pct(s.rejectRatePct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function Stops({ o, period }: { o: PlatformOverview; period: number }) {
  const t = useTranslations("platformStats.ov");
  const tr = useTranslations("reasons");
  const total = Math.max(
    1,
    o.stops.reduce((n, s) => n + s.bots, 0),
  );
  return (
    <Panel title={t("stopsTitle")} sub={t("stopsHint", { period })}>
      {o.stops.length === 0 ? (
        <p className="m-0 text-sm text-ink-2">{t("noStops")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {o.stops.map((s) => (
            <li key={s.reason ?? "user"} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span>{s.reason === null ? t("stoppedByUser") : tr(s.reason)}</span>
                <strong className="tabular-nums">{formatInteger(s.bots)}</strong>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-ink-2"
                  style={{ width: `${String((s.bots / total) * 100)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
