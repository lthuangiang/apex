"use client";

import {
  dec,
  Decimal,
  MARKET_HOURS_CALIBRATION_DEFAULTS,
  MARKET_HOURS_CALIBRATION_THIN_HOURS,
  MARKET_HOURS_MIN_CUTS,
  MARKET_HOURS_THIN_BOT_HOURS,
  marketHoursViewSchema,
  type MarketHoursCalibrationScope,
  type MarketHoursHour,
  type MarketHoursView,
} from "@drift/shared";
import { SegmentedControl } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { Activity, Bot, ChevronRight, Info, Scale } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

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
const SHOCK_BG = ["bg-mh-shock-0", "bg-mh-shock-1", "bg-mh-shock-2", "bg-mh-shock-3"] as const;
/** Ngưỡng bậc cao nhất của "Largest 1-min range" / "Largest 15-min move": từ đây ô có thêm dấu ▲. */
export const SHOCK_HOT_BP = 100;
/**
 * Bậc màu "Largest …" (bp): dưới 25 · 25–50 · 50–100 · từ 100 (▲). Thang lấy từ khối 1: range 1 phút điển hình vài bp,
 * giờ nóng là > 2× trung vị ngày; 100 bp (1%) trong một phút / 15 phút là cú sốc.
 */
export function shockBucket(bp: number): number {
  return bp < 25 ? 0 : bp < 50 ? 1 : bp < SHOCK_HOT_BP ? 2 : 3;
}
const volBg = (ratio: number): string => VOL_BG[volBucket(ratio)] ?? "";
/** Hàng "× day median" có chữ: chỉ dùng ba bậc nhạt để chữ đạt tương phản. */
const volBgText = (ratio: number): string => VOL_BG[Math.min(volBucket(ratio), 2)] ?? "";
const costBg = (cost: number): string => COST_BG[costBucket(cost)] ?? "";

/**
 * Số → chuỗi `dp` chữ số thập phân (tính bằng Decimal). Giá trị làm tròn về 0 hiện "0.0" không dấu, không bao giờ
 * "-0.0" (vd markout -0.04 bp).
 */
export function fx(v: string | number | Decimal, dp = 1): string {
  const d = new Decimal(v).toDecimalPlaces(dp);
  return (d.isZero() ? d.abs() : d).toFixed(dp);
}
const num = (v: string | null, dp = 1): string | null => (v === null ? null : fx(v, dp));
function usdShort(v: string | null): string | null {
  if (v === null) return null;
  const d = dec(v);
  if (d.gte(1e6)) return `$${fx(d.div(1e6), 1)}M`;
  if (d.gte(1e3)) return `$${fx(d.div(1e3), 0)}K`;
  return `$${fx(d, 0)}`;
}
/** Tiền theo đô; dưới $10 (trị tuyệt đối) thì có cent để phí nhỏ không thành "$0" (vd "$0.31"). Tính bằng Decimal. */
export function usd(v: string | null): string | null {
  if (v === null) return null;
  const d = dec(v);
  return `$${d.abs().lt(10) ? fx(d, 2) : fx(d, 0)}`;
}
/** Tỷ lệ → phần trăm, 2 chữ số có nghĩa dưới 10% (vd "2.9", "0.69"), số nguyên từ 10% (vd "60"). */
export function pct(v: string): string {
  const d = dec(v).mul(100);
  return d.abs().lt(10) ? d.toSignificantDigits(2).toString() : d.toFixed(0);
}
/** Ngày địa phương "YYYY-MM-DD" từ API (đã theo múi giờ người xem) → "Nov 15, 2026". */
const dayLabel = (d: string): string => formatDate(Date.parse(`${d}T00:00:00Z`), "UTC");

/**
 * Câu nguồn hiệu chỉnh (DEC-293, người dùng duyệt): bot của market này → mọi market gộp lại →
 * hằng số mặc định (kèm ngày đo).
 */
function useSourceText(): (scope: MarketHoursCalibrationScope, market: string | null) => string {
  const t = useTranslations("marketHours.source");
  return (scope, market) =>
    scope.source === "market"
      ? t("market", { market: market ?? "", n: scope.botHours })
      : scope.source === "pooled"
        ? // Market có bot nhưng chưa đủ dữ liệu khác với market không có bot nào trong 14 ngày.
          t(scope.marketBotHours > 0 ? "pooledThin" : "pooled", {
            markets: scope.markets.join(", "),
          })
        : t("default", { date: dayLabel(MARKET_HOURS_CALIBRATION_DEFAULTS.date) });
}
/** Hệ số C hiển thị: 2 chữ số thập phân (vd "1.42"). */
const factor = (v: string): string => fx(v, 2);

/**
 * "Est. CPM (estimate)" gắn "Thin" khi C dựa trên ít hơn `MARKET_HOURS_CALIBRATION_THIN_HOURS` ô, hoặc là C mặc định
 * (DEC-TBD-market-hours-cleanup).
 */
export const calibrationThin = (est: MarketHoursView["estimate"]): boolean =>
  est.calibrationScope.source === "default" ||
  est.calibrationHours < MARKET_HOURS_CALIBRATION_THIN_HOURS;

/** Số ngày trong kỳ có nến (ít nhất một ô của heatmap có số). */
export const daysWithCandles = (heatmap: MarketHoursView["heatmap"]): number =>
  heatmap.filter((d) => d.cells.some((c) => c.ratio !== null)).length;

/** Dòng tóm tắt "Hottest hours" cần ít nhất chừng này ngày có nến. */
export const SUMMARY_MIN_DAYS = 3;
const SUMMARY_MAX_RANGES = 3;

/** Các đoạn giờ liền nhau (vòng qua nửa đêm: 23 → 00) của một tập giờ, dạng [giờ bắt đầu, số giờ]. */
function runsOf(picked: ReadonlySet<number>): [number, number][] {
  if (picked.size >= 24) return [[0, 24]];
  const runs: [number, number][] = [];
  for (const h of H) {
    if (!picked.has(h) || picked.has((h + 23) % 24)) continue;
    let len = 1;
    while (picked.has((h + len) % 24)) len += 1;
    runs.push([h, len]);
  }
  return runs;
}

/**
 * Dòng tóm tắt đầu kết quả (DEC-TBD-market-hours-cleanup), số quá khứ của khối 1, không dự báo: lấy giờ theo "Hot days"
 * từ cao xuống (bằng nhau thì ưu tiên giờ nối dài một đoạn đã chọn, rồi giờ sớm hơn), gộp giờ liền nhau thành đoạn, dừng
 * trước khi phải mở đoạn thứ 4 hoặc khi tới giờ 0%. Đoạn xếp theo % cao nhất của đoạn (bằng nhau thì giờ sớm hơn).
 * Null khi chưa đủ `SUMMARY_MIN_DAYS` ngày có nến, không giờ nào nóng, hoặc mọi giờ nóng như nhau.
 */
export function hottestHours(
  hotPct: readonly (number | null)[],
  daysWithData: number,
): { ranges: [number, number][]; min: number; max: number } | null {
  if (daysWithData < SUMMARY_MIN_DAYS) return null;
  const pctOf = (h: number): number => hotPct[h] ?? 0;
  const left = H.filter((h) => pctOf(h) > 0);
  const picked = new Set<number>();
  while (left.length > 0) {
    const top = Math.max(...left.map(pctOf));
    const tied = left.filter((h) => pctOf(h) === top);
    const next = tied.find((h) => picked.has((h + 23) % 24) || picked.has((h + 1) % 24)) ?? tied[0];
    if (next === undefined) break;
    picked.add(next);
    if (runsOf(picked).length > SUMMARY_MAX_RANGES) {
      picked.delete(next);
      break;
    }
    left.splice(left.indexOf(next), 1);
  }
  if (picked.size === 0 || picked.size >= 24) return null;
  const peak = ([s, len]: [number, number]): number =>
    Math.max(...Array.from({ length: len }, (_, i) => pctOf((s + i) % 24)));
  const ranges = runsOf(picked).sort((a, b) => peak(b) - peak(a) || a[0] - b[0]);
  const pcts = [...picked].map(pctOf);
  return { ranges, min: Math.min(...pcts), max: Math.max(...pcts) };
}
/** Mốc thời gian ISO → ngày theo múi giờ `tz`. */
const instantLabel = (iso: string, tz: string): string => formatDate(Date.parse(iso), tz);
/** Mốc thời gian ISO → ngày giờ theo múi giờ `tz`, vd "Nov 15, 2026, 08:57". */
const instantTimeLabel = (iso: string, tz: string): string =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: tz,
  }).format(Date.parse(iso));

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
      <div className="flex flex-col gap-3">
        <PageHead title={t("title")} subtitle={t("subtitle")} />
        {forbidden ? (
          <Card>
            <p className="m-0">{t("forbidden")}</p>
          </Card>
        ) : (
          <>
            <section
              aria-label={t("filters")}
              className="flex flex-col gap-3 rounded-tile border border-border bg-surface p-3 md:flex-row md:flex-wrap md:items-start md:gap-x-4 md:px-4"
            >
              <label className="flex flex-col gap-1 text-[12.5px] font-bold text-ink-2">
                {t("market")}
                <select
                  value={v?.market ?? market ?? ""}
                  onChange={(e) => {
                    setMarket(e.target.value);
                  }}
                  className="min-h-11 min-w-36 rounded-control border border-border-input bg-surface px-3 text-sm font-semibold text-ink"
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
              {/* Múi giờ nằm trong thẻ bộ lọc (không chen vào cụm trạng thái của thanh trên cùng). */}
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-control bg-surface-2 py-1 pr-1 pl-3 text-[12.5px] font-bold md:ml-auto md:self-end">
                <span>
                  {utcMode
                    ? t("tzUtc")
                    : t("tzLocal", { tz: tzLocal, offset: offsetLabel(offset) })}
                </span>
                <button
                  type="button"
                  aria-pressed={utcMode}
                  onClick={() => {
                    setUtcMode((x) => !x);
                  }}
                  className="min-h-11 cursor-pointer rounded-[9px] border border-border-input bg-surface px-3 text-[12.5px] font-bold text-ink"
                >
                  {utcMode ? t("showLocal") : t("showUtc")}
                </button>
              </div>
            </section>
            <HowToRead v={v} markers={markers} utcMode={utcMode} offset={offset} />
            <section
              aria-label={t("grid")}
              className="flex flex-col gap-2.5 rounded-card border border-border bg-surface px-3 py-3 md:px-4"
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
                  <Summary v={v} />
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

/** "Hottest hours: …" đầu kết quả (cả desktop và 390 px); không đủ dữ liệu thì không có dòng này. */
function Summary({ v }: { v: MarketHoursView }) {
  const t = useTranslations("marketHours.vol");
  const s = hottestHours(
    v.hours.map((h) => h.volatility.hotPct),
    daysWithCandles(v.heatmap),
  );
  if (s === null) return null;
  const ranges = s.ranges
    .map(([from, len]) =>
      t("hourRange", { from: `${pad(from)}:00`, to: `${pad((from + len) % 24)}:00` }),
    )
    .join(", ");
  return (
    <p className="m-0 text-[13.5px] font-bold">
      {s.min === s.max
        ? t("summaryOne", { ranges, pct: s.max })
        : t("summary", { ranges, min: s.min, max: s.max })}
    </p>
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

/** Ba mục "How to read this", mỗi mục một biểu tượng nhỏ theo khối 1 · 2 · 3. */
const HOW = [
  ["vol", Activity],
  ["cost", Scale],
  ["bots", Bot],
] as const;

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
  // Mở sẵn trên desktop; 390 px (artboard Mobile) đóng sẵn để bảng giờ lên gần đầu trang.
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches)
      setOpen(false);
  }, []);
  return (
    <details
      open={open}
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
      }}
      className="rounded-tile border border-border bg-surface px-4 py-2.5 text-sm leading-normal"
    >
      <summary className="min-h-7 cursor-pointer font-extrabold">{t("how.title")}</summary>
      <ul className="mt-1.5 mb-2 grid list-none gap-2 p-0 text-[13px] text-ink-2 md:grid-cols-3 md:gap-2.5">
        {HOW.map(([k, Icon]) => (
          <li key={k} className="flex gap-2.5 rounded-control bg-surface-2 p-2.5">
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-tint text-accent-ink"
            >
              <Icon size={15} strokeWidth={2.2} />
            </span>
            <span className="min-w-0">
              <strong className="block text-ink">{t(`how.${k}Title`)}</strong>
              {t(`how.${k}Body`)}
            </span>
          </li>
        ))}
      </ul>
      <p className="m-0 mb-1.5 text-[13px] text-ink-2">
        {t("how.note")} <strong className="text-ink">{t("how.cpm")}</strong>
      </p>
      <p className="m-0 mb-1.5 text-ink-2 md:hidden">
        <strong className="text-ink">{t("markers")}: </strong>
        {markers.map(label).join(", ")}
      </p>
      <details className="mt-1 rounded-control bg-surface-2 px-3 py-2">
        <summary className="min-h-7 cursor-pointer font-bold text-accent-ink">
          {t("calc.title")}
        </summary>
        <p className="mt-2 mb-0 text-ink-2">{t("calc.cpm")}</p>
        <dl className="mt-2 mb-0 flex flex-col gap-2.5 text-ink-2">
          <div>
            <dt className="font-extrabold text-ink">{t("calc.volTitle")}</dt>
            <dd className="m-0 mt-0.5">
              {t("calc.volBody")}{" "}
              {v === undefined ? null : (
                // Cách tính chi phí cắt và hệ số C của thị trường đang xem nằm trong "Model details" dưới dòng Est. CPM.
                <>{t("calc.estBody", { bp: v.estimate.shockBp })} </>
              )}
              {since(v?.candlesSince)}
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

// Cột nhãn 272 px: nhãn dài nhất ("Price move against makers, 30 s later (bp)") + nút ⓘ nằm trên một dòng ở 1440.
// Chú giải thụt vào 275 px (= nhãn + khe 3 px) để thẳng với cột giờ đầu tiên.
/**
 * Phần "How these numbers are calculated" về lần cắt vị thế và hiệu chỉnh (DEC-289, DEC-293):
 * chi phí cắt đo từ lệnh cắt thật hay chỉ phí taker, cỡ cắt = R × order size so với volume một bot-hour, và dòng
 * "calibrated" = "incl. shock days" × C, mỗi số kèm nguồn.
 */
function CutCalc({ est, market }: { est: MarketHoursView["estimate"]; market: string | null }) {
  const t = useTranslations("marketHours.calc");
  const sourceOf = useSourceText();
  const cutSource = sourceOf(est.cutScope, market);
  const calSource = sourceOf(est.calibrationScope, market);
  return (
    <>
      {est.cutSlippageBp === null
        ? t("cutTakerOnly", {
            taker: fx(est.cutTakerBp),
            n: est.cuts,
            min: MARKET_HOURS_MIN_CUTS,
          })
        : t("cutMeasured", {
            taker: fx(est.cutTakerBp),
            slip: fx(est.cutSlippageBp),
            n: est.cuts,
          })}{" "}
      {est.cutShare === null || est.fillsPerBotHour === null
        ? t("cutNone", { source: cutSource })
        : t(est.positionRatioSource === "cuts" ? "cutSizeCuts" : "cutSizeRatio", {
            ratio: fx(est.positionRatio),
            notional: usd(est.cutNotional) ?? "",
            fills: fx(est.fillsPerBotHour),
            pct: pct(est.cutShare),
            source: cutSource,
          })}{" "}
      <strong className="text-ink">
        {est.calibrationScope.source === "default"
          ? t("calibratedDefault", { factor: factor(est.calibration), source: calSource })
          : t("calibrated", {
              factor: factor(est.calibration),
              hours: est.calibrationHours,
              source: calSource,
            })}
      </strong>
    </>
  );
}

const COLS = "grid grid-cols-[272px_repeat(24,minmax(0,1fr))] gap-[3px]";
const GRID = `${COLS} items-center`;
const CELL =
  "flex min-h-[26px] flex-col items-center justify-center rounded-[4px] text-center text-[11px] leading-tight font-semibold";

/** Bỏ các ngày đầu kỳ chưa có nến nào (cả 24 ô đều thiếu); ngày thiếu ở giữa kỳ vẫn giữ. */
export function trimLeadingEmptyDays(
  heatmap: MarketHoursView["heatmap"],
): MarketHoursView["heatmap"] {
  const first = heatmap.findIndex((d) => d.cells.some((c) => c.ratio !== null));
  return first === -1 ? [] : heatmap.slice(first);
}

/** Heatmap 7 ngày: dòng cao, nhãn có thứ; 30 ngày: dòng gọn (vẫn có tooltip trên từng ô). */
const heatRowLabel = (d: string, roomy: boolean): string =>
  new Intl.DateTimeFormat("en-US", {
    ...(roomy ? { weekday: "short" as const } : {}),
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(Date.parse(`${d}T00:00:00Z`));

/**
 * Nhóm dòng có đường mốc: một đường dọc mảnh màu cam ở mép trái cột giờ có mốc, liền qua khe giữa các dòng, vẽ trên lớp
 * phủ không nhận chuột (tooltip của ô vẫn chạy). Không phủ qua tiêu đề khối, chú giải hay biểu đồ 5 phút.
 */
function Marked({ marked, children }: { marked: ReadonlySet<number>; children: ReactNode }) {
  return (
    <div className="relative flex flex-col gap-[3px]">
      {children}
      <div aria-hidden="true" className={`${COLS} pointer-events-none absolute inset-0`}>
        <span />
        {H.map((h) => (
          <span key={h} className={marked.has(h) ? "-ml-[2px] border-l border-warn-bar" : ""} />
        ))}
      </div>
    </div>
  );
}

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
  const marked = new Set(markAt.keys());
  const strategies = v.strategy === "both" ? t("botBlock.both") : t(`strategies.${v.strategy}`);
  const selected = v.hours[sel];
  const usAtSel = markAt.get(sel)?.us === true ? markAt.get(sel) : undefined;
  const halfHour = !utcMode && offset % 60 !== 0;
  const heat = trimLeadingEmptyDays(v.heatmap);
  const roomy = v.days <= 7;
  const firstDay = heat[0]?.date;
  const covered = daysWithCandles(heat);
  const [modelOpen, setModelOpen] = useState(false);
  const modelId = useId();
  const estThin = calibrationThin(v.estimate);
  const row = (labelText: string, help: HelpKey, cells: ReactNode[], mark?: ReactNode) => (
    <div className={GRID}>
      <span className="flex items-center gap-1 pr-2 text-xs leading-tight font-bold whitespace-nowrap">
        <span className="min-w-0">{labelText}</span>
        <RowHelp label={labelText} help={help} />
        {mark}
      </span>
      {cells}
    </div>
  );
  return (
    <div className="hidden overflow-x-auto md:block">
      <div className="flex min-w-[1060px] flex-col gap-0.5">
        <div className={GRID}>
          <span className="self-end pb-1 text-xs font-bold text-muted">{t("hour")}</span>
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
                className={`flex min-h-11 cursor-pointer flex-col items-center justify-end gap-1 rounded-lg border-0 py-1 text-xs font-extrabold ${sel === h ? "bg-accent-tint text-accent-ink" : "bg-transparent text-ink hover:bg-surface-2"}`}
              >
                {tag === "" ? null : (
                  <span className="rounded-full bg-warn-bg px-1 text-[9px] leading-[14px] font-extrabold whitespace-nowrap text-warn">
                    {tag}
                  </span>
                )}
                {pad(h)}
              </button>
            );
          })}
        </div>

        <BlockHead
          title={t("vol.title")}
          sub={t("vol.sub")}
          chip={
            firstDay !== undefined && covered < v.days
              ? t("vol.dataSince", { date: dayLabel(firstDay), n: covered, days: v.days })
              : null
          }
          chipTone="info"
        />
        <Marked marked={marked}>
          {heat.map((d) => (
            <div key={d.date} className={GRID}>
              <span
                className={`whitespace-nowrap ${roomy ? "text-[12.5px] font-semibold text-ink-2" : "text-[11px] leading-none text-muted"}`}
              >
                {heatRowLabel(d.date, roomy)}
              </span>
              {d.cells.map((c, h) => {
                const r = c.ratio === null ? null : Number(c.ratio);
                const title =
                  r === null || c.medianBp === null
                    ? t("vol.cellNa", { date: dayLabel(d.date), hour: pad(h) })
                    : t("vol.cellTip", {
                        date: dayLabel(d.date),
                        hour: pad(h),
                        bp: fx(c.medianBp),
                        ratio: fx(r),
                      }) + (r > 2 ? t("vol.hot") : "");
                return (
                  <span
                    key={h}
                    title={title}
                    className={`${roomy ? "h-7 rounded-[4px]" : "h-3.5 rounded-[2px]"} outline outline-1 -outline-offset-1 outline-ink/10 ${r === null ? HATCH : volBg(r)}`}
                  />
                );
              })}
            </div>
          ))}
        </Marked>
        <Legend
          label={t("vol.legend")}
          items={(["b0", "b1", "b2", "b3", "b4"] as const).map((k, i) => [
            VOL_BG[i] ?? "",
            t(`vol.${k}`),
          ])}
          extra={[[HATCH, tm("notAvailable")]]}
        />
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 pb-1 pl-[275px] text-xs text-ink-2">
          <span className="font-bold">{t("markers")}</span>
          {markers.map((m) => (
            <span key={`${String(m.utc)}-${String(m.us)}`}>{label(m)}</span>
          ))}
          <span className="text-muted">{t("usNote")}</span>
        </div>
        <Marked marked={marked}>
          {row(
            t("vol.medianBp"),
            "medianBp",
            H.map((h) => <Num key={h} v={num(hourOf(v, h).volatility.medianBp)} />),
          )}
          {row(
            t("vol.p90Bp"),
            "p90Bp",
            H.map((h) => <Num key={h} v={num(hourOf(v, h).volatility.p90Bp)} />),
          )}
          {row(
            t("vol.ratio"),
            "ratio",
            H.map((h) => {
              const r = hourOf(v, h).volatility.ratio;
              return (
                <Num
                  key={h}
                  v={r === null ? null : `${fx(r)}×`}
                  {...(r === null ? {} : { bg: volBgText(Number(r)) })}
                />
              );
            }),
          )}
          {row(
            t("vol.hotDays"),
            "hotDays",
            H.map((h) => {
              const p = hourOf(v, h).volatility.hotPct;
              return <Num key={h} v={p === null ? null : `${String(p)}%`} />;
            }),
          )}
        </Marked>
        <Marked marked={marked}>
          {row(
            t("vol.maxRange"),
            "maxRange",
            H.map((h) => {
              const x = hourOf(v, h).volatility;
              return (
                <ShockCell
                  key={h}
                  bp={x.maxRangeBp}
                  tip={
                    x.maxRangeBp === null || x.maxRangeAt === null
                      ? null
                      : t("vol.maxRangeTip", {
                          value: fx(x.maxRangeBp),
                          at: instantTimeLabel(x.maxRangeAt, v.tz),
                        })
                  }
                  hour={h}
                />
              );
            }),
          )}
          {row(
            t("vol.maxMove15"),
            "maxMove15",
            H.map((h) => {
              const x = hourOf(v, h).volatility;
              return (
                <ShockCell
                  key={h}
                  bp={x.maxMove15Bp}
                  tip={
                    x.maxMove15Bp === null || x.maxMove15At === null
                      ? null
                      : t("vol.maxMove15Tip", {
                          value: fx(x.maxMove15Bp),
                          at: instantTimeLabel(x.maxMove15At, v.tz),
                        })
                  }
                  hour={h}
                />
              );
            }),
          )}
        </Marked>
        <Legend
          label={t("vol.shockLegend")}
          items={(["s0", "s1", "s2", "s3"] as const).map((k, i) => [
            SHOCK_BG[i] ?? "",
            t(`vol.${k}`),
          ])}
          extra={[]}
        />
        {/* Một dòng "Est. CPM (estimate)" (số đã hiệu chỉnh); hai dòng mô hình và cách tính nằm trong "Model details". */}
        <Marked marked={marked}>
          {row(
            t("vol.estCalibrated"),
            "estCalibrated",
            H.map((h) => (
              <EstCell
                key={h}
                x={hourOf(v, h).volatility}
                est={v.estimate}
                market={v.market}
                hour={h}
                kind="calibrated"
              />
            )),
            estThin ? <ThinMark /> : null,
          )}
        </Marked>
        <div>
          <button
            type="button"
            aria-expanded={modelOpen}
            aria-controls={modelId}
            onClick={() => {
              setModelOpen((x) => !x);
            }}
            className="inline-flex min-h-6 cursor-pointer items-center gap-1 rounded-control border-0 bg-transparent p-0 text-xs font-bold text-accent-ink"
          >
            <ChevronRight
              size={14}
              strokeWidth={2.4}
              aria-hidden="true"
              className={`transition-transform ${modelOpen ? "rotate-90" : ""}`}
            />
            {t("vol.modelDetails")}
          </button>
        </div>
        <div id={modelId} hidden={!modelOpen} className="flex flex-col gap-1.5">
          <Marked marked={marked}>
            {row(
              t("vol.estTypical"),
              "estTypical",
              H.map((h) => (
                <EstCell
                  key={h}
                  x={hourOf(v, h).volatility}
                  est={v.estimate}
                  market={v.market}
                  hour={h}
                  kind="typical"
                />
              )),
            )}
            {row(
              t("vol.estShock"),
              "estShock",
              H.map((h) => (
                <EstCell
                  key={h}
                  x={hourOf(v, h).volatility}
                  est={v.estimate}
                  market={v.market}
                  hour={h}
                  kind="shock"
                />
              )),
            )}
          </Marked>
          <p className="m-0 pl-[275px] text-xs leading-normal text-ink-2">
            <CutCalc est={v.estimate} market={v.market} />
          </p>
        </div>
        <Legend
          label={t("vol.estLegend")}
          items={(["c0", "c1", "c2", "c3"] as const).map((k, i) => [
            COST_BG[i] ?? "",
            t(`botBlock.${k}`),
          ])}
          extra={[]}
        >
          <span>
            <strong className="text-warn">{t("botBlock.thin")}</strong> = {t("vol.estThinLegend")}
          </span>
          <span>{t("botBlock.naLegend")}</span>
        </Legend>
        <div className="mt-0.5 mb-0.5 flex flex-col gap-1.5 rounded-tile bg-surface-2 px-3 py-2.5">
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
        <Marked marked={marked}>
          {row(
            t("cost.markout"),
            "markout",
            H.map((h) => <Num key={h} v={num(hourOf(v, h).cost.markoutBp)} />),
          )}
          {row(
            t("cost.spread"),
            "spread",
            H.map((h) => {
              const s = hourOf(v, h).cost.spreadTicks;
              return <Num key={h} v={s === null ? null : fx(s)} />;
            }),
          )}
        </Marked>

        <BlockHead title={t("botBlock.title")} sub={t("botBlock.sub", { strategies })} />
        <Marked marked={marked}>
          {row(
            t("botBlock.cost"),
            "cost",
            H.map((h) => <BotCell key={h} b={hourOf(v, h).bots} hour={h} kind="cost" />),
          )}
          {row(
            t("botBlock.volume"),
            "volume",
            H.map((h) => <BotCell key={h} b={hourOf(v, h).bots} hour={h} kind="volume" />),
          )}
          {row(
            t("botBlock.fees"),
            "fees",
            H.map((h) => <BotCell key={h} b={hourOf(v, h).bots} hour={h} kind="fees" />),
          )}
          {row(
            t("botBlock.botHours"),
            "botHours",
            H.map((h) => (
              <span key={h} className={`${CELL} bg-surface-2`}>
                {hourOf(v, h).bots.botHours}
              </span>
            )),
          )}
        </Marked>
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
      estShockCostPerMillion: null,
      estCalibratedCostPerMillion: null,
      estDays: null,
      shockDays: null,
      maxRangeBp: null,
      maxRangeAt: null,
      maxMove15Bp: null,
      maxMove15At: null,
    },
    cost: { markoutBp: null, spreadTicks: null },
    bots: { costPerMillion: null, volume: null, fees: null, botHours: 0, thin: false },
  };

/** Tooltip của ô "Est. CPM · incl. shock days"; null khi giờ đó không có số. */
function shockTip(
  t: ReturnType<typeof useTranslations<"marketHours.vol">>,
  x: MarketHoursHour["volatility"],
  est: MarketHoursView["estimate"],
  hour: number,
  cutSource: string,
): string | null {
  const cost = usd(x.estShockCostPerMillion);
  if (cost === null || x.estDays === null || x.shockDays === null) return null;
  return (
    t("estShockTip", {
      hour: pad(hour),
      cost,
      shock: x.shockDays,
      days: x.estDays,
      bp: est.shockBp,
      cut: fx(est.cutCostBp),
    }) + cutSuffix(t, est, cutSource)
  );
}

/**
 * Đuôi tooltip / dòng 390 px của "incl. shock days": cách tính chi phí và cỡ một lần cắt (R × order size, phần trăm
 * volume một bot-hour, nguồn).
 */
function cutSuffix(
  t: ReturnType<typeof useTranslations<"marketHours.vol">>,
  est: MarketHoursView["estimate"],
  cutSource: string,
): string {
  if (est.cutShare === null) return t("noCut");
  return (
    (est.cutSlippageBp === null ? t("takerOnly") : "") +
    t(est.positionRatioSource === "cuts" ? "cutSizeCuts" : "cutSize", {
      ratio: fx(est.positionRatio),
      pct: pct(est.cutShare),
      source: cutSource,
    })
  );
}

/** Tooltip / dòng 390 px của "Est. CPM (estimate)": giá trị, "incl. shock days" × C và nguồn của C. */
function calibratedTip(
  t: ReturnType<typeof useTranslations<"marketHours.vol">>,
  x: MarketHoursHour["volatility"],
  est: MarketHoursView["estimate"],
  hour: number,
  calSource: string,
): string | null {
  const cost = usd(x.estCalibratedCostPerMillion);
  const shock = usd(x.estShockCostPerMillion);
  if (cost === null || shock === null) return null;
  return t("estCalibratedTip", {
    hour: pad(hour),
    cost,
    shock,
    factor: factor(est.calibration),
    source: calSource,
  });
}

/**
 * Ô "Est. CPM · typical day (model)", "Est. CPM · incl. shock days (model)" (trong "Model details") và "Est. CPM
 * (estimate)" (= calibrated): cùng 4 bậc màu với Markout cost / $1M của khối 3. Cả dòng n/a khi mô hình không tính được cho market (lý do trong tooltip); một giờ không có
 * nến → n/a.
 */
function EstCell({
  x,
  est,
  market,
  hour,
  kind,
}: {
  x: MarketHoursHour["volatility"];
  est: MarketHoursView["estimate"];
  market: string | null;
  hour: number;
  kind: "typical" | "shock" | "calibrated";
}) {
  const t = useTranslations("marketHours.vol");
  const tb = useTranslations("marketHours.botBlock");
  const sourceOf = useSourceText();
  const value =
    kind === "typical"
      ? x.estCostPerMillion
      : kind === "shock"
        ? x.estShockCostPerMillion
        : x.estCalibratedCostPerMillion;
  const cost = usd(value);
  const tip =
    kind === "shock"
      ? shockTip(t, x, est, hour, sourceOf(est.cutScope, market))
      : kind === "calibrated"
        ? calibratedTip(t, x, est, hour, sourceOf(est.calibrationScope, market))
        : x.swingBp === null || cost === null
          ? null
          : t("estTip", {
              hour: pad(hour),
              cost,
              swing: fx(x.swingBp),
              fees: fx(est.feesBp),
            });
  if (cost === null || value === null || tip === null)
    return (
      <span
        title={
          est.unavailable === null
            ? tb("tipNa", { hour: pad(hour) })
            : t("estNa", { hour: pad(hour), reason: t(`estReason.${est.unavailable}`) })
        }
        className={`${CELL} ${HATCH}`}
      >
        {tb("na")}
      </span>
    );
  return (
    <span title={tip} className={`${CELL} ${costBg(Number(value))}`}>
      {cost}
    </span>
  );
}

type HelpKey =
  | "medianBp"
  | "p90Bp"
  | "ratio"
  | "hotDays"
  | "maxRange"
  | "maxMove15"
  | "estTypical"
  | "estShock"
  | "estCalibrated"
  | "markout"
  | "spread"
  | "cost"
  | "volume"
  | "fees"
  | "botHours";

/**
 * Nút ⓘ cạnh nhãn dòng (và tiêu đề cột 390 px): hiện giải thích `marketHours.help.<key>` khi rê chuột, focus hoặc
 * chạm. Bấm / chạm thì ghim mở tới khi bấm lại, bấm ra ngoài hoặc Esc. Popup `fixed` theo nút để không bị cắt bởi
 * khung cuộn ngang của lưới.
 */
function RowHelp({
  label,
  help,
  values,
}: {
  label: string;
  help: HelpKey;
  /** Tham số của câu giải thích (vd `{source}` của "calibrated"). */
  values?: Record<string, string> | undefined;
}) {
  const t = useTranslations("marketHours.help");
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [pinned, setPinned] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r === undefined) return;
    // Popup tự xuống dòng (`whitespace-normal`): ô nhãn của dòng là `whitespace-nowrap`, kế thừa sẽ làm chữ tràn khung.
    const width = Math.min(340, window.innerWidth - 32);
    const left = Math.max(16, Math.min(r.left - 12, window.innerWidth - width - 16));
    setPos({ top: r.bottom, left, width });
  };
  const hide = () => {
    setPos(null);
    setPinned(false);
  };

  useEffect(() => {
    if (pos === null) return;
    const close = () => {
      setPos(null);
      setPinned(false);
    };
    const outside = (e: Event) => {
      const n = e.target as Node | null;
      if (n !== null && wrap.current?.contains(n) === true) return;
      close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  // Rời nút / popup: chờ một nhịp rồi mới đóng, để rê chuột từ nút sang popup (và ngược lại) không làm nó đóng.
  useEffect(
    () => () => {
      clearTimeout(leaveTimer.current);
    },
    [],
  );
  const enter = () => {
    clearTimeout(leaveTimer.current);
    if (pos === null) show();
  };
  const leave = () => {
    if (pinned) return;
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      setPos(null);
    }, 120);
  };

  const open = pos !== null;
  return (
    <span ref={wrap} className="inline-flex shrink-0">
      <button
        ref={btn}
        type="button"
        aria-label={t("about", { label })}
        aria-expanded={open}
        {...(open ? { "aria-describedby": id } : {})}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocus={show}
        onBlur={hide}
        onClick={() => {
          if (pinned) {
            hide();
          } else {
            show();
            setPinned(true);
          }
        }}
        className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted transition-colors hover:text-accent focus-visible:text-accent md:size-6"
      >
        <Info size={14} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {pos === null ? null : (
        <span
          role="presentation"
          onMouseEnter={enter}
          onMouseLeave={leave}
          style={{ top: pos.top, left: pos.left, width: pos.width }}
          className="fixed z-50 block pt-1.5"
        >
          <span
            id={id}
            role="tooltip"
            className="block rounded-tile border border-border bg-surface px-3.5 py-3 text-left text-[13px] leading-relaxed font-normal tracking-normal break-words whitespace-normal text-ink normal-case shadow-lg"
          >
            {t(help, values)}
          </span>
        </span>
      )}
    </span>
  );
}

/** Ô "Largest 1-min range" / "Largest 15-min move": số bp làm tròn, 4 bậc tím, ▲ từ SHOCK_HOT_BP; thiếu nến → n/a. */
function ShockCell({ bp, tip, hour }: { bp: string | null; tip: string | null; hour: number }) {
  const tb = useTranslations("marketHours.botBlock");
  if (bp === null || tip === null)
    return (
      <span title={tb("tipNa", { hour: pad(hour) })} className={`${CELL} ${HATCH}`}>
        {tb("na")}
      </span>
    );
  const n = Number(bp);
  return (
    <span title={tip} className={`${CELL} ${SHOCK_BG[shockBucket(n)] ?? ""}`}>
      {fx(bp, 0)}
      {n >= SHOCK_HOT_BP ? (
        <span aria-hidden="true" className="block text-[8.5px] leading-none">
          ▲
        </span>
      ) : null}
    </span>
  );
}

function BlockHead({
  title,
  sub,
  chip = null,
  chipTone = "warn",
  note = null,
}: {
  title: string;
  sub: string;
  chip?: string | null;
  /** "warn" = đang thu thập (cam); "info" = chỉ cho biết dữ liệu bắt đầu từ ngày nào. */
  chipTone?: "warn" | "info";
  note?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-t border-surface-2 pt-2.5 pb-1">
      <h3 className="m-0 text-[15px] font-extrabold">{title}</h3>
      <span className="text-[12.5px] text-muted">{sub}</span>
      {chip === null ? null : (
        <span
          className={`rounded-[10px] px-2.5 py-[3px] text-xs font-bold ${chipTone === "warn" ? "bg-warn-bg text-warn" : "bg-surface-2 text-ink-2"}`}
        >
          {chip}
        </span>
      )}
      {note === null ? null : <span className="w-full text-xs text-muted">{note}</span>}
    </div>
  );
}

function Num({ v, bg }: { v: string | null; bg?: string }) {
  const tb = useTranslations("marketHours.botBlock");
  return (
    <span className={`${CELL} ${v === null ? HATCH : (bg ?? "bg-surface-2")}`}>
      {v ?? tb("na")}
    </span>
  );
}

/** Dấu "Thin" nhỏ cạnh nhãn dòng (dòng "Est. CPM (estimate)" khi C mỏng); chú giải giải thích. */
function ThinMark() {
  const t = useTranslations("marketHours.botBlock");
  return (
    <span className="rounded-full bg-warn-bg px-1.5 text-[10px] leading-4 font-extrabold text-warn">
      {t("thin")}
    </span>
  );
}

/**
 * Ô khối 3 (cả desktop và cột 390 px) có "Thin" khi có bot chạy hoặc có fill mà dưới 3 bot-hour, đúng như chú giải
 * hứa; ô không có bot nào chạy và không có fill thì không. API đã gắn `thin`; điều kiện bot-hour giữ để không phụ
 * thuộc cách API làm tròn.
 */
export const botThin = (b: MarketHoursHour["bots"]): boolean =>
  b.thin || ((b.volume !== null || b.botHours > 0) && b.botHours < MARKET_HOURS_THIN_BOT_HOURS);

/** Ô có bot chạy (bot-hour > 0) mà không có fill nào: "Thin · no fills" (dưới 3 bot-hour) hoặc "No fills". */
const noFills = (b: MarketHoursHour["bots"]): boolean => b.volume === null && b.botHours > 0;

function NoFillsText({ thin }: { thin: boolean }) {
  const t = useTranslations("marketHours.botBlock");
  return thin ? (
    <>
      <span className="block text-[8.5px] leading-none font-extrabold text-warn">{t("thin")}</span>
      <span className="sr-only"> · </span>
      <span className="block text-[9px] leading-tight">{t("noFillsShort")}</span>
    </>
  ) : (
    <span className="block text-[9px] leading-tight">{t("noFills")}</span>
  );
}

function BotCell({
  b,
  hour,
  kind,
}: {
  b: MarketHoursHour["bots"];
  hour: number;
  kind: "cost" | "volume" | "fees";
}) {
  const t = useTranslations("marketHours.botBlock");
  const thin = botThin(b);
  if (noFills(b))
    return (
      <span
        title={
          t("tipNoFills", { hour: pad(hour), botHours: b.botHours }) + (thin ? t("tipThin") : "")
        }
        className={`${CELL} ${thin ? THIN_HATCH : HATCH}`}
      >
        <NoFillsText thin={thin} />
      </span>
    );
  const value =
    kind === "cost" ? usd(b.costPerMillion) : kind === "volume" ? usdShort(b.volume) : usd(b.fees);
  const title =
    (value === null
      ? t("tipNa", { hour: pad(hour) })
      : t("tip", {
          hour: pad(hour),
          cost: usd(b.costPerMillion) ?? t("na"),
          botHours: b.botHours,
          volume: usdShort(b.volume) ?? t("na"),
        })) + (thin ? t("tipThin") : "");
  const bg = thin
    ? THIN_HATCH
    : value === null
      ? HATCH
      : kind === "cost"
        ? costBg(Number(b.costPerMillion))
        : "bg-surface-2";
  return (
    <span title={title} className={`${CELL} ${bg}`}>
      {value ?? t("na")}
      {thin ? (
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
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 pt-1 pb-0.5 pl-[275px] text-xs text-ink-2">
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
    <div className="grid h-20 grid-cols-12 items-end gap-1.5">
      {Array.from({ length: 12 }, (_, i) => {
        const x = values[i] ?? null;
        return (
          <span key={i} className="flex flex-col items-center gap-[3px] text-[10.5px]">
            <span>{x === null ? tb("na") : fx(x)}</span>
            <span
              aria-hidden="true"
              className="w-[70%] rounded-t-[3px] bg-mh-vol-3"
              style={{ height: x === null ? 0 : Math.max(2, Math.round((Number(x) / max) * 46)) }}
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
  const tv = useTranslations("marketHours.vol");
  const sourceOf = useSourceText();
  const markAt = new Map(markers.map((m) => [m.hour, m]));
  const [open, setOpen] = useState<number>(markers.find((m) => m.us)?.hour ?? -1);
  const [modelOpen, setModelOpen] = useState(false);
  const modelId = useId();
  const estThin = calibrationThin(v.estimate);
  return (
    <div className="flex flex-col gap-2 md:hidden">
      {v.markoutSince !== null && v.markoutDays < v.days ? (
        <span className="self-start rounded-[10px] bg-warn-bg px-2.5 py-[3px] text-[11.5px] font-bold text-warn">
          {tm("collecting", { date: instantLabel(v.markoutSince, v.tz) })}
        </span>
      ) : null}
      <div className="grid grid-cols-[52px_repeat(4,minmax(0,1fr))] items-end gap-1 text-center text-[10.5px] font-bold text-muted">
        <span className="self-center text-left">{t("hour")}</span>
        {(
          [
            ["ratio", "ratio"],
            ["hot", "hotDays"],
            ["markout", "markout"],
            ["cost", "cost"],
          ] as const
        ).map(([k, help]) => (
          <span key={k} className="flex flex-col items-center">
            {tm(k)}
            <RowHelp label={tm(k)} help={help} />
          </span>
        ))}
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
                  {ratio === null ? tb("na") : `${fx(ratio)}×`}
                </span>
                <span>
                  {x.volatility.hotPct === null ? tb("na") : `${String(x.volatility.hotPct)}%`}
                </span>
                <span>{num(x.cost.markoutBp) ?? tb("na")}</span>
                <span
                  className={`${CELL} rounded-[6px] ${x.bots.costPerMillion === null || botThin(x.bots) ? THIN_HATCH : costBg(Number(x.bots.costPerMillion))}`}
                >
                  {noFills(x.bots) ? (
                    <NoFillsText thin={botThin(x.bots)} />
                  ) : (
                    <>
                      {usd(x.bots.costPerMillion) ?? tb("na")}
                      {botThin(x.bots) ? (
                        <span className="block text-[8.5px] font-extrabold text-warn">
                          {tb("thin")}
                        </span>
                      ) : null}
                    </>
                  )}
                </span>
              </button>
              {isOpen ? (
                <div className="mt-1 mb-1 flex flex-col gap-1.5 rounded-tile bg-surface-2 p-2.5">
                  <span className="text-xs font-bold">
                    {tm("detail", { from: `${pad(h)}:00`, to: `${pad(h)}:59` })}
                  </span>
                  <FiveMin values={x.volatility.fiveMin} />
                  <span className="text-[11.5px] text-ink-2">
                    {tm("line", {
                      med: num(x.volatility.medianBp) ?? tb("na"),
                      p90: num(x.volatility.p90Bp) ?? tb("na"),
                      spread: x.cost.spreadTicks === null ? tb("na") : fx(x.cost.spreadTicks),
                      volume: usdShort(x.bots.volume) ?? tb("na"),
                      botHours: x.bots.botHours,
                    })}
                  </span>
                  {(
                    [
                      ["maxRange", x.volatility.maxRangeBp, x.volatility.maxRangeAt],
                      ["maxMove15", x.volatility.maxMove15Bp, x.volatility.maxMove15At],
                    ] as const
                  ).map(([k, bp, at]) => (
                    <span key={k} className="flex items-center gap-1 text-[11.5px] text-ink-2">
                      <span>
                        <strong className="text-ink">{tm(k)}</strong>{" "}
                        {bp === null || at === null
                          ? tb("na")
                          : `${t(`vol.${k}Tip`, {
                              value: fx(bp),
                              at: instantTimeLabel(at, v.tz),
                            })}${Number(bp) >= SHOCK_HOT_BP ? " ▲" : ""}`}
                      </span>
                      <RowHelp label={tm(k)} help={k} />
                    </span>
                  ))}
                  {/* Một dòng "Est. CPM (estimate)"; hai dòng mô hình nằm trong "Model details" (như desktop). */}
                  <span className="text-[11.5px] text-ink-2">
                    <strong className="text-ink">{tm("estCalibrated")}</strong>{" "}
                    {estThin ? (
                      <>
                        <ThinMark />{" "}
                      </>
                    ) : null}
                    {x.volatility.estCalibratedCostPerMillion === null ||
                    x.volatility.estShockCostPerMillion === null
                      ? v.estimate.unavailable === null
                        ? tb("na")
                        : `${tb("na")} · ${t(`vol.estReason.${v.estimate.unavailable}`)}`
                      : tm("estCalibratedLine", {
                          cost: usd(x.volatility.estCalibratedCostPerMillion) ?? tb("na"),
                          shock: usd(x.volatility.estShockCostPerMillion) ?? tb("na"),
                          factor: factor(v.estimate.calibration),
                          source: sourceOf(v.estimate.calibrationScope, v.market),
                        })}
                  </span>
                  <button
                    type="button"
                    aria-expanded={modelOpen}
                    aria-controls={modelId}
                    onClick={() => {
                      setModelOpen((o) => !o);
                    }}
                    className="inline-flex min-h-11 cursor-pointer items-center gap-1 self-start border-0 bg-transparent p-0 text-xs font-bold text-accent-ink"
                  >
                    <ChevronRight
                      size={14}
                      strokeWidth={2.4}
                      aria-hidden="true"
                      className={`transition-transform ${modelOpen ? "rotate-90" : ""}`}
                    />
                    {tv("modelDetails")}
                  </button>
                  <div id={modelId} hidden={!modelOpen} className="flex flex-col gap-1.5">
                    <span className="block text-[11.5px] text-ink-2">
                      <strong className="text-ink">{tm("est")}</strong>{" "}
                      {x.volatility.estCostPerMillion === null || x.volatility.swingBp === null
                        ? v.estimate.unavailable === null
                          ? tb("na")
                          : `${tb("na")} · ${t(`vol.estReason.${v.estimate.unavailable}`)}`
                        : tm("estLine", {
                            cost: usd(x.volatility.estCostPerMillion) ?? tb("na"),
                            swing: fx(x.volatility.swingBp),
                            fees: fx(v.estimate.feesBp),
                          })}
                    </span>
                    <span className="block text-[11.5px] text-ink-2">
                      <strong className="text-ink">{tm("estShock")}</strong>{" "}
                      {x.volatility.estShockCostPerMillion === null ||
                      x.volatility.estDays === null ||
                      x.volatility.shockDays === null
                        ? v.estimate.unavailable === null
                          ? tb("na")
                          : `${tb("na")} · ${t(`vol.estReason.${v.estimate.unavailable}`)}`
                        : tm("estShockLine", {
                            cost: usd(x.volatility.estShockCostPerMillion) ?? tb("na"),
                            shock: x.volatility.shockDays,
                            days: x.volatility.estDays,
                            bp: v.estimate.shockBp,
                          }) + cutSuffix(tv, v.estimate, sourceOf(v.estimate.cutScope, v.market))}
                    </span>
                  </div>
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
