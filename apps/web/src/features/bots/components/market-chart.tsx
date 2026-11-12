"use client";

import {
  CHART_INTERVALS,
  candleListSchema,
  liquidationMapSchema,
  type CandleList,
  type ChartInterval,
  type LiquidationMap,
  type Strategy,
} from "@drift/shared";
import { EmptyState, ErrorState, Skeleton } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import type {
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
} from "lightweight-charts";
import { useTranslations } from "next-intl";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";

import { api } from "@/lib/api";
import { formatAmount, formatDateTime } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";
import { useMe } from "@/lib/queries";

import { chartLevels, chartModeOf, type ChartLevel } from "../chart-levels";
import type { FormValues } from "../fields";
import { fmtPrice, priceMarketOf } from "../preview";

// Widget chart ở màn Create (IMPROVEMENTS IMP-05, DEC-91, DEC-92; mockup create-bot/Create.dc.html). Nến lấy từ
// SoDEX qua API của DRIFT; mức của bot là đường đứt nét, đổi ngay khi sửa form. Zoom và kéo bằng chuột hoặc
// cảm ứng; click vào chart để copy giá. Tab Liquidation map chỉ hiện khi server có dữ liệu cho market; dữ liệu
// đó chỉ để xem, không đi vào bất kỳ quyết định đặt lệnh nào. Chart lỗi không được làm hỏng form: có error
// boundary bọc ngoài.

type Tab = "price" | "map";
type Candle = CandleList["items"][number];

const W = 640;
const H = 320;
const PLOT_W = 572;
const PAD = 14;
const HEAT_STEPS = 7;

export function MarketChart(props: {
  strategy: Strategy;
  values: FormValues;
  lastPrice: string | null;
  /** Mobile: nằm dưới ô Market, thu gọn được. */
  inline?: boolean;
}) {
  if (chartModeOf(props.strategy) === "none") return null;
  return (
    <ChartBoundary>
      <ChartWidget {...props} />
    </ChartBoundary>
  );
}

class ChartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    // Chart hỏng thì bỏ widget, form vẫn dùng được (IMP-05).
    return this.state.failed ? null : this.props.children;
  }
}

function ChartWidget({
  strategy,
  values,
  lastPrice,
  inline = false,
}: {
  strategy: Strategy;
  values: FormValues;
  lastPrice: string | null;
  inline?: boolean;
}) {
  const t = useTranslations("createBot.chart");
  const names = useMarketNames();
  const me = useMe();
  const [interval, setTf] = useState<ChartInterval>("1h");
  const [tab, setTab] = useState<Tab>("price");
  const [open, setOpen] = useState(true);
  const market = priceMarketOf(strategy, values);
  const engine = market === null ? undefined : names.info(market)?.engine;
  const mode = chartModeOf(strategy);

  const candles = useQuery({
    queryKey: ["candles", market, engine, interval],
    queryFn: () =>
      api(
        "GET",
        `/api/v1/markets/${encodeURIComponent(market ?? "")}/candles?engine=${engine ?? ""}&interval=${interval}`,
        candleListSchema,
      ),
    enabled: market !== null && engine !== undefined,
    refetchInterval: 60_000,
    retry: false,
  });
  const liq = useQuery({
    queryKey: ["liquidations", market, interval],
    queryFn: () =>
      api(
        "GET",
        `/api/v1/markets/${encodeURIComponent(market ?? "")}/liquidations?interval=${interval}`,
        liquidationMapSchema,
      ),
    enabled: market !== null && mode === "price_and_map",
    staleTime: 5 * 60_000,
    retry: false,
  });

  const map = liq.data?.available === true && liq.data.bands.length > 0 ? liq.data : null;
  const shownTab: Tab = map === null ? "price" : tab;
  const digits = market === null ? null : names.priceDigits(market);
  const price = (p: string) => formatAmount(p, digits)?.text ?? fmtPrice(p);
  const levels = chartLevels(strategy, values, lastPrice).map((l) => ({
    ...l,
    text: t(`levels.${l.key}`, { ...l.params, price: price(l.price) }),
  }));
  const intervalLabel = t(`intervals.${interval}`);
  const title =
    market === null
      ? t("title", { market: "—", interval: intervalLabel })
      : t("title", { market: names.market(market), interval: intervalLabel });

  const body = (() => {
    if (market === null) return <EmptyState title={t("empty")} />;
    if (candles.isError)
      return (
        <ErrorState
          title={t("error")}
          retryLabel={t("retry")}
          onRetry={() => {
            void candles.refetch();
          }}
        />
      );
    if (candles.data === undefined)
      return (
        <div role="status" aria-label={t("loading")}>
          <Skeleton className="h-[320px] w-full" />
        </div>
      );
    if (candles.data.items.length === 0) return <EmptyState title={t("noCandles")} />;
    const view = `${market}:${interval}:${shownTab}`;
    if (shownTab === "map" && map !== null)
      return (
        <MapTab
          key={view}
          candles={candles.data.items}
          levels={levels}
          map={map}
          digits={digits}
          timeZone={me.data?.timezone}
        />
      );
    return (
      <>
        <LiveChart
          key={view}
          candles={candles.data.items}
          levels={levels}
          label={t("priceAria")}
          digits={digits}
          fallback={
            <SvgCandles
              candles={candles.data.items}
              levels={levels}
              label={t("priceAria")}
              variant="price"
            />
          }
        />
        <p className="m-0 text-xs text-muted">{t("priceNote")}</p>
        {strategy === "spot_dca" || strategy === "futures_dca" ? (
          <p className="m-0 text-xs text-muted">{t("dcaNote")}</p>
        ) : null}
      </>
    );
  })();

  return (
    <section
      aria-labelledby="chart-title"
      data-testid="market-chart"
      className={`flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface ${inline ? "p-3.5" : "p-[18px]"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="chart-title" className="m-0 text-[17px] font-extrabold">
          {title}
        </h2>
        {inline ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls="chart-body"
            className="min-h-tap px-2 text-[13px] font-bold text-accent-ink"
            onClick={() => {
              setOpen(!open);
            }}
          >
            {open ? t("hide") : t("show")}
          </button>
        ) : null}
      </div>
      {open ? (
        <div id="chart-body" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              role="group"
              aria-label={t("timeframe")}
              className="flex gap-1 rounded-control bg-surface-2 p-1"
            >
              {CHART_INTERVALS.map((i) => (
                <button
                  key={i}
                  type="button"
                  aria-pressed={interval === i}
                  className={`min-h-9 rounded-[9px] px-3 text-[13px] font-bold ${interval === i ? "bg-surface text-ink shadow-sm" : "text-ink-2"}`}
                  onClick={() => {
                    setTf(i);
                  }}
                >
                  {t(`intervals.${i}`)}
                </button>
              ))}
            </div>
            {map === null ? null : (
              <div
                role="tablist"
                aria-label={t("tabs")}
                className="flex gap-1 rounded-control bg-surface-2 p-1"
              >
                {(["map", "price"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={shownTab === k}
                    className={`min-h-9 rounded-[9px] px-3.5 text-[13px] font-bold ${shownTab === k ? "bg-surface text-ink shadow-sm" : "text-ink-2"}`}
                    onClick={() => {
                      setTab(k);
                    }}
                  >
                    {t(k)}
                  </button>
                ))}
              </div>
            )}
          </div>
          {body}
        </div>
      ) : null}
    </section>
  );
}

type Level = ChartLevel & { text: string };

const cssVar = (name: string, fallback: string): string => {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === "" ? fallback : v;
};

export interface HeatBand {
  price: number;
  value: number;
}

/** Độ dày dải theo giá (0.2%, cùng cỡ bước gộp ở server): dữ liệu thưa không được làm dải to ra. */
const BAND_SPAN = 0.002;

/** Vẽ dải thanh lý dưới nến, theo đúng thang giá của chart nên zoom và kéo đi cùng nến. */
class HeatBandsPrimitive implements ISeriesPrimitive {
  #series: ISeriesApi<"Candlestick"> | null = null;
  readonly #view: IPrimitivePaneView;

  constructor(bands: readonly HeatBand[]) {
    const max = Math.max(...bands.map((b) => b.value), 0);
    const colors = Array.from({ length: HEAT_STEPS + 1 }, (_, i) =>
      cssVar(`--heat-${String(i)}`, "#fde725"),
    );
    this.#view = {
      zOrder: () => "bottom",
      renderer: () => ({
        draw: (target) => {
          target.useBitmapCoordinateSpace(({ context, bitmapSize, verticalPixelRatio: r }) => {
            const series = this.#series;
            if (series === null) return;
            for (const b of bands) {
              const y = series.priceToCoordinate(b.price);
              if (y === null) continue;
              const next = series.priceToCoordinate(b.price * (1 + BAND_SPAN));
              const half = Math.max(next === null ? 2 : Math.abs(y - next) / 2, 1);
              const w = (b.value / max) * bitmapSize.width;
              context.fillStyle = colors[heatStep(b.value, max)] ?? "#fde725";
              context.fillRect(
                bitmapSize.width - w,
                Math.round((y - half) * r),
                w,
                Math.max(Math.round(half * 2 * r), 1),
              );
            }
          });
        },
      }),
    };
  }

  attached({ series }: SeriesAttachedParameter): void {
    this.#series = series as ISeriesApi<"Candlestick">;
  }

  detached(): void {
    this.#series = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.#view];
  }
}

/** Chữ số của giá khi copy: theo tick của market, chưa biết tick thì để 2 chữ số. */
export const pickedPrice = (price: number, digits: number | null): string =>
  price.toFixed(digits ?? 2);

/** TradingView Lightweight Charts (DEC-91); không tải được thì hiện `fallback` (SVG, không zoom). */
function LiveChart({
  candles,
  levels,
  label,
  digits,
  bands,
  fallback,
}: {
  candles: Candle[];
  levels: Level[];
  label: string;
  digits: number | null;
  /** Có thì vẽ kiểu bản đồ thanh lý (nền tối + dải nhiệt). */
  bands?: readonly HeatBand[];
  fallback: ReactNode;
}) {
  const t = useTranslations("createBot.chart");
  const box = useRef<HTMLDivElement>(null);
  const handle = useRef<{
    setCandles: (c: Candle[]) => void;
    setLevels: (l: Level[]) => void;
    reset: () => void;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState<{ price: string; ok: boolean } | null>(null);
  const latest = useRef({ candles, levels, bands, digits });
  latest.current = { candles, levels, bands, digits };

  useEffect(() => {
    let disposed = false;
    let remove: (() => void) | null = null;
    import("lightweight-charts")
      .then((lc) => {
        if (disposed || box.current === null) return;
        const heat = latest.current.bands;
        const dark = heat !== undefined;
        const chart = lc.createChart(box.current, {
          autoSize: true,
          layout: {
            background: {
              color: dark ? cssVar("--heat-bg", "#440154") : cssVar("--chart-bg", "#f7f9ff"),
            },
            textColor: dark ? cssVar("--surface", "#ffffff") : cssVar("--muted", "#5f6684"),
            // Ghi công TradingView theo giấy phép Apache-2.0 / NOTICE của thư viện.
            attributionLogo: true,
          },
          grid: {
            vertLines: { visible: false },
            horzLines: { visible: !dark, color: cssVar("--border", "#e3e7f5") },
          },
          // Crosshair theo đúng con trỏ, không dính vào giá nến, để chọn được giá bất kỳ.
          crosshair: { mode: lc.CrosshairMode.Normal },
          timeScale: { timeVisible: true },
          // Vuốt dọc vẫn cuộn trang trên điện thoại.
          handleScroll: { vertTouchDrag: false },
        });
        const up = cssVar("--candle-up", "#26c281");
        const down = cssVar("--candle-down", "#f0535b");
        const digits = latest.current.digits;
        const series = chart.addSeries(lc.CandlestickSeries, {
          upColor: up,
          downColor: down,
          wickUpColor: up,
          wickDownColor: down,
          borderVisible: false,
          ...(digits === null
            ? {}
            : { priceFormat: { type: "price", precision: digits, minMove: 10 ** -digits } }),
        });
        if (dark) series.attachPrimitive(new HeatBandsPrimitive(heat));
        const lineColor = dark ? cssVar("--surface", "#ffffff") : cssVar("--accent", "#2e62e8");
        let lines: ReturnType<typeof series.createPriceLine>[] = [];
        chart.subscribeClick((param) => {
          if (param.point === undefined) return;
          const p = series.coordinateToPrice(param.point.y);
          if (p === null) return;
          const price = pickedPrice(p, latest.current.digits);
          navigator.clipboard
            .writeText(price)
            .then(() => {
              setCopied({ price, ok: true });
            })
            .catch(() => {
              setCopied({ price, ok: false });
            });
        });
        handle.current = {
          setCandles: (c) => {
            series.setData(
              c.map((x) => ({
                time: Math.floor(x.t / 1000) as import("lightweight-charts").UTCTimestamp,
                open: Number(x.o),
                high: Number(x.h),
                low: Number(x.l),
                close: Number(x.c),
              })),
            );
          },
          setLevels: (l) => {
            for (const line of lines) series.removePriceLine(line);
            lines = l.map((x) =>
              series.createPriceLine({
                price: Number(x.price),
                color: lineColor,
                lineWidth: 1,
                lineStyle: lc.LineStyle.Dashed,
                axisLabelVisible: true,
                title: x.text,
              }),
            );
          },
          reset: () => {
            chart.timeScale().fitContent();
            chart.priceScale("right").applyOptions({ autoScale: true });
          },
        };
        handle.current.setCandles(latest.current.candles);
        handle.current.setLevels(latest.current.levels);
        // Chỉ fit lần đầu: dữ liệu làm mới mỗi phút không được làm mất mức zoom của người dùng.
        chart.timeScale().fitContent();
        remove = () => {
          chart.remove();
        };
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      handle.current = null;
      remove?.();
    };
  }, []);

  useEffect(() => {
    handle.current?.setCandles(candles);
  }, [candles]);
  const levelKey = JSON.stringify(levels);
  useEffect(() => {
    handle.current?.setLevels(latest.current.levels);
  }, [levelKey]);

  if (failed) return <>{fallback}</>;
  return (
    <div className="relative min-w-0 flex-1">
      <div
        ref={box}
        role="img"
        aria-label={label}
        className="h-[380px] w-full cursor-crosshair overflow-hidden rounded-[12px]"
      />
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="m-0 text-xs text-muted">
          {copied === null
            ? t("chartHint")
            : copied.ok
              ? t("copied", { price: copied.price })
              : t("copyFailed", { price: copied.price })}
        </p>
        <button
          type="button"
          className="min-h-tap px-2 text-[13px] font-bold text-accent-ink"
          onClick={() => {
            handle.current?.reset();
          }}
        >
          {t("resetZoom")}
        </button>
      </div>
      {/* Bảng mức cho người dùng trình đọc màn hình: canvas không đọc được. */}
      <ul className="sr-only">
        {levels.map((l) => (
          <li key={`${l.key}-${l.text}`}>{l.text}</li>
        ))}
      </ul>
    </div>
  );
}

interface Scale {
  y: (p: number) => number;
  min: number;
  max: number;
}

export function priceScale(candles: Candle[], extra: number[]): Scale {
  const all = [
    ...candles.flatMap((c) => [Number(c.h), Number(c.l)]),
    ...extra.filter((x) => Number.isFinite(x) && x > 0),
  ];
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (!(max > min)) {
    min = min * 0.99;
    max = max * 1.01 || 1;
  }
  return { min, max, y: (p) => PAD + ((max - p) / (max - min)) * (H - 2 * PAD) };
}

function ticksOf(s: Scale, n = 5): number[] {
  return Array.from({ length: n }, (_, i) => s.min + ((s.max - s.min) * i) / (n - 1));
}

function SvgCandles({
  candles,
  levels,
  label,
  variant,
  children,
}: {
  candles: Candle[];
  levels: Level[];
  label: string;
  variant: "price" | "map";
  /** Lớp nền (dải thanh lý) vẽ dưới nến. */
  children?: (s: Scale) => ReactNode;
}) {
  const s = priceScale(
    candles,
    levels.map((l) => Number(l.price)),
  );
  const slot = PLOT_W / Math.max(candles.length, 1);
  const map = variant === "map";
  const lineColor = map ? "var(--surface)" : "var(--accent)";
  const textColor = map ? "var(--surface)" : "var(--accent-ink)";
  return (
    <svg
      viewBox={`0 0 ${String(W)} ${String(H)}`}
      role="img"
      aria-label={label}
      className={`block h-auto w-full min-w-0 flex-1 rounded-[12px] ${map ? "bg-heat-bg" : "bg-chart-bg"}`}
    >
      {children?.(s)}
      {ticksOf(s).map((p) => (
        <g key={p}>
          {map ? null : (
            <line
              x1={0}
              x2={PLOT_W}
              y1={s.y(p)}
              y2={s.y(p)}
              stroke="var(--border)"
              strokeWidth={1}
            />
          )}
          <text
            x={W - 6}
            y={s.y(p) + 4}
            textAnchor="end"
            fontSize={11}
            fill={map ? "var(--surface)" : "var(--muted)"}
          >
            {fmtPrice(String(p))}
          </text>
        </g>
      ))}
      {candles.map((c, i) => {
        const o = Number(c.o);
        const cl = Number(c.c);
        const color = cl >= o ? "var(--candle-up)" : "var(--candle-down)";
        const x = i * slot + slot / 2;
        const top = s.y(Math.max(o, cl));
        return (
          <g key={c.t}>
            <line
              x1={x}
              x2={x}
              y1={s.y(Number(c.h))}
              y2={s.y(Number(c.l))}
              stroke={color}
              strokeWidth={1}
            />
            <rect
              x={x - Math.max(slot * 0.35, 0.5)}
              y={top}
              width={Math.max(slot * 0.7, 1)}
              height={Math.max(s.y(Math.min(o, cl)) - top, 1)}
              fill={color}
            />
          </g>
        );
      })}
      {levels.map((l) => {
        const y = s.y(Number(l.price));
        return (
          <g key={`${l.key}-${l.text}`}>
            <line
              x1={0}
              x2={PLOT_W}
              y1={y}
              y2={y}
              stroke={lineColor}
              strokeWidth={1}
              strokeDasharray="5 4"
            />
            <text x={4} y={y - 4} fontSize={11} fontWeight={700} fill={textColor}>
              {l.text}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Dải nhiệt: độ sáng theo tỉ lệ value / max, chia 7 bậc màu token `--heat-1..7`. */
export function heatStep(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.min(HEAT_STEPS, Math.max(1, Math.ceil((value / max) * HEAT_STEPS)));
}

function MapTab({
  candles,
  levels,
  map,
  digits,
  timeZone,
}: {
  candles: Candle[];
  levels: Level[];
  map: LiquidationMap;
  digits: number | null;
  timeZone: string | undefined;
}) {
  const t = useTranslations("createBot.chart");
  const bands = map.bands
    .map((b) => ({ price: Number(b.price), value: Number(b.value), raw: b.price }))
    .filter((b) => b.price > 0 && b.value > 0)
    .sort((a, b) => a.price - b.price);
  const max = Math.max(...bands.map((b) => b.value), 0);
  return (
    <>
      <div className="flex items-stretch gap-2">
        <div
          aria-hidden="true"
          className="mb-10 flex flex-col items-center justify-between gap-1 text-[10px] text-muted"
        >
          <span>{t("scaleHigh")}</span>
          <div className="w-3.5 flex-1 rounded-[7px] bg-heat-scale" />
          <span>{t("scaleLow")}</span>
        </div>
        <LiveChart
          candles={candles}
          levels={levels}
          label={t("mapAria")}
          digits={digits}
          bands={bands}
          fallback={
            <SvgCandles candles={candles} levels={levels} label={t("mapAria")} variant="map">
              {(s) =>
                bands
                  .filter((b) => b.price >= s.min && b.price <= s.max)
                  .map((b) => {
                    const half = Math.max(
                      Math.abs(s.y(b.price) - s.y(b.price * (1 + BAND_SPAN))) / 2,
                      1,
                    );
                    const w = (b.value / max) * PLOT_W;
                    const step = heatStep(b.value, max);
                    return (
                      <rect
                        key={b.raw}
                        data-heat={step}
                        x={PLOT_W - w}
                        y={s.y(b.price) - half}
                        width={w}
                        height={half * 2}
                        fill={`var(--heat-${String(step)})`}
                      >
                        <title>{t("mapBand", { price: fmtPrice(b.raw) })}</title>
                      </rect>
                    );
                  })
              }
            </SvgCandles>
          }
        />
      </div>
      <div className="rounded-[12px] bg-surface-2 px-3 py-2.5 text-xs leading-normal text-ink-2">
        <strong>{t("mapLegend")}</strong> {t("mapDisclaimer")}
      </div>
      {map.source === null || map.updatedAt === null ? null : (
        <p className="m-0 text-xs text-muted">
          {t("mapSource", { source: map.source, time: formatDateTime(map.updatedAt, timeZone) })}
        </p>
      )}
    </>
  );
}
