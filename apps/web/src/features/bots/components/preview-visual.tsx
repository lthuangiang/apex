"use client";

import { dec, Decimal } from "@drift/shared";
import { useTranslations } from "next-intl";

import { useMarketNames } from "@/lib/markets";

import type { FIELDS, FormValues } from "../fields";
import { fmt, fmtPrice, unitsOf, type PreviewModel, type Tile } from "../preview";

// Tab Preview của màn Create (artboard Create): hình của chiến lược + hàng ô chỉ số. Số đến từ
// `previewModel` (tính từ giá trị đã nhập và giá SoDEX gần nhất); thiếu dữ liệu thì giữ khung và
// hiện trạng thái trống, không vẽ số giả (quy tắc 1.8).

type Strategy = keyof typeof FIELDS;

const price = fmtPrice;

export function PreviewVisual({
  strategy,
  values,
  model,
}: {
  strategy: Strategy;
  values: FormValues;
  model: PreviewModel | null;
}) {
  const t = useTranslations("createBot");
  if (model === null) {
    return (
      <div
        role="status"
        className="flex min-h-[72px] items-center justify-center rounded-[16px] border border-dashed border-border-input bg-surface-2 px-4 py-3 text-center text-sm text-ink-2"
      >
        {t("visual.previewEmpty")}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3.5">
      {model.kind === "grid" ? <GridChart model={model} /> : null}
      {model.kind === "dca" ? (
        <DcaLadder model={model} values={values} strategy={strategy} />
      ) : null}
      {model.kind === "schedule" ? <Schedule model={model} values={values} /> : null}
      {model.kind === "weights" ? <Weights model={model} /> : null}
      {model.kind === "arb" ? <ArbLegs model={model} values={values} /> : null}
      {model.kind === "twap" ? <TwapSlices slices={model.slices} /> : null}
      <Tiles tiles={model.tiles} />
    </div>
  );
}

function Tiles({ tiles }: { tiles: readonly Tile[] }) {
  const t = useTranslations("createBot.preview.tiles");
  const tm = useTranslations("common.missing");
  const names = useMarketNames();
  const when = (ms: string) =>
    new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(Number(ms)));
  const valueOf = (tile: Tile): string => {
    const p = tile.params;
    if (p === null) return tm("notAvailable");
    if (tile.key === "nextBuy" || tile.key === "ends") return when(p.at ?? "0");
    if (tile.key === "interval") {
      const s = Number(p.seconds ?? "0");
      return s % 60 === 0 ? t("interval.minutes", { n: s / 60 }) : t("interval.seconds", { n: s });
    }
    return t(`${tile.key}.value`, p.unit === undefined ? p : { ...p, unit: names.asset(p.unit) });
  };
  return (
    <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2 tabular-nums">
      {tiles.map((tile) => (
        <div key={tile.key} className="rounded-control border border-border px-3 py-2.5">
          <dt className="text-xs font-semibold text-muted">{t(`${tile.key}.label`)}</dt>
          <dd className="m-0 mt-0.5 text-sm font-extrabold">{valueOf(tile)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Dải grid + các mức + đường Stop (đỏ, nét đứt) + giá gần nhất, nhãn Upper / Lower / Last / Stop. */
function GridChart({ model }: { model: Extract<PreviewModel, { kind: "grid" }> }) {
  const t = useTranslations("createBot.preview.grid");
  const points = [model.lower, model.upper, model.stop, model.stopAbove, model.last]
    .filter((x): x is string => x !== null)
    .map((x) => dec(x));
  const lo = Decimal.min(...points);
  const hi = Decimal.max(...points);
  const pad = hi.sub(lo).mul("0.08");
  const min = lo.sub(pad);
  const max = hi.add(pad);
  const H = 240;
  // Vị trí theo % chiều cao: giá cao ở trên.
  const y = (p: string) => max.sub(p).div(max.sub(min)).mul(100).toNumber();
  const top = y(model.upper);
  const bottom = y(model.lower);
  const labels = [
    { key: "upper", p: model.upper, tone: "bg-accent text-white" },
    { key: "lower", p: model.lower, tone: "bg-accent text-white" },
    ...(model.last === null ? [] : [{ key: "last", p: model.last, tone: "bg-ink text-surface" }]),
    ...(model.stop === null ? [] : [{ key: "stop", p: model.stop, tone: "bg-neg text-white" }]),
    ...(model.stopAbove === null
      ? []
      : [{ key: "stop", p: model.stopAbove, tone: "bg-neg text-white" }]),
  ];
  const aria = t("aria", {
    n: String(model.levels.length),
    lower: price(model.lower),
    upper: price(model.upper),
    last: model.last === null ? "—" : price(model.last),
    stop: model.stop === null ? "—" : price(model.stop),
  });
  return (
    <>
      <div className="relative rounded-[16px] bg-surface-2 py-2 pr-28 pl-2">
        <svg
          viewBox={`0 0 600 ${String(H)}`}
          preserveAspectRatio="none"
          className="block h-60 w-full"
          role="img"
          aria-label={aria}
        >
          <rect
            x="0"
            width="600"
            y={(top / 100) * H}
            height={((bottom - top) / 100) * H}
            className="fill-accent-tint stroke-accent/50"
            strokeWidth="1"
          />
          {model.levels.map((p) => (
            <line
              key={p}
              x1="0"
              x2="600"
              y1={(y(p) / 100) * H}
              y2={(y(p) / 100) * H}
              className="stroke-accent/40"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {[model.stop, model.stopAbove]
            .filter((x): x is string => x !== null)
            .map((p) => (
              <line
                key={`stop-${p}`}
                x1="0"
                x2="600"
                y1={(y(p) / 100) * H}
                y2={(y(p) / 100) * H}
                className="stroke-neg"
                strokeWidth="2"
                strokeDasharray="6 5"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          {model.last === null ? null : (
            <line
              x1="0"
              x2="600"
              y1={(y(model.last) / 100) * H}
              y2={(y(model.last) / 100) * H}
              className="stroke-ink"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {labels.map((l) => (
          <span
            key={`${l.key}-${l.p}`}
            aria-hidden="true"
            style={{ top: `calc(0.5rem + ${String((y(l.p) * 15) / 100)}rem)` }}
            className={`absolute right-2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-[11px] font-bold whitespace-nowrap tabular-nums ${l.tone}`}
          >
            {t(l.key)} {price(l.p)}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-3.5 text-xs font-semibold text-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2.5 w-3.5 rounded-[3px] border border-accent/60 bg-accent-tint"
          />
          {t("range", { n: String(model.levels.length) })}
        </span>
        {model.stop === null && model.stopAbove === null ? null : (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="w-3.5 border-t-2 border-dashed border-neg" />
            {t("stop")}
          </span>
        )}
        {model.last === null ? null : (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-0.5 w-3.5 bg-ink" />
            {t("lastLegend")}
          </span>
        )}
      </div>
    </>
  );
}

function DcaLadder({
  model,
  values,
  strategy,
}: {
  model: Extract<PreviewModel, { kind: "dca" }>;
  values: FormValues;
  strategy: Strategy;
}) {
  const t = useTranslations("createBot.preview.dca");
  const market = typeof values.market === "string" ? values.market : "";
  const names = useMarketNames();
  const unit = names.asset(unitsOf(market)?.quote ?? "");
  const maxSize = Decimal.max(...model.rows.map((r) => dec(r.size)));
  const sign = model.direction === "long" ? "−" : "+";
  return (
    <>
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0 tabular-nums">
        {model.rows.map((r) => (
          <li
            key={r.index}
            className={`flex items-center gap-2.5 rounded-control px-2.5 py-2 ${r.index === 0 ? "bg-accent-tint" : "bg-surface-2"}`}
          >
            <span className="w-[92px] flex-none text-[13px] font-bold">
              {r.index === 0 ? t("base") : t("safety", { n: String(r.index) })}
            </span>
            <div className="h-3 min-w-[60px] flex-1 rounded-full bg-surface">
              <div
                className={`h-3 rounded-full ${r.index === 0 ? "bg-ink" : "bg-accent"}`}
                style={{
                  width: `${String(dec(r.size).div(maxSize).mul(100).toDecimalPlaces(0).toNumber())}%`,
                }}
              />
            </div>
            <span className="w-[112px] flex-none text-right text-[13px] font-bold whitespace-nowrap">
              {fmt(dec(r.size), 2)} {unit}
            </span>
            <span className="w-[110px] flex-none text-right text-xs text-ink-2">
              {r.index === 0 ? "" : `${sign}${fmt(dec(r.offsetPct), 2)}%`}
              {r.price === null ? "" : `${r.index === 0 ? "" : " · "}${price(r.price)}`}
            </span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2.5 text-xs text-ink-2">
        {model.takeProfitPct === null ? null : (
          <span className="rounded-full bg-pos-bg px-2.5 py-1.5 font-bold text-pos">
            {t(strategy === "futures_dca" ? "tpFutures" : "tpSpot", { pct: model.takeProfitPct })}
          </span>
        )}
        <span className="rounded-full bg-surface-2 px-2.5 py-1.5">{t("fillOrder")}</span>
      </div>
    </>
  );
}

function Schedule({
  model,
  values,
}: {
  model: Extract<PreviewModel, { kind: "schedule" }>;
  values: FormValues;
}) {
  const t = useTranslations("createBot.preview.schedule");
  const market = typeof values.market === "string" ? values.market : "";
  const names = useMarketNames();
  const units = unitsOf(market);
  const amount = typeof values.amountPerBuy === "string" ? values.amountPerBuy : "";
  const tz = typeof values.timeZone === "string" ? values.timeZone : "UTC";
  const when = (ms: number) =>
    new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: tz,
    })
      .format(new Date(ms))
      .replace(/, (\d\d:\d\d)$/, " · $1");
  return (
    <ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2 p-0 tabular-nums">
      {model.buys.map((b) => (
        <li key={b.n} className="flex flex-col gap-0.5 rounded-[14px] bg-surface-2 px-3.5 py-3">
          <span className="text-xs font-semibold text-muted">
            {model.total === null
              ? t("buyN", { n: String(b.n) })
              : t("buyOf", { n: String(b.n), total: String(model.total) })}
          </span>
          <strong className="text-[15px]">{when(b.at)}</strong>
          <span className="text-[13px] text-ink-2">
            {t("buyWhat", {
              amount,
              unit: names.asset(units?.quote ?? ""),
              asset: names.asset(units?.base ?? ""),
            })}
          </span>
        </li>
      ))}
    </ol>
  );
}

const WEIGHT_TONES = ["bg-bot-orange", "bg-accent", "bg-bot-teal", "bg-unknown", "bg-pos-dot"];

function Weights({ model }: { model: Extract<PreviewModel, { kind: "weights" }> }) {
  const t = useTranslations("createBot.preview.weights");
  const total = model.rows.reduce((a, r) => a.add(r.weightPct), dec("0"));
  return (
    <>
      <div className="flex h-[22px] overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        {model.rows.map((r, i) => (
          <div
            key={r.asset}
            className={WEIGHT_TONES[i % WEIGHT_TONES.length]}
            style={{
              width: `${String(dec(r.weightPct).div(Decimal.max(total, 100)).mul(100).toNumber())}%`,
            }}
          />
        ))}
      </div>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0 tabular-nums">
        {model.rows.map((r, i) => (
          <li
            key={r.asset}
            className="flex flex-wrap items-center gap-2.5 rounded-control bg-surface-2 px-3 py-2.5"
          >
            <span
              aria-hidden="true"
              className={`size-3 rounded ${WEIGHT_TONES[i % WEIGHT_TONES.length] ?? ""}`}
            />
            <strong className="flex-1 text-sm">{r.asset}</strong>
            <span className="text-[13px]">
              {t("target")} <strong>{fmt(dec(r.weightPct), 2)}%</strong>
            </span>
            {r.band === null ? null : (
              <span className="text-xs text-ink-2">
                {t("band", { lo: fmt(dec(r.band[0]), 2), hi: fmt(dec(r.band[1]), 2) })}
              </span>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function ArbLegs({
  model,
  values,
}: {
  model: Extract<PreviewModel, { kind: "arb" }>;
  values: FormValues;
}) {
  const t = useTranslations("createBot.preview.arb");
  const tm = useTranslations("common.missing");
  const asset = typeof values.asset === "string" ? values.asset : "";
  const spot = typeof values.spotMarket === "string" ? values.spotMarket : "";
  const names = useMarketNames();
  const quote = names.asset(unitsOf(spot)?.quote ?? "");
  const lev = typeof values.leverage === "string" && values.leverage !== "" ? values.leverage : "1";
  const qty = model.qty === null ? tm("notAvailable") : fmt(dec(model.qty), 6);
  const half = `${fmt(dec(model.half), 2)} ${quote}`;
  return (
    <div className="flex flex-wrap items-stretch gap-2.5 tabular-nums">
      <div className="flex flex-[1_1_140px] flex-col gap-1 rounded-[16px] bg-accent-tint p-3.5">
        <span className="text-xs font-bold text-accent-ink">{t("spotLeg")}</span>
        <strong className="text-lg">{model.qty === null ? qty : `+${qty} ${asset}`}</strong>
        <span className="text-xs text-ink-2">{half}</span>
      </div>
      <div aria-hidden="true" className="flex items-center text-[22px] font-extrabold text-muted">
        +
      </div>
      <div className="flex flex-[1_1_140px] flex-col gap-1 rounded-[16px] bg-unknown-bg p-3.5">
        <span className="text-xs font-bold text-unknown">{t("perpLeg", { lev })}</span>
        <strong className="text-lg">{model.qty === null ? qty : `−${qty} ${asset}`}</strong>
        <span className="text-xs text-ink-2">{t("margin", { amount: half })}</span>
      </div>
      <div aria-hidden="true" className="flex items-center text-[22px] font-extrabold text-muted">
        =
      </div>
      <div className="flex flex-[1_1_140px] flex-col gap-1 rounded-[16px] bg-ink p-3.5 text-surface">
        <span className="text-xs font-bold">{t("net")}</span>
        <strong className="text-lg">{t("netValue")}</strong>
        <span className="text-xs">{t("netNote")}</span>
      </div>
    </div>
  );
}

const MAX_BARS = 120;

function TwapSlices({ slices }: { slices: number }) {
  const t = useTranslations("createBot.preview.twap");
  const bars = Math.min(slices, MAX_BARS);
  return (
    <div
      role="img"
      aria-label={t("aria", { n: String(slices) })}
      className="flex h-20 items-end gap-0.5 rounded-[14px] bg-surface-2 p-2"
    >
      {Array.from({ length: bars }, (_, i) => (
        <div key={i} className="h-14 flex-1 rounded-[3px] bg-accent/50" />
      ))}
    </div>
  );
}
