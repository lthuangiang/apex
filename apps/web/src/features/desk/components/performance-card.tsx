"use client";

import {
  dec,
  deskPerformanceSchema,
  EXIT_NOTE_MIN_SHARE,
  EXIT_NOTE_MIN_TRADES,
  formatDecimal,
  PERFORMANCE_MIN_FILLS,
  PERFORMANCE_WINDOW_HOURS,
  type DeskPerformance,
  type PerformanceCost,
  type PerformanceIdea,
} from "@drift/shared";
import { SegmentedControl, Skeleton } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { Info, RotateCw } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";

import { browserTimeZone, offsetLabel, offsetMinutes } from "@/features/account/market-hours-time";
import { api } from "@/lib/api";
import { formatInteger, formatRatio } from "@/lib/format";

// AI Desk › "How your bots performed" (#234, thiết kế #232 đã áp review UX). Chỉ bot tiền thật Market Making / Volume
// Builder của chính người dùng; số từ `GET /api/v1/desk/performance` (đã tổng hợp ở server). Quy tắc 1.8: thiếu số →
// "Not available", không bao giờ hiện 0 thay cho số không có.

type Period = DeskPerformance["period"];
const b = (chunks: ReactNode) => <b>{chunks}</b>;

/** "$214" (≥ $10 làm tròn đô), "$4.25" (< $10). */
function usd(v: string | number): string {
  const n = Math.abs(Number(v));
  const s = n >= 10 ? formatInteger(Math.round(n)) : n.toFixed(2);
  return `${Number(v) < 0 ? "−" : ""}$${s}`;
}
/** Khối lượng: 1.21M / 380K / 950. */
function volume(v: string): string {
  const n = Number(v);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${formatInteger(Math.round(n / 1000))}K`;
  return formatInteger(Math.round(n));
}
/** USDC làm tròn đô bằng decimal ("1,284", "−3"); câu tổng và từng phần dùng chung để cộng lại khớp nhau (#415). */
const usdc = (v: string) =>
  (
    formatDecimal(v, { locale: "en-US", maximumFractionDigits: 0, signDisplay: "negative" }) ?? ""
  ).replace("-", "−");
const hh = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;

function Compare({
  now,
  before,
  traded,
  period,
}: {
  now: string | null;
  before: string | null;
  /** Kỳ trước có giao dịch không: không có → "didn't trade then"; có mà thiếu số → chỉ "Not available". */
  traded: boolean;
  period: Period;
}) {
  const t = useTranslations("desk.performance");
  const label = t(`before.${period}`);
  if (now === null) return null;
  if (before === null)
    return (
      <span className="text-[13px] text-muted">
        {t(traded ? "prevNaPrice" : "prevNa", { before: label })}
      </span>
    );
  const d = dec(now).sub(before);
  // Chênh lệch theo đô tròn ("$2 more…"); dưới 0,5 đô là "the same".
  const amount = `$${formatInteger(Math.round(d.abs().toNumber()))}`;
  if (d.abs().lt(0.5))
    return <span className="text-[13px] font-bold text-ink-2">{t("same", { before: label })}</span>;
  // Chi phí giảm là tốt (xanh), tăng là xấu (đỏ); luôn có chữ, không chỉ màu.
  return d.isNegative() ? (
    <span className="text-[13px] font-bold text-pos">
      <span aria-hidden="true">▼ </span>
      {t("less", { amount, before: label })}
    </span>
  ) : (
    <span className="text-[13px] font-bold text-neg-ink">
      <span aria-hidden="true">▲ </span>
      {t("more", { amount, before: label })}
    </span>
  );
}

export function PerformanceCard() {
  const t = useTranslations("desk.performance");
  const [period, setPeriod] = useState<Period>("7d");
  const [localTz, setLocalTz] = useState<string | null>(null);
  const [utc, setUtc] = useState(false);
  useEffect(() => {
    setLocalTz(browserTimeZone());
  }, []);
  const tz = utc ? "UTC" : (localTz ?? "UTC");
  const q = useQuery({
    queryKey: ["desk", "performance", period, tz],
    queryFn: () =>
      api(
        "GET",
        `/api/v1/desk/performance?${new URLSearchParams({ period, tz }).toString()}`,
        deskPerformanceSchema,
      ),
    enabled: utc || localTz !== null,
    placeholderData: (prev) => prev,
    // Số tổng hợp theo kỳ: không cần tải lại liên tục.
    staleTime: 3 * 60_000,
  });
  // Đổi 7 / 30 ngày hoặc UTC: giữ số cũ (mờ) và báo "Updating…" tới khi có số mới.
  const updating = q.isFetching && q.isPlaceholderData;
  const titleId = useId();
  const head = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 id={titleId} className="m-0 text-lg font-extrabold">
          {t("title")}
        </h2>
        <p className="m-0 text-[13px] text-ink-2">{t(`sub.${period}`)}</p>
      </div>
      <SegmentedControl
        label={t("periodLabel")}
        value={period}
        onValueChange={setPeriod}
        options={(["7d", "30d"] as const).map((p) => ({ value: p, label: t(`period.${p}`) }))}
      />
    </div>
  );
  const v = q.data;
  return (
    <section
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-surface px-5 py-4.5"
    >
      {head}
      {q.isPending ? (
        <div aria-busy="true" className="flex flex-col gap-3">
          <span className="sr-only">{t("loading")}</span>
          <Skeleton className="h-4 w-56" />
          <div className="grid gap-3 md:grid-cols-2">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
          <p className="m-0 text-sm text-muted" aria-hidden="true">
            {t("loading")}
          </p>
        </div>
      ) : q.isError || v === undefined ? (
        <div role="alert" className="flex flex-col items-center gap-2 py-6 text-center">
          <strong className="text-base">{t("errorTitle")}</strong>
          <span className="text-sm text-ink-2">{t("errorBody")}</span>
          <button
            type="button"
            onClick={() => {
              void q.refetch();
            }}
            className="mt-1 inline-flex min-h-tap items-center gap-2 rounded-control bg-accent px-4 text-sm font-bold text-white"
          >
            <RotateCw size={16} aria-hidden="true" />
            {t("retry")}
          </button>
        </div>
      ) : v.state === "noBots" ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <strong className="text-base">{t("noBots.title")}</strong>
          <p className="m-0 max-w-[520px] text-sm text-ink-2">{t("noBots.body")}</p>
          <Link
            href="/desk/new"
            className="mt-1 inline-flex min-h-tap items-center rounded-control bg-accent px-4 text-sm font-bold text-white no-underline"
          >
            {t("noBots.start")}
          </Link>
        </div>
      ) : v.state === "notEnough" ? (
        <div role="status" className="flex flex-col items-center gap-2 py-6 text-center">
          <strong className="text-base">{t("notEnough.title")}</strong>
          <p className="m-0 max-w-[520px] text-sm text-ink-2">
            {t("notEnough.body", { n: v.current.fills, days: t(`days.${period}`) })}
          </p>
          <div
            role="img"
            aria-label={t("notEnough.progress", { n: v.current.fills })}
            className="h-2 w-56 overflow-hidden rounded-full bg-surface-2"
          >
            <div
              className="h-full rounded-full bg-accent"
              style={{
                width: `${String(Math.min(100, (v.current.fills / PERFORMANCE_MIN_FILLS) * 100))}%`,
              }}
            />
          </div>
          <span className="text-[12.5px] text-muted">
            {t("notEnough.progress", { n: v.current.fills })}
          </span>
        </div>
      ) : (
        <div aria-busy={updating} className="flex flex-col gap-4">
          {updating ? (
            <p role="status" className="m-0 text-[13px] font-bold text-muted">
              {t("updating")}
            </p>
          ) : null}
          <div className={`flex flex-col gap-4 ${updating ? "opacity-50" : ""}`}>
            <Ready
              v={v}
              tz={tz}
              utc={utc}
              onUtc={() => {
                setUtc((x) => !x);
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function Ready({
  v,
  tz,
  utc,
  onUtc,
}: {
  v: DeskPerformance;
  tz: string;
  utc: boolean;
  onUtc: () => void;
}) {
  const t = useTranslations("desk.performance");
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const c = v.current;
  return (
    <>
      <Headline c={c} prev={v.previous} period={v.period} />
      <details className="text-sm">
        <summary className="cursor-pointer font-bold text-accent-ink">{t("whatTitle")}</summary>
        <p className="m-0 mt-1.5 max-w-[640px] text-ink-2">{t("whatBody")}</p>
      </details>
      <Hours v={v} tz={tz} utc={utc} onUtc={onUtc} />
      {/* 390 px: phần chi tiết ẩn sau "Show details" (review UX #12); màn rộng luôn hiện. */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => {
          setOpen((x) => !x);
        }}
        className="inline-flex min-h-tap items-center justify-center rounded-control border border-border-input bg-surface text-sm font-bold text-ink md:hidden"
      >
        {open ? t("hideDetails") : t("showDetails")}
      </button>
      <div id={detailsId} className={`${open ? "flex" : "hidden"} flex-col gap-4 md:flex`}>
        {v.exits === null ? null : <Exits exits={v.exits} />}
        <Bots v={v} />
        {v.ideas.length === 0 ? null : <Ideas ideas={v.ideas} />}
      </div>
    </>
  );
}

function Headline({
  c,
  prev,
  period,
}: {
  c: PerformanceCost;
  prev: PerformanceCost | null;
  period: Period;
}) {
  const t = useTranslations("desk.performance");
  const pm = c.perMillion;
  const fees = dec(c.sodexFee).add(c.builderFee);
  const favour = pm.priceMove !== null && Number(pm.priceMove) < 0;
  // Thanh 3 phần (UX #2): SoDEX fee · DeskLabs builder fee · giá. Giá có lợi → chỉ 2 phần phí, không vẽ phần âm.
  const parts =
    pm.sodexFee === null || pm.builderFee === null
      ? []
      : [
          { key: "sodex", v: Number(pm.sodexFee), cls: "bg-accent text-white" },
          { key: "builder", v: Number(pm.builderFee), cls: "bg-accent-ink text-white" },
          ...(pm.priceMove === null || favour
            ? []
            : [{ key: "price", v: Number(pm.priceMove), cls: "bg-warn-bar text-ink" }]),
        ];
  const whole = parts.reduce((s, p) => s + Math.max(0, p.v), 0);
  const barLabel =
    pm.sodexFee === null || pm.builderFee === null
      ? ""
      : favour
        ? t("barLabelFavour", {
            sodex: usd(pm.sodexFee),
            builder: usd(pm.builderFee),
            price: usd(
              dec(pm.priceMove ?? "0")
                .abs()
                .toString(),
            ),
          })
        : t("barLabel", {
            cost: pm.cost === null ? t("bots.na") : usd(pm.cost),
            sodex: usd(pm.sodexFee),
            builder: usd(pm.builderFee),
            price: pm.priceMove === null ? t("bots.na") : usd(pm.priceMove),
          });
  // #415: số trên thanh là chi phí / $1M, không phải tiền đã trả: ghi rõ "per $1M" và thêm USDC thật trong kỳ.
  const unit = (
    <span className="text-[12.5px] font-semibold text-muted"> {t("perMillionUnit")}</span>
  );
  const paid = (amount: string) => (
    <span className="text-[13px] font-bold text-ink">
      {t(`inPeriod.${period}`, { amount: usdc(amount) })}
    </span>
  );
  const legend = (
    key: "sodex" | "builder",
    color: string,
    value: string | null,
    amount: string,
    before: string | null,
  ) => (
    <div className="flex gap-2">
      <span aria-hidden="true" className={`mt-1 size-3 flex-none rounded-[3px] ${color}`} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <strong className="text-sm">
          {t(key === "sodex" ? "sodexFee" : "builderFee")} ·{" "}
          {value === null ? (
            t("bots.na")
          ) : (
            <>
              {usd(value)}
              {unit}
            </>
          )}
        </strong>
        {paid(amount)}
        <span className="text-[13px] text-ink-2">
          {t(key === "sodex" ? "sodexFeeBody" : "builderFeeBody")}
        </span>
        <Compare now={value} before={before} traded={prev !== null} period={period} />
      </div>
    </div>
  );
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div className="flex flex-col gap-1.5 rounded-tile bg-surface-2 p-4">
        <p className="m-0 text-[15px] leading-snug">
          {c.cost === null
            ? t.rich("totalNa", { b, volume: volume(c.volume), fees: usdc(fees.toString()) })
            : t.rich("total", { b, volume: volume(c.volume), cost: usdc(c.cost) })}
        </p>
        <p className="m-0 text-[22px] font-extrabold tabular-nums">
          {pm.cost === null ? t("perMillionNa") : t.rich("perMillion", { b, cost: usd(pm.cost) })}
        </p>
        <Compare
          now={pm.cost}
          before={prev?.perMillion.cost ?? null}
          traded={prev !== null}
          period={period}
        />
        <p className="m-0 text-[12.5px] text-muted">{t("notPnl")}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <p className="m-0 text-[12.5px] font-extrabold text-muted">{t("partsTitle")}</p>
        {parts.length === 0 ? null : (
          <div
            role="img"
            aria-label={barLabel}
            className="flex h-9 overflow-hidden rounded-control text-[12.5px] font-extrabold"
          >
            {parts.map((p) => (
              <span
                key={p.key}
                className={`flex min-w-0 items-center justify-center overflow-hidden px-1.5 whitespace-nowrap ${p.cls}`}
                style={{ flex: `${String(Math.max(0, p.v) / (whole || 1))} 1 0` }}
              >
                {p.v / (whole || 1) > 0.14 ? usd(p.v) : ""}
              </span>
            ))}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          {legend("sodex", "bg-accent", pm.sodexFee, c.sodexFee, prev?.perMillion.sodexFee ?? null)}
          {legend(
            "builder",
            "bg-accent-ink",
            pm.builderFee,
            c.builderFee,
            prev?.perMillion.builderFee ?? null,
          )}
          <div className="flex gap-2">
            <span
              aria-hidden="true"
              className={`mt-1 size-3 flex-none rounded-[3px] ${favour ? "bg-pos" : "bg-warn-bar"}`}
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <strong className="text-sm">
                {pm.priceMove === null ? (
                  t("priceNa")
                ) : (
                  <>
                    {favour
                      ? t("priceFavour", { amount: usd(pm.priceMove) })
                      : `${t("price")} · ${usd(pm.priceMove)}`}
                    {unit}
                  </>
                )}
              </strong>
              {/* Thiếu giá: chỉ "Not available" ở dòng trên, không hiện 0 USDC (quy tắc 1.8). */}
              {c.priceMove === null ? null : paid(c.priceMove)}
              <span className="text-[13px] text-ink-2">
                {favour ? t("priceFavourBody") : t("priceBody")}
              </span>
              {favour ? null : (
                <Compare
                  now={pm.priceMove}
                  before={prev?.perMillion.priceMove ?? null}
                  traded={prev !== null}
                  period={period}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Hours({
  v,
  tz,
  utc,
  onUtc,
}: {
  v: DeskPerformance;
  tz: string;
  utc: boolean;
  onUtc: () => void;
}) {
  const t = useTranslations("desk.performance.hours");
  const offset = useMemo(() => offsetLabel(offsetMinutes(tz, new Date())), [tz]);
  const win = (from: number) =>
    t("window", { from: hh(from), to: hh(from + PERFORMANCE_WINDOW_HOURS) });
  const inWin = (h: number, from: number | undefined) =>
    from !== undefined && (h - from + 24) % 24 < PERFORMANCE_WINDOW_HOURS;
  const max = Math.max(1, ...v.hours.map((h) => Number(h.costPerMillion ?? "0")));
  const step = max > 400 ? 200 : max > 200 ? 100 : max > 80 ? 50 : 20;
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.floor(top / step) + 1 }, (_, i) => i * step);
  const zone = utc ? t("tzUtc") : t("tzLocal", { tz, offset });
  const label = [
    t("chartLabel", { zone }),
    v.cheapest === null ? "" : t("chartCheap", { window: win(v.cheapest.from) }),
    v.dearest === null ? "" : t("chartDear", { window: win(v.dearest.from) }),
  ]
    .filter((x) => x !== "")
    .join(" ");
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="m-0 text-base font-extrabold">{t("title")}</h3>
        <span className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
          {zone} · {t("together", { days: v.period === "7d" ? 7 : 30 })}
          <button
            type="button"
            aria-pressed={utc}
            onClick={onUtc}
            className="min-h-8 rounded-control border border-border-input bg-surface px-2.5 text-[12.5px] font-bold text-ink"
          >
            {utc ? t("showLocal") : t("showUtc")}
          </button>
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
        <div className="flex min-w-0 flex-col gap-1.5">
          {/* Nhãn chữ trên dải rẻ / đắt nhất (UX #9): không chỉ dựa vào màu xanh / đỏ. Mỗi nhãn một hàng riêng, để hai
              khung sát nhau không đè chữ lên nhau ở 390 px (#245). */}
          {/* Không có khung nào: giữ một hàng trống cao như cũ, để biểu đồ không nhảy lên 16 px. */}
          {v.cheapest === null && v.dearest === null ? (
            <div aria-hidden="true" data-testid="perf-label-spacer" className="h-4" />
          ) : null}
          {(
            [
              [v.cheapest, "cheapest", "text-pos"],
              [v.dearest, "dearest", "text-neg-ink"],
            ] as const
          ).map(([w, key, tone]) =>
            w === null ? null : (
              <div
                key={key}
                aria-hidden="true"
                className={`flex h-4 pl-9 text-[10.5px] font-extrabold ${tone}`}
              >
                {v.hours.map((h) => {
                  // Khung ở nửa sau ngày: canh nhãn theo mép phải của giờ cuối khung, để không tràn ra ngoài (390 px).
                  const side =
                    w.from < 12
                      ? w.from === h.hour
                        ? "left-0"
                        : null
                      : (w.from + PERFORMANCE_WINDOW_HOURS - 1) % 24 === h.hour
                        ? "right-0"
                        : null;
                  return (
                    <span key={h.hour} className="relative min-w-0 flex-1">
                      {side === null ? null : (
                        <span className={`absolute whitespace-nowrap ${side}`}>{t(key)}</span>
                      )}
                    </span>
                  );
                })}
              </div>
            ),
          )}
          <div role="img" aria-label={label} className="relative h-[180px] pl-9">
            {ticks.map((k) => (
              <div
                key={k}
                aria-hidden="true"
                className="absolute right-0 left-9 border-t border-border"
                style={{ bottom: `${String((k / top) * 100)}%` }}
              >
                <span className="absolute -top-2 -left-9 w-8 text-right text-[11px] text-muted">
                  ${k}
                </span>
              </div>
            ))}
            <div className="absolute inset-y-0 right-0 left-9 flex items-end gap-[2px]">
              {v.hours.map((h) => {
                // Phí và giá cùng một cơ sở (fill có giá tham chiếu); giờ thiếu giá: không vẽ thanh, chỉ dấu "–"
                // (không để giờ n/a trông như giờ rẻ).
                const cost = h.costPerMillion === null ? null : Number(h.costPerMillion);
                const fees = h.feesPerMillion === null ? 0 : Number(h.feesPerMillion);
                const feePart = cost === null ? 0 : Math.min(fees, cost);
                const pricePart = cost === null ? 0 : Math.max(0, cost - fees);
                const cheap = inWin(h.hour, v.cheapest?.from);
                const dear = inWin(h.hour, v.dearest?.from);
                return (
                  <div
                    key={h.hour}
                    title={
                      cost === null
                        ? t("barNa", { hour: hh(h.hour), trades: h.fills })
                        : t("bar", { hour: hh(h.hour), cost: usd(cost), trades: h.fills })
                    }
                    className={`relative flex h-full min-w-0 flex-1 flex-col justify-end ${cheap ? "bg-pos-bg" : dear ? "bg-neg-bg" : ""}`}
                  >
                    {cost === null ? (
                      h.fills === 0 ? null : (
                        <span aria-hidden="true" className="text-center text-[11px] text-muted">
                          –
                        </span>
                      )
                    ) : (
                      <>
                        {/* Giờ < 30 fill: chỉ viền, màu đậm để đạt 3:1 trên nền biểu đồ. */}
                        <div
                          className={`w-full ${h.thin ? "border-[1.5px] border-warn" : "bg-warn-bar"}`}
                          style={{ height: `${String((pricePart / top) * 100)}%` }}
                        />
                        <div
                          className={`w-full ${h.thin ? "border-[1.5px] border-dashed border-accent" : "bg-accent"}`}
                          style={{ height: `${String((feePart / top) * 100)}%` }}
                        />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div aria-hidden="true" className="flex pl-9 text-[11px] font-semibold text-ink-2">
            {v.hours.map((h) => (
              <span key={h.hour} className="min-w-0 flex-1 text-center">
                {h.hour % 3 === 0 ? String(h.hour).padStart(2, "0") : ""}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs font-semibold text-ink-2">
            <span className="flex items-center gap-1.5">
              <i aria-hidden="true" className="inline-block size-3 rounded-[3px] bg-accent" />
              {t("fees")}
            </span>
            <span className="flex items-center gap-1.5">
              <i aria-hidden="true" className="inline-block size-3 rounded-[3px] bg-warn-bar" />
              {t("price")}
            </span>
            <span className="text-muted">{t("faded")}</span>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {v.cheapest === null ? (
            <p className="m-0 rounded-tile bg-surface-2 p-3 text-[13px] text-ink-2">
              {t.rich("na", { b })}
            </p>
          ) : (
            <div className="flex flex-col gap-0.5 rounded-tile bg-pos-bg p-3 text-pos">
              <span className="text-xs font-extrabold">{t("cheapest")}</span>
              <strong className="text-lg text-ink">{win(v.cheapest.from)}</strong>
              <span className="text-[13px] text-ink-2">
                {t("windowSub", {
                  cost: usd(v.cheapest.costPerMillion),
                  trades: formatInteger(v.cheapest.fills),
                })}
              </span>
            </div>
          )}
          {v.dearest === null ? null : (
            <div className="flex flex-col gap-0.5 rounded-tile bg-neg-bg p-3 text-neg-ink">
              <span className="text-xs font-extrabold">{t("dearest")}</span>
              <strong className="text-lg text-ink">{win(v.dearest.from)}</strong>
              <span className="text-[13px] text-ink-2">
                {t("windowSub", {
                  cost: usd(v.dearest.costPerMillion),
                  trades: formatInteger(v.dearest.fills),
                })}
              </span>
            </div>
          )}
        </div>
      </div>
      <p className="m-0 flex gap-1.5 text-[12.5px] text-muted">
        <Info size={14} aria-hidden="true" className="mt-0.5 flex-none" />
        {t("foot")}
      </p>
    </div>
  );
}

function Exits({ exits }: { exits: NonNullable<DeskPerformance["exits"]> }) {
  const t = useTranslations("desk.performance.exits");
  const maxShare = Math.max(...exits.items.map((x) => x.share), 0.01);
  // Lý do tốn nhất mỗi lượt, chỉ trong các lý do có ≥ 30 lượt và ≥ 5% số lượt, để câu nhận xét có ý nghĩa.
  const worst = exits.items
    .filter((x) => x.trades >= EXIT_NOTE_MIN_TRADES && x.share >= EXIT_NOTE_MIN_SHARE)
    .sort((a, b2) => Number(a.avgNet) - Number(b2.avgNet))[0];
  const signed = (v: string) => {
    const n = Number(v);
    return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}`;
  };
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 text-base font-extrabold">{t("title")}</h3>
        <span className="text-[12.5px] text-muted">
          {t("note", { bots: exits.bots, trades: formatInteger(exits.trades) })}
        </span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {exits.items.map((x) => {
          const gain = Number(x.avgNet) > 0;
          return (
            <li
              key={x.reason}
              className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_3.5rem] items-center gap-x-3 gap-y-0.5 text-[13.5px] sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_3.5rem_9.5rem]"
            >
              <span className="font-bold">{t(`reason.${x.reason}`)}</span>
              <span
                role="img"
                aria-label={t("barLabel", {
                  reason: t(`reason.${x.reason}`),
                  pct: formatRatio(String(x.share)) ?? "",
                })}
                className="h-2.5 overflow-hidden rounded-full bg-surface-2"
              >
                {/* Lãi: xanh nhạt; lỗ: đỏ đậm (khác cả độ sáng, không chỉ màu, UX #10). */}
                <span
                  className={`block h-full rounded-full ${gain ? "bg-pos-dot" : "bg-neg-deep"}`}
                  style={{ width: `${String((x.share / maxShare) * 100)}%` }}
                />
              </span>
              <span className="text-right font-bold tabular-nums">
                {formatRatio(String(x.share))}
              </span>
              <span className="col-span-3 text-ink-2 tabular-nums sm:col-span-1 sm:text-right">
                <span className="sr-only">{gain ? t("gain") : t("loss")}: </span>
                {t("avg", { amount: signed(x.avgNet) })}
              </span>
            </li>
          );
        })}
      </ul>
      {worst === undefined || Number(worst.avgNet) >= 0 ? null : (
        <p className="m-0 flex gap-2 rounded-tile bg-surface-2 p-3 text-[13px] text-ink-2">
          <Info size={16} aria-hidden="true" className="mt-0.5 flex-none" />
          <span>
            {t.rich("costliest", {
              b,
              reason: t(`reason.${worst.reason}`),
              pct: formatRatio(String(worst.share)) ?? "",
              amount: signed(worst.avgNet),
            })}
          </span>
        </p>
      )}
    </div>
  );
}

function Bots({ v }: { v: DeskPerformance }) {
  const t = useTranslations("desk.performance.bots");
  const tp = useTranslations("desk.performance");
  const before = tp(`before.${v.period}`);
  const rows = v.bots.map((x) => {
    const thin = x.current.fills < PERFORMANCE_MIN_FILLS;
    const fees = dec(x.current.sodexFee).add(x.current.builderFee);
    return { x, thin, fees };
  });
  const vs = (now: string | null, prev: string | null) => {
    if (now === null || prev === null) return <span className="text-muted">{t("na")}</span>;
    const d = dec(now).sub(prev);
    const amount = `$${formatInteger(Math.round(d.abs().toNumber()))}`;
    // Luôn có chữ, không chỉ mũi tên; không đổi (< 0,5 đô) thì trung tính.
    if (d.abs().lt(0.5)) return <span className="text-ink-2">{t("vsSame")}</span>;
    return d.isNegative() ? (
      <span className="font-bold text-pos">
        <span aria-hidden="true">▼ </span>
        {t("vsLess", { amount })}
      </span>
    ) : (
      <span className="font-bold text-neg-ink">
        <span aria-hidden="true">▲ </span>
        {t("vsMore", { amount })}
      </span>
    );
  };
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 text-base font-extrabold">{t("title")}</h3>
        <span className="text-[12.5px] text-muted">{t("note")}</span>
      </div>
      {/* Màn rộng: bảng; 390 px: thẻ (UX #13). */}
      <div className="hidden overflow-x-auto rounded-tile border border-border md:block">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{t("caption")}</caption>
          <thead className="bg-surface-2 text-left text-xs font-semibold text-muted">
            <tr>
              <th scope="col" className="px-3 py-2.5">
                {t("bot")}
              </th>
              <th scope="col" className="px-3 py-2.5 text-right">
                {t("traded")}
              </th>
              <th scope="col" className="px-3 py-2.5 text-right">
                {t("cost")}
              </th>
              <th scope="col" className="px-3 py-2.5 text-right">
                {t("vs", { before })}
              </th>
              <th scope="col" className="px-3 py-2.5 text-right">
                {t("split")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ x, thin, fees }) => (
              <tr key={x.id} className="border-t border-border">
                <th scope="row" className="px-3 py-2.5 text-left font-normal">
                  <Link href={`/agent/${x.id}`} className="font-bold text-ink no-underline">
                    {x.name}
                  </Link>
                  <span className="block text-xs text-muted">
                    {t(`strategy.${x.strategy}`)} · {x.market}
                  </span>
                </th>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {volume(x.current.volume)} USDC
                </td>
                {thin ? (
                  <td colSpan={3} className="px-3 py-2.5 text-right text-ink-2">
                    {t("thin", { n: x.current.fills })}{" "}
                    <span className="ml-1 rounded-full bg-warn-bg px-2 py-0.5 text-xs font-bold text-warn">
                      {t("thinPill")}
                    </span>
                  </td>
                ) : (
                  <>
                    <td className="px-3 py-2.5 text-right font-extrabold tabular-nums">
                      {x.current.perMillion.cost === null
                        ? t("na")
                        : usd(x.current.perMillion.cost)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {vs(x.current.perMillion.cost, x.previous?.perMillion.cost ?? null)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {usdc(fees.toString())} /{" "}
                      {x.current.priceMove === null ? t("na") : usdc(x.current.priceMove)} USDC
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0 md:hidden">
        {rows.map(({ x, thin }) => (
          <li key={x.id}>
            <Link
              href={`/agent/${x.id}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 rounded-tile border border-border p-3 text-ink no-underline"
            >
              <strong className="text-sm">{x.name}</strong>
              <span className="text-right text-sm font-extrabold tabular-nums">
                {thin || x.current.perMillion.cost === null
                  ? t("na")
                  : usd(x.current.perMillion.cost)}
              </span>
              <span className="text-xs text-muted">
                {t(`strategy.${x.strategy}`)} · {x.market}
              </span>
              <span className="text-right text-xs">
                {thin ? (
                  t("thin", { n: x.current.fills })
                ) : (
                  <Compare
                    now={x.current.perMillion.cost}
                    before={x.previous?.perMillion.cost ?? null}
                    traded={x.previous !== null}
                    period={v.period}
                  />
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Ideas({ ideas }: { ideas: readonly PerformanceIdea[] }) {
  const t = useTranslations("desk.performance.ideas");
  const pct = (bp: string) => `${(Number(bp) / 100).toFixed(2)}%`;
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 text-base font-extrabold">{t("title")}</h3>
        <span className="text-[12.5px] text-muted">{t("note")}</span>
      </div>
      <ol className="m-0 grid list-none gap-3 p-0 md:grid-cols-2">
        {ideas.map((x) => {
          const nums = {
            b,
            worse: usd(x.worseCostPerMillion),
            better: usd(x.betterCostPerMillion),
            share: formatRatio(String(x.worseShare)) ?? "",
          };
          return (
            <li
              key={`${x.botId}-${x.kind}`}
              className="flex flex-col gap-2 rounded-tile border border-border p-4"
            >
              <span className="text-xs font-extrabold text-accent-ink">{x.botName}</span>
              <h4 className="m-0 text-[15px] font-extrabold">
                {x.kind === "sidewaysOnly"
                  ? t("sidewaysOnly.title")
                  : t("maxSpread.title", {
                      from: x.fromBps,
                      to: x.toBps,
                      fromPct: pct(x.fromBps),
                      toPct: pct(x.toBps),
                    })}
              </h4>
              <p className="m-0 text-[13.5px] text-ink-2">
                {x.kind === "sidewaysOnly"
                  ? t.rich("sidewaysOnly.body", nums)
                  : t.rich("maxSpread.body", { ...nums, to: x.toBps })}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Link
                  href={`/bots/${x.botId}/edit`}
                  className="inline-flex min-h-tap items-center rounded-control border border-border-input px-3.5 text-sm font-bold text-ink no-underline"
                >
                  {t("open")}
                </Link>
                <span className="text-xs text-muted">
                  {t("basedOn", { n: formatInteger(x.trades) })}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="m-0 flex gap-1.5 text-[12.5px] text-muted">
        <Info size={14} aria-hidden="true" className="mt-0.5 flex-none" />
        {t("foot")}
      </p>
    </div>
  );
}
