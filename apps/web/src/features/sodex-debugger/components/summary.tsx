"use client";

import type { SodexCallSummary } from "@drift/shared";
import { Button, Skeleton } from "@drift/ui";
import { useTranslations } from "next-intl";
import { Fragment, useState } from "react";

import { useSodexSummary } from "../api";
import { formatCount, formatMs, formatRate, localTime, utcHour, utcMinute } from "../format";

import { Path } from "./bits";

// Dải tóm tắt 24 giờ (mockup: thẻ "Last 24 hours" + "By endpoint"). Mọi số lấy từ API; tỷ lệ lỗi = errors / calls.

const HOUR_MS = 3_600_000;
const AXIS = [0, 6, 12, 18, 23];
const card = "min-w-0 rounded-card border border-border bg-surface px-[18px] py-4 max-md:p-3.5";

export function Summary({
  slowMs,
  myTime,
  onPickHour,
  narrow,
  live = false,
}: {
  slowMs: number;
  myTime: boolean;
  onPickHour: (hourIso: string) => void;
  /** Panel chi tiết đang mở trên desktop: hai thẻ xếp dọc (mockup body.d-open). */
  narrow: boolean;
  /** Live đang chạy: tải lại cùng danh sách. */
  live?: boolean;
}) {
  const t = useTranslations("sodexDebugger.summary");
  const q = useSodexSummary(live);
  return (
    <section
      aria-label={t("label")}
      className={`grid grid-cols-1 gap-4 ${narrow ? "md:max-lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]" : "md:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]"}`}
    >
      {q.isPending ? (
        <div aria-busy="true" className={`${card} md:col-span-full`}>
          <span className="sr-only">{t("loading")}</span>
          <Skeleton className="h-40 w-full" />
        </div>
      ) : q.isError ? (
        <div role="alert" className={`${card} flex flex-col items-start gap-3 md:col-span-full`}>
          <p className="m-0 font-bold">{t("error")}</p>
          <Button
            variant="secondary"
            onClick={() => {
              void q.refetch();
            }}
          >
            {t("retry")}
          </Button>
        </div>
      ) : (
        <>
          <Overview s={q.data} myTime={myTime} onPickHour={onPickHour} />
          <ByEndpoint s={q.data} slowMs={slowMs} />
        </>
      )}
    </section>
  );
}

function Overview({
  s,
  myTime,
  onPickHour,
}: {
  s: SodexCallSummary;
  myTime: boolean;
  onPickHour: (hourIso: string) => void;
}) {
  const t = useTranslations("sodexDebugger.summary");
  const rate = formatRate(s.errors, s.calls);
  const max = Math.max(1, ...s.timeoutsPerHour.map((h) => h.count));
  const peakIdx =
    s.peak === null ? -1 : s.timeoutsPerHour.findIndex((h) => h.hour === s.peak?.hour);
  const and = (list: string[]) =>
    list.map((ep, i) => (
      <Fragment key={ep}>
        {i === 0 ? "" : i === list.length - 1 ? ` ${t("and")} ` : ", "}
        <span className="font-mono">{ep}</span>
      </Fragment>
    ));
  return (
    <div className={card}>
      <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="m-0 text-[15px] font-extrabold">{t("title")}</h2>
        <span className="text-[13px] text-muted">{t("utc")}</span>
      </div>
      <dl className="m-0 mb-3.5 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Kpi label={t("calls")} value={formatCount(s.calls)} />
        <Kpi
          label={t("errorRate")}
          value={rate === null ? t("notAvailable") : `${s.errorsAboveUsual ? "▲ " : ""}${rate}`}
          hi={s.errorsAboveUsual}
        />
        <Kpi
          label={t("timeouts")}
          value={`${s.timeoutsAboveUsual ? "▲ " : ""}${formatCount(s.timeouts)}`}
          hi={s.timeoutsAboveUsual}
        />
        <Kpi label={t("p95")} value={s.p95Ms === null ? t("notAvailable") : formatMs(s.p95Ms)} />
      </dl>
      <h3 className="m-0 text-[13px] font-extrabold text-ink">{t("perHour")}</h3>
      <div
        role="group"
        aria-label={t("perHourLabel")}
        className="relative flex h-[92px] items-end gap-[3px] pt-[18px]"
      >
        {s.timeoutsPerHour.map((h, i) => {
          const from = utcHour(h.hour);
          const to = utcHour(new Date(Date.parse(h.hour) + HOUR_MS).toISOString());
          const label = t("bar", { from, to, count: h.count });
          return (
            <button
              key={h.hour}
              type="button"
              aria-label={label}
              title={label}
              onClick={() => {
                onPickHour(h.hour);
              }}
              style={{ height: h.count === 0 ? 2 : Math.max(6, Math.round((h.count / max) * 74)) }}
              className={`min-w-1 flex-1 cursor-pointer border-0 p-0 ${h.count === 0 ? "rounded-sm bg-border" : i === peakIdx ? "rounded-t bg-neg" : "rounded-t bg-warn-bar"}`}
            />
          );
        })}
        {s.peak === null || peakIdx < 0 ? null : (
          <span
            aria-hidden="true"
            className="absolute top-0 text-xs font-extrabold whitespace-nowrap text-ink"
            style={
              peakIdx > 16
                ? { right: `${String(((23 - peakIdx) / 24) * 100)}%` }
                : { left: `${String((peakIdx / 24) * 100)}%` }
            }
          >
            {myTime
              ? t("peakLocal", {
                  count: s.peak.count,
                  hour: utcHour(s.peak.hour),
                  local: localTime(s.peak.hour).slice(0, 5),
                })
              : t("peak", { count: s.peak.count, hour: utcHour(s.peak.hour) })}
          </span>
        )}
      </div>
      <div
        aria-hidden="true"
        className="mt-1.5 flex justify-between border-t border-border pt-1 text-[11.5px] text-muted"
      >
        {AXIS.map((i) => {
          const h = s.timeoutsPerHour[i];
          return h === undefined ? null : <span key={i}>{utcHour(h.hour)}</span>;
        })}
      </div>
      <p className="m-0 mt-2 text-[12.5px] leading-[1.45] text-ink-2">
        {s.timeouts === 0 ? (
          t("noTimeouts")
        ) : (
          <>
            <b>{t("total", { count: s.timeouts })}</b>
            {s.peak === null
              ? "."
              : t.rich("peakSentence", {
                  count: s.peak.count,
                  from: utcMinute(s.peak.firstAt),
                  to: utcMinute(s.peak.lastAt),
                  ep: () => and(s.peak?.endpoints ?? []),
                })}{" "}
            {t("selectBar")}
          </>
        )}
      </p>
    </div>
  );
}

function Kpi({ label, value, hi = false }: { label: string; value: string; hi?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-[14px] bg-surface-2 px-2.5 py-2">
      <dt className="text-xs font-bold text-ink-2">{label}</dt>
      <dd className={`m-0 text-lg font-extrabold ${hi ? "text-neg-ink" : ""}`}>{value}</dd>
    </div>
  );
}

function ByEndpoint({ s, slowMs }: { s: SodexCallSummary; slowMs: number }) {
  const t = useTranslations("sodexDebugger.summary");
  const [open, setOpen] = useState(false);
  const rates = s.endpoints.map((e) => (e.calls === 0 ? 0 : e.errors / e.calls));
  const maxRate = Math.max(0, ...rates);
  const allRate = formatRate(s.errors, s.calls);
  const th =
    "px-2 py-1.5 text-right text-[11.5px] font-extrabold tracking-[.02em] whitespace-nowrap text-muted max-md:px-1";
  const td =
    "border-t border-border px-2 py-[7px] text-right text-[13px] whitespace-nowrap max-md:px-1 max-md:text-xs";
  return (
    <div className={card}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="m-0 text-[15px] font-extrabold">{t("byEndpoint")}</h2>
        <span className="text-[13px] text-muted max-md:hidden">{t("byEndpointNote")}</span>
        <Button
          variant="secondary"
          aria-expanded={open}
          className="min-h-9 px-3 text-[13px] md:hidden"
          onClick={() => {
            setOpen((o) => !o);
          }}
        >
          {open ? t("hide") : t("show")}
        </Button>
      </div>
      <div className={`mt-2.5 ${open ? "" : "max-md:hidden"}`}>
        <table className="w-full border-collapse">
          <caption className="sr-only">{t("caption")}</caption>
          <thead>
            <tr>
              <th scope="col" className={`${th} pl-0 text-left`}>
                {t("colEndpoint")}
              </th>
              <th scope="col" className={`${th} max-md:hidden`}>
                {t("colCalls")}
              </th>
              <th scope="col" className={th}>
                {t("colErrorRate")}
              </th>
              <th scope="col" className={th}>
                {t("colTimeouts")}
              </th>
              <th scope="col" className={th}>
                {t("colP95")}
              </th>
            </tr>
          </thead>
          <tbody>
            {s.endpoints.map((e, i) => {
              const rate = formatRate(e.errors, e.calls);
              const slow = e.p95Ms !== null && e.p95Ms > slowMs;
              return (
                <tr key={`${e.method} ${e.endpoint}`}>
                  <td className={`${td} pl-0 text-left whitespace-normal`}>
                    <span className="font-mono max-md:text-[11.5px]">
                      {e.method} <Path path={e.endpoint} />
                    </span>
                  </td>
                  <td className={`${td} max-md:hidden`}>{formatCount(e.calls)}</td>
                  <td className={td}>
                    <span className="inline-flex items-center justify-end gap-2">
                      <span
                        aria-hidden="true"
                        className="inline-block h-1.5 w-14 overflow-hidden rounded-[3px] bg-surface-2 max-md:hidden"
                      >
                        <i
                          className="block h-full rounded-[3px] bg-neg"
                          style={{
                            width: `${String(maxRate === 0 ? 0 : Math.round(((rates[i] ?? 0) / maxRate) * 100))}%`,
                          }}
                        />
                      </span>
                      <span className={e.errorsAboveUsual ? "font-extrabold text-neg-ink" : ""}>
                        {e.errorsAboveUsual ? "▲ " : ""}
                        {rate ?? t("notAvailable")}
                      </span>
                    </span>
                  </td>
                  <td className={`${td} ${e.timeoutsAboveUsual ? "font-extrabold text-warn" : ""}`}>
                    {e.timeoutsAboveUsual ? "▲ " : ""}
                    {formatCount(e.timeouts)}
                  </td>
                  <td className={`${td} ${slow ? "font-extrabold text-warn" : ""}`}>
                    {e.p95Ms === null
                      ? t("notAvailable")
                      : `${slow ? "▲ " : ""}${formatMs(e.p95Ms)}`}
                  </td>
                </tr>
              );
            })}
            <tr className="font-extrabold">
              <td className={`${td} border-t-2 pl-0 text-left whitespace-normal`}>
                {t("allEndpoints")}
              </td>
              <td className={`${td} border-t-2 max-md:hidden`}>{formatCount(s.calls)}</td>
              <td className={`${td} border-t-2`}>{allRate ?? t("notAvailable")}</td>
              <td className={`${td} border-t-2`}>{formatCount(s.timeouts)}</td>
              <td className={`${td} border-t-2`}>
                {s.p95Ms === null ? t("notAvailable") : formatMs(s.p95Ms)}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="m-0 mt-2 text-[12.5px] leading-[1.45] text-ink-2">
          {t("foot")}
          {s.topReject === null
            ? null
            : ` ${t("topReject", {
                reason: s.topReject.reason,
                pct: new Intl.NumberFormat("en-US", {
                  style: "percent",
                  maximumFractionDigits: 0,
                }).format(s.topReject.share),
              })}`}
        </p>
      </div>
    </div>
  );
}
