"use client";

import {
  dec,
  marketHoursViewSchema,
  type MarketHoursHour,
  type MarketHoursView,
} from "@drift/shared";
import { SegmentedControl } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { api, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";

import {
  browserTimeZone,
  hhmm,
  markersFor,
  offsetLabel,
  offsetMinutes,
  type Marker,
} from "../market-hours-time";

// Market hours cho team Ops (docs/mockups/market-hours, DEC-283). Ba khối dùng chung 24 cột giờ theo múi
// giờ của người xem (có nút đổi sang UTC). Chỉ đọc; số quá khứ, không dự báo; thiếu → "n/a" / "Not available", không
// bao giờ 0.

type Strategy = MarketHoursView["strategy"];
const PERIODS = ["7", "30"] as const;
const STRATEGIES: readonly Strategy[] = ["volume_maker", "volume_farm", "both"];
const H = Array.from({ length: 24 }, (_, h) => h);
const pad = (n: number) => String(n).padStart(2, "0");

const VOL_BG = ["bg-mh-vol-0", "bg-mh-vol-1", "bg-mh-vol-2", "bg-mh-vol-3", "bg-mh-vol-4"] as const;
const COST_BG = ["bg-mh-cost-0", "bg-mh-cost-1", "bg-mh-cost-2", "bg-mh-cost-3"] as const;
const HATCH =
  "bg-[repeating-linear-gradient(45deg,var(--mh-hatch)_0_3px,var(--surface)_3px_6px)] text-muted";
const THIN_HATCH =
  "bg-[repeating-linear-gradient(45deg,var(--mh-cost-0)_0_4px,var(--surface)_4px_8px)]";

/** Bậc màu "× day median": dưới 0.75 · 0.75–1.25 · 1.25–2 · 2–3 (nóng) · trên 3. */
export function volBucket(ratio: number): number {
  return ratio < 0.75 ? 0 : ratio < 1.25 ? 1 : ratio < 2 ? 2 : ratio < 3 ? 3 : 4;
}
/** Bậc màu Cost per $1M: dưới $120 · $120–170 · $170–230 · trên $230 (theo thiết kế). */
export function costBucket(cost: number): number {
  return cost < 120 ? 0 : cost < 170 ? 1 : cost < 230 ? 2 : 3;
}
const volBg = (ratio: number): string => VOL_BG[volBucket(ratio)] ?? "";
/** Hàng "× day median" có chữ: chỉ dùng ba bậc nhạt để chữ đạt tương phản. */
const volBgText = (ratio: number): string => VOL_BG[Math.min(volBucket(ratio), 2)] ?? "";
const costBg = (cost: number): string => COST_BG[costBucket(cost)] ?? "";

const num = (v: string | null, dp = 1): string | null =>
  v === null ? null : Number(v).toFixed(dp);
function usdShort(v: string | null): string | null {
  if (v === null) return null;
  const n = Number(v);
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
/** Tiền theo đô; dưới $10 (trị tuyệt đối) thì có cent để phí nhỏ không thành "$0" (vd "$0.31"). Tính bằng Decimal. */
export function usd(v: string | null): string | null {
  if (v === null) return null;
  const d = dec(v);
  return `$${d.abs().lt(10) ? d.toFixed(2) : d.toFixed(0)}`;
}
/** Ngày địa phương "YYYY-MM-DD" từ API (đã theo múi giờ người xem) → "Nov 15, 2026". */
const dayLabel = (d: string): string => formatDate(Date.parse(`${d}T00:00:00Z`), "UTC");
/** Mốc thời gian ISO → ngày theo múi giờ `tz`. */
const instantLabel = (iso: string, tz: string): string => formatDate(Date.parse(iso), tz);

export function MarketHoursPage() {
  const t = useTranslations("marketHours");
  const [tzLocal, setTzLocal] = useState("UTC");
  useEffect(() => {
    setTzLocal(browserTimeZone());
  }, []);
  const [utcMode, setUtcMode] = useState(false);
  const [market, setMarket] = useState<string | null>(null);
  const [days, setDays] = useState<(typeof PERIODS)[number]>("30");
  const [strategy, setStrategy] = useState<Strategy>("both");
  const tz = utcMode ? "UTC" : tzLocal;
  const q = useQuery({
    queryKey: ["market-hours", market, days, strategy, tz],
    queryFn: () => {
      const p = new URLSearchParams({ days, strategy, tz });
      if (market !== null) p.set("market", market);
      return api("GET", `/api/v1/admin/market-hours?${p.toString()}`, marketHoursViewSchema);
    },
  });
  // Trình duyệt trả tên múi giờ mà API không nhận (VALIDATION_FAILED): chuyển sang UTC và tải lại, không hiện lỗi.
  const tzRejected =
    tz !== "UTC" && q.error instanceof ApiError && q.error.code === "VALIDATION_FAILED";
  useEffect(() => {
    if (tzRejected) setTzLocal("UTC");
  }, [tzRejected]);
  const forbidden = q.error instanceof ApiError && q.error.code === "FORBIDDEN";
  const now = useMemo(() => new Date(), []);
  const offset = utcMode ? 0 : offsetMinutes(tzLocal, now);
  const markers = useMemo(() => markersFor(offset, now), [offset, now]);
  const v = q.data;

  return (
    <Workspace current="marketHours">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <div className="min-w-0 flex-[1_1_420px]">
            <PageHead title={t("title")} subtitle={t("subtitle")} />
          </div>
          <span className="inline-flex flex-wrap items-center gap-2 rounded-control border border-border bg-surface py-1 pr-1 pl-3 text-[13px] font-bold">
            {utcMode ? t("tzUtc") : t("tzLocal", { tz: tzLocal, offset: offsetLabel(offset) })}
            <button
              type="button"
              aria-pressed={utcMode}
              onClick={() => {
                setUtcMode((x) => !x);
              }}
              className="min-h-11 cursor-pointer rounded-[9px] border border-border-input bg-surface-2 px-3 text-[12.5px] font-bold text-ink"
            >
              {utcMode ? t("showLocal") : t("showUtc")}
            </button>
          </span>
        </div>
        {forbidden ? (
          <Card>
            <p className="m-0">{t("forbidden")}</p>
          </Card>
        ) : (
          <>
            <section
              aria-label={t("filters")}
              className="flex flex-col gap-3 rounded-tile border border-border bg-surface p-3 md:flex-row md:flex-wrap md:items-end md:gap-x-5 md:px-4"
            >
              <label className="flex flex-col gap-1 text-[12.5px] font-bold text-ink-2">
                {t("market")}
                <select
                  value={v?.market ?? market ?? ""}
                  onChange={(e) => {
                    setMarket(e.target.value);
                  }}
                  className="min-h-11 min-w-40 rounded-control border border-border-input bg-surface px-3 text-sm font-semibold text-ink"
                >
                  {(v?.markets ?? []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col gap-1">
                <span className="text-[12.5px] font-bold text-ink-2">{t("period")}</span>
                <SegmentedControl
                  label={t("period")}
                  options={PERIODS.map((p) => ({ value: p, label: t("days", { n: Number(p) }) }))}
                  value={days}
                  onValueChange={setDays}
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[12.5px] font-bold text-ink-2">{t("bots")}</span>
                <SegmentedControl
                  label={t("strategy")}
                  options={STRATEGIES.map((s) => ({ value: s, label: t(`strategies.${s}`) }))}
                  value={strategy}
                  onValueChange={setStrategy}
                />
              </div>
            </section>
            <HowToRead v={v} markers={markers} utcMode={utcMode} offset={offset} />
            <section
              aria-label={t("grid")}
              className="flex flex-col gap-3.5 rounded-card border border-border bg-surface px-3 py-4 md:px-4"
            >
              {q.isPending || tzRejected ? (
                <div aria-busy="true" className="flex flex-col gap-2">
                  <span className="sr-only">{t("loading")}</span>
                  {[30, 180, 28, 28, 28, 90, 28, 28].map((h, i) => (
                    <span
                      key={i}
                      aria-hidden="true"
                      className="rounded-[6px] bg-surface-2"
                      style={{ height: h }}
                    />
                  ))}
                </div>
              ) : q.isError ? (
                <div
                  role="alert"
                  className="flex flex-col items-center gap-2.5 px-4 py-10 text-center"
                >
                  <strong className="text-base">{t("errorTitle")}</strong>
                  <span className="text-sm text-muted">{t("errorBody")}</span>
                  <button
                    type="button"
                    onClick={() => void q.refetch()}
                    className="min-h-11 cursor-pointer rounded-control border-0 bg-accent px-[18px] text-sm font-bold text-white"
                  >
                    {t("retry")}
                  </button>
                </div>
              ) : v === undefined ? null : isEmpty(v) ? (
                <div className="flex flex-col gap-1.5 px-4 py-12 text-center">
                  <strong className="text-base">
                    {t("empty", { market: v.market ?? "", days: v.days })}
                  </strong>
                  <span className="text-sm text-muted">{t("emptyHint")}</span>
                </div>
              ) : (
                <>
                  <Desktop v={v} markers={markers} utcMode={utcMode} offset={offset} />
                  <Mobile v={v} markers={markers} />
                </>
              )}
            </section>
            <p className="m-0 text-[12.5px] text-muted">{t("footer")}</p>
          </>
        )}
      </div>
    </Workspace>
  );
}

function isEmpty(v: MarketHoursView): boolean {
  return (
    v.market === null ||
    (v.heatmap.length === 0 &&
      v.markoutDays === 0 &&
      v.hours.every((h) => h.bots.volume === null && h.bots.botHours === 0))
  );
}

function useMarkerLabel(utcMode: boolean, offset: number) {
  const t = useTranslations("marketHours");
  return (m: Marker): string => {
    const time =
      utcMode || offset === 0
        ? hhmm(m.utc)
        : t("marker", { local: hhmm(m.local), utc: hhmm(m.utc) });
    return m.us ? `${t("usOpen")} ${time}` : time;
  };
}

function HowToRead({
  v,
  markers,
  utcMode,
  offset,
}: {
  v: MarketHoursView | undefined;
  markers: readonly Marker[];
  utcMode: boolean;
  offset: number;
}) {
  const t = useTranslations("marketHours");
  const tm = useTranslations("common.missing");
  const label = useMarkerLabel(utcMode, offset);
  const since = (iso: string | null | undefined) =>
    iso === null || iso === undefined
      ? tm("notAvailable")
      : t("calc.since", { date: instantLabel(iso, v?.tz ?? "UTC") });
  return (
    <details
      open
      className="rounded-tile border border-border bg-surface px-4 py-3.5 text-sm leading-normal"
    >
      <summary className="min-h-7 cursor-pointer font-extrabold">{t("how.title")}</summary>
      <ul className="my-2 pl-5 text-ink-2">
        {(["vol", "cost", "bots"] as const).map((k) => (
          <li key={k}>
            <strong className="text-ink">{t(`how.${k}Title`)}</strong>
            {t(`how.${k}Body`)}
          </li>
        ))}
      </ul>
      <p className="m-0 mb-1.5 text-ink-2">{t("how.note")}</p>
      <p className="m-0 mb-1.5 text-ink-2 md:hidden">
        <strong className="text-ink">{t("markers")}: </strong>
        {markers.map(label).join(", ")}
      </p>
      <details className="mt-1.5 rounded-control bg-surface-2 px-3 py-2.5">
        <summary className="min-h-7 cursor-pointer font-bold text-accent-ink">
          {t("calc.title")}
        </summary>
        <dl className="mt-2 mb-0 flex flex-col gap-2.5 text-ink-2">
          <div>
            <dt className="font-extrabold text-ink">{t("calc.volTitle")}</dt>
            <dd className="m-0 mt-0.5">
              {t("calc.volBody")} {t("calc.estBody")} {since(v?.candlesSince)}
            </dd>
          </div>
          <div>
            <dt className="font-extrabold text-ink">{t("calc.costTitle")}</dt>
            <dd className="m-0 mt-0.5">
              {t("calc.costBody")} {t("calc.kept")}
            </dd>
          </div>
          <div>
            <dt className="font-extrabold text-ink">{t("calc.botsTitle")}</dt>
            <dd className="m-0 mt-0.5">
              {t("calc.botsBody")} {since(v?.fillsSince)}
            </dd>
          </div>
        </dl>
      </details>
    </details>
  );
}

const GRID = "grid grid-cols-[202px_repeat(24,minmax(0,1fr))] items-center gap-[3px]";
const CELL =
  "flex min-h-[30px] flex-col items-center justify-center rounded-[4px] text-center text-[11px] font-semibold";

function Desktop({
  v,
  markers,
  utcMode,
  offset,
}: {
  v: MarketHoursView;
  markers: readonly Marker[];
  utcMode: boolean;
  offset: number;
}) {
  const t = useTranslations("marketHours");
  const tm = useTranslations("common.missing");
  const label = useMarkerLabel(utcMode, offset);
  const usHour = markers.find((m) => m.us)?.hour ?? 0;
  const [sel, setSel] = useState<number>(usHour);
  const markAt = new Map(markers.map((m) => [m.hour, m]));
  const line = (h: number) => (markAt.has(h) ? "shadow-[inset_2px_0_0_var(--warn-bar)]" : "");
  const strategies = v.strategy === "both" ? t("botBlock.both") : t(`strategies.${v.strategy}`);
  const selected = v.hours[sel];
  const usAtSel = markAt.get(sel)?.us === true ? markAt.get(sel) : undefined;
  const halfHour = !utcMode && offset % 60 !== 0;
  const row = (labelText: string, cells: ReactNode[]) => (
    <div className={GRID}>
      <span className="text-[12.5px] leading-tight font-bold">{labelText}</span>
      {cells}
    </div>
  );
  return (
    <div className="hidden overflow-x-auto md:block">
      <div className="flex min-w-[980px] flex-col gap-0.5">
        <div className={GRID}>
          <span className="self-end text-xs font-bold text-muted">{t("hour")}</span>
          {H.map((h) => {
            const m = markAt.get(h);
            const tag =
              m === undefined ? "" : m.us ? t("usShort") : hhmm(utcMode ? m.utc : m.local);
            const base = t("hourAria", { hour: pad(h) });
            return (
              <button
                key={h}
                type="button"
                aria-pressed={sel === h}
                aria-label={
                  m === undefined ? base : t("markerAria", { label: base, marker: label(m) })
                }
                onClick={() => {
                  setSel(h);
                }}
                className={`flex min-h-11 cursor-pointer flex-col items-center justify-end gap-0.5 rounded-lg border-0 py-0.5 text-xs font-extrabold ${line(h)} ${sel === h ? "bg-accent-tint text-accent-ink" : "bg-transparent text-ink"}`}
              >
                <span className="min-h-3 text-[9.5px] font-extrabold whitespace-nowrap text-warn">
                  {tag}
                </span>
                {pad(h)}
              </button>
            );
          })}
        </div>

        <BlockHead title={t("vol.title")} sub={t("vol.sub")} />
        {v.heatmap.map((d) => (
          <div key={d.date} className={GRID}>
            <span className="text-[11px] leading-3 text-muted">{dayLabel(d.date)}</span>
            {d.cells.map((c, h) => {
              const r = c.ratio === null ? null : Number(c.ratio);
              const title =
                r === null || c.medianBp === null
                  ? t("vol.cellNa", { date: dayLabel(d.date), hour: pad(h) })
                  : t("vol.cellTip", {
                      date: dayLabel(d.date),
                      hour: pad(h),
                      bp: Number(c.medianBp).toFixed(1),
                      ratio: r.toFixed(1),
                    }) + (r > 2 ? t("vol.hot") : "");
              return (
                <span
                  key={h}
                  title={title}
                  className={`h-3 rounded-[2px] outline outline-1 -outline-offset-1 outline-ink/10 ${line(h)} ${r === null ? HATCH : volBg(r)}`}
                />
              );
            })}
          </div>
        ))}
        <Legend
          label={t("vol.legend")}
          items={(["b0", "b1", "b2", "b3", "b4"] as const).map((k, i) => [
            VOL_BG[i] ?? "",
            t(`vol.${k}`),
          ])}
          extra={[[HATCH, tm("notAvailable")]]}
        />
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 pt-0.5 pb-1.5 pl-[202px] text-xs text-ink-2">
          <span className="font-bold">{t("markers")}</span>
          {markers.map((m) => (
            <span key={`${String(m.utc)}-${String(m.us)}`}>{label(m)}</span>
          ))}
          <span className="text-muted">{t("usNote")}</span>
        </div>
        {row(
          t("vol.medianBp"),
          H.map((h) => <Num key={h} v={num(hourOf(v, h).volatility.medianBp)} line={line(h)} />),
        )}
        {row(
          t("vol.p90Bp"),
          H.map((h) => <Num key={h} v={num(hourOf(v, h).volatility.p90Bp)} line={line(h)} />),
        )}
        {row(
          t("vol.ratio"),
          H.map((h) => {
            const r = hourOf(v, h).volatility.ratio;
            return (
              <Num
                key={h}
                v={r === null ? null : `${Number(r).toFixed(1)}×`}
                line={line(h)}
                {...(r === null ? {} : { bg: volBgText(Number(r)) })}
              />
            );
          }),
        )}
        {row(
          t("vol.hotDays"),
          H.map((h) => {
            const p = hourOf(v, h).volatility.hotPct;
            return <Num key={h} v={p === null ? null : `${String(p)}%`} line={line(h)} />;
          }),
        )}
        {row(
          t("vol.est"),
          H.map((h) => (
            <EstCell key={h} x={hourOf(v, h).volatility} est={v.estimate} hour={h} line={line(h)} />
          )),
        )}
        <Legend
          label={t("vol.estLegend")}
          items={(["c0", "c1", "c2", "c3"] as const).map((k, i) => [
            COST_BG[i] ?? "",
            t(`botBlock.${k}`),
          ])}
          extra={[]}
        >
          <span>{t("botBlock.naLegend")}</span>
        </Legend>
        <div className="mt-1.5 mb-1 flex flex-col gap-2 rounded-tile bg-surface-2 p-3">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <strong className="text-[13.5px]">
              {t("detailTitle", { from: `${pad(sel)}:00`, to: `${pad(sel)}:59` })}
              {usAtSel === undefined
                ? ""
                : t("detailUs", { time: hhmm(utcMode ? usAtSel.utc : usAtSel.local) })}
            </strong>
            <span className="text-xs text-muted">{t("detailSub")}</span>
          </div>
          <FiveMin values={selected?.volatility.fiveMin ?? []} />
        </div>

        <BlockHead
          title={t("cost.title")}
          sub={t("cost.sub")}
          chip={
            v.markoutSince !== null && v.markoutDays < v.days
              ? t("cost.collecting", {
                  date: instantLabel(v.markoutSince, v.tz),
                  n: v.markoutDays,
                  days: v.days,
                })
              : null
          }
          note={halfHour ? t("cost.halfHour") : null}
        />
        {row(
          t("cost.markout"),
          H.map((h) => <Num key={h} v={num(hourOf(v, h).cost.markoutBp)} line={line(h)} />),
        )}
        {row(
          t("cost.spread"),
          H.map((h) => {
            const s = hourOf(v, h).cost.spreadTicks;
            return <Num key={h} v={s === null ? null : s.toFixed(1)} line={line(h)} />;
          }),
        )}

        <BlockHead title={t("botBlock.title")} sub={t("botBlock.sub", { strategies })} />
        {row(
          t("botBlock.cost"),
          H.map((h) => (
            <BotCell key={h} b={hourOf(v, h).bots} hour={h} line={line(h)} kind="cost" />
          )),
        )}
        {row(
          t("botBlock.volume"),
          H.map((h) => (
            <BotCell key={h} b={hourOf(v, h).bots} hour={h} line={line(h)} kind="volume" />
          )),
        )}
        {row(
          t("botBlock.fees"),
          H.map((h) => (
            <BotCell key={h} b={hourOf(v, h).bots} hour={h} line={line(h)} kind="fees" />
          )),
        )}
        {row(
          t("botBlock.botHours"),
          H.map((h) => (
            <span key={h} className={`${CELL} bg-surface-2 ${line(h)}`}>
              {hourOf(v, h).bots.botHours}
            </span>
          )),
        )}
        <Legend
          label={t("botBlock.legend")}
          items={(["c0", "c1", "c2", "c3"] as const).map((k, i) => [
            COST_BG[i] ?? "",
            t(`botBlock.${k}`),
          ])}
          extra={[]}
        >
          <span>
            <strong className="text-warn">{t("botBlock.thin")}</strong> = {t("botBlock.thinLegend")}
          </span>
          <span>{t("botBlock.naLegend")}</span>
        </Legend>
      </div>
    </div>
  );
}

const hourOf = (v: MarketHoursView, h: number): MarketHoursHour =>
  v.hours[h] ?? {
    hour: h,
    volatility: {
      medianBp: null,
      p90Bp: null,
      ratio: null,
      hotPct: null,
      fiveMin: [],
      swingBp: null,
      estCostPerMillion: null,
    },
    cost: { markoutBp: null, spreadTicks: null },
    bots: { costPerMillion: null, volume: null, fees: null, botHours: 0, thin: false },
  };

/**
 * Ô "Estimated cost per $1M (model)": cùng 4 bậc màu với Cost per $1M của khối 3. Cả dòng n/a khi mô hình không tính
 * được cho market (lý do trong tooltip); một giờ không có nến → n/a.
 */
function EstCell({
  x,
  est,
  hour,
  line,
}: {
  x: MarketHoursHour["volatility"];
  est: MarketHoursView["estimate"];
  hour: number;
  line: string;
}) {
  const t = useTranslations("marketHours.vol");
  const tb = useTranslations("marketHours.botBlock");
  const cost = usd(x.estCostPerMillion);
  if (cost === null || x.estCostPerMillion === null || x.swingBp === null)
    return (
      <span
        title={
          est.unavailable === null
            ? tb("tipNa", { hour: pad(hour) })
            : t("estNa", { hour: pad(hour), reason: t(`estReason.${est.unavailable}`) })
        }
        className={`${CELL} ${line} ${HATCH}`}
      >
        {tb("na")}
      </span>
    );
  return (
    <span
      title={t("estTip", {
        hour: pad(hour),
        cost,
        swing: Number(x.swingBp).toFixed(1),
        fees: Number(est.feesBp).toFixed(1),
      })}
      className={`${CELL} ${line} ${costBg(Number(x.estCostPerMillion))}`}
    >
      {cost}
    </span>
  );
}

function BlockHead({
  title,
  sub,
  chip = null,
  note = null,
}: {
  title: string;
  sub: string;
  chip?: string | null;
  note?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5 border-t border-surface-2 pt-3.5 pb-1.5">
      <h3 className="m-0 text-[15px] font-extrabold">{title}</h3>
      <span className="text-[12.5px] text-muted">{sub}</span>
      {chip === null ? null : (
        <span className="rounded-[10px] bg-warn-bg px-2.5 py-[3px] text-xs font-bold text-warn">
          {chip}
        </span>
      )}
      {note === null ? null : <span className="w-full text-xs text-muted">{note}</span>}
    </div>
  );
}

function Num({ v, line, bg }: { v: string | null; line: string; bg?: string }) {
  const tb = useTranslations("marketHours.botBlock");
  return (
    <span className={`${CELL} ${line} ${v === null ? HATCH : (bg ?? "bg-surface-2")}`}>
      {v ?? tb("na")}
    </span>
  );
}

function BotCell({
  b,
  hour,
  line,
  kind,
}: {
  b: MarketHoursHour["bots"];
  hour: number;
  line: string;
  kind: "cost" | "volume" | "fees";
}) {
  const t = useTranslations("marketHours.botBlock");
  const value =
    kind === "cost" ? usd(b.costPerMillion) : kind === "volume" ? usdShort(b.volume) : usd(b.fees);
  if (value === null)
    return (
      <span title={t("tipNa", { hour: pad(hour) })} className={`${CELL} ${line} ${HATCH}`}>
        {t("na")}
      </span>
    );
  const title =
    t("tip", {
      hour: pad(hour),
      cost: usd(b.costPerMillion) ?? t("na"),
      botHours: b.botHours,
      volume: usdShort(b.volume) ?? t("na"),
    }) + (b.thin ? t("tipThin") : "");
  const bg = b.thin
    ? THIN_HATCH
    : kind === "cost"
      ? costBg(Number(b.costPerMillion))
      : "bg-surface-2";
  return (
    <span title={title} className={`${CELL} ${line} ${bg}`}>
      {value}
      {b.thin ? (
        <span className="block text-[8.5px] leading-none font-extrabold text-warn">
          {t("thin")}
        </span>
      ) : null}
    </span>
  );
}

function Legend({
  label,
  items,
  extra,
  children,
}: {
  label: string;
  items: readonly (readonly [string, string])[];
  extra: readonly (readonly [string, string])[];
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 pt-2 pb-1 pl-[202px] text-xs text-ink-2">
      <span className="font-bold">{label}</span>
      {[...items, ...extra].map(([bg, text]) => (
        <span key={text} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={`size-3.5 rounded-[3px] ${bg}`} />
          {text}
        </span>
      ))}
      {children}
    </div>
  );
}

function FiveMin({ values }: { values: readonly (string | null)[] }) {
  const tb = useTranslations("marketHours.botBlock");
  const max = Math.max(1, ...values.map((x) => (x === null ? 0 : Number(x))));
  return (
    <div className="grid h-24 grid-cols-12 items-end gap-1.5">
      {Array.from({ length: 12 }, (_, i) => {
        const x = values[i] ?? null;
        return (
          <span key={i} className="flex flex-col items-center gap-[3px] text-[10.5px]">
            <span>{x === null ? tb("na") : Number(x).toFixed(1)}</span>
            <span
              aria-hidden="true"
              className="w-[70%] rounded-t-[3px] bg-mh-vol-3"
              style={{ height: x === null ? 0 : Math.max(2, Math.round((Number(x) / max) * 60)) }}
            />
            <span className="text-muted">:{pad(i * 5)}</span>
          </span>
        );
      })}
    </div>
  );
}

/** 390 px (artboard Mobile): 24 dòng giờ; chạm một dòng để xem bước 5 phút và số đầy đủ. */
function Mobile({ v, markers }: { v: MarketHoursView; markers: readonly Marker[] }) {
  const t = useTranslations("marketHours");
  const tm = useTranslations("marketHours.mobile");
  const tb = useTranslations("marketHours.botBlock");
  const markAt = new Map(markers.map((m) => [m.hour, m]));
  const [open, setOpen] = useState<number>(markers.find((m) => m.us)?.hour ?? -1);
  return (
    <div className="flex flex-col gap-2 md:hidden">
      {v.markoutSince !== null && v.markoutDays < v.days ? (
        <span className="self-start rounded-[10px] bg-warn-bg px-2.5 py-[3px] text-[11.5px] font-bold text-warn">
          {tm("collecting", { date: instantLabel(v.markoutSince, v.tz) })}
        </span>
      ) : null}
      <div
        aria-hidden="true"
        className="grid grid-cols-[52px_repeat(4,minmax(0,1fr))] gap-1 text-center text-[10.5px] font-bold text-muted"
      >
        <span className="text-left">{t("hour")}</span>
        <span>{tm("ratio")}</span>
        <span>{tm("hot")}</span>
        <span>{tm("markout")}</span>
        <span>{tm("cost")}</span>
      </div>
      <ol className="m-0 flex list-none flex-col gap-[3px] p-0">
        {H.map((h) => {
          const x = hourOf(v, h);
          const m = markAt.get(h);
          const isOpen = open === h;
          const ratio = x.volatility.ratio === null ? null : Number(x.volatility.ratio);
          return (
            <li key={h}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => {
                  setOpen(isOpen ? -1 : h);
                }}
                className={`grid min-h-11 w-full cursor-pointer grid-cols-[52px_repeat(4,minmax(0,1fr))] items-center gap-1 rounded-[10px] border-0 px-1 py-[3px] text-center text-xs font-semibold text-ink ${isOpen ? "bg-accent-tint" : m !== undefined ? "bg-warn-bg/40" : "bg-transparent"}`}
              >
                <span className="flex flex-col text-left">
                  <strong className="text-[13px]">{pad(h)}</strong>
                  <span className="text-[9.5px] font-extrabold text-warn">
                    {m === undefined
                      ? ""
                      : m.us
                        ? t("usShort")
                        : tm("markerTag", { hour: pad(Math.floor(m.utc / 60)) })}
                  </span>
                </span>
                <span
                  className={`${CELL} rounded-[6px] ${ratio === null ? HATCH : volBgText(ratio)}`}
                >
                  {ratio === null ? tb("na") : `${ratio.toFixed(1)}×`}
                </span>
                <span>
                  {x.volatility.hotPct === null ? tb("na") : `${String(x.volatility.hotPct)}%`}
                </span>
                <span>{num(x.cost.markoutBp) ?? tb("na")}</span>
                <span
                  className={`${CELL} rounded-[6px] ${x.bots.costPerMillion === null || x.bots.thin ? THIN_HATCH : costBg(Number(x.bots.costPerMillion))}`}
                >
                  {usd(x.bots.costPerMillion) ?? tb("na")}
                  {x.bots.thin ? (
                    <span className="block text-[8.5px] font-extrabold text-warn">
                      {tb("thin")}
                    </span>
                  ) : null}
                </span>
              </button>
              {isOpen ? (
                <div className="mt-1 mb-1.5 flex flex-col gap-1.5 rounded-tile bg-surface-2 p-2.5">
                  <span className="text-xs font-bold">
                    {tm("detail", { from: `${pad(h)}:00`, to: `${pad(h)}:59` })}
                  </span>
                  <FiveMin values={x.volatility.fiveMin} />
                  <span className="text-[11.5px] text-ink-2">
                    {tm("line", {
                      med: num(x.volatility.medianBp) ?? tb("na"),
                      p90: num(x.volatility.p90Bp) ?? tb("na"),
                      spread:
                        x.cost.spreadTicks === null ? tb("na") : x.cost.spreadTicks.toFixed(1),
                      volume: usdShort(x.bots.volume) ?? tb("na"),
                      botHours: x.bots.botHours,
                    })}
                  </span>
                  <span className="text-[11.5px] text-ink-2">
                    <strong className="text-ink">{tm("est")}</strong>{" "}
                    {x.volatility.estCostPerMillion === null || x.volatility.swingBp === null
                      ? v.estimate.unavailable === null
                        ? tb("na")
                        : `${tb("na")} · ${t(`vol.estReason.${v.estimate.unavailable}`)}`
                      : tm("estLine", {
                          cost: usd(x.volatility.estCostPerMillion) ?? tb("na"),
                          swing: Number(x.volatility.swingBp).toFixed(1),
                          fees: Number(v.estimate.feesBp).toFixed(1),
                        })}
                  </span>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="m-0 text-xs text-muted">{tm("hint")}</p>
    </div>
  );
}
