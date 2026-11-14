"use client";

import { useTranslations } from "next-intl";

import { formatAmount, formatDate } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";

import { FIELDS, isLaunched, visible, type FieldSpec } from "../fields";
import { unitsOf } from "../preview";

import { HowItWorksInfo } from "./how-it-works";

// Configuration của Trading Agent (UI_REVIEW F2, artboard Agent): giá trị đã định dạng (không JSON), nhãn enum
// giống form Create, đơn vị, tham số tuỳ chọn bỏ trống ghi "Not set". Gộp dòng như artboard: Price range
// (lower – upper), Grid levels "N · spacing".

/** Field bool có mặc định bật trong schema strategy. */
const BOOL_DEFAULT_ON = new Set(["exchangeStop"]);

export interface ConfigRow {
  key: string;
  label: string;
  value: string;
  /** Key câu chữ của field, để hiện "How it works" nếu có (DEC-146). */
  how?: string;
}

export function useConfigRows(strategy: string, market: string, config: Record<string, unknown>) {
  const t = useTranslations("createBot");
  const ta = useTranslations("agent");
  const names = useMarketNames();
  if (!isLaunched(strategy)) return [];
  const units = unitsOf(market);
  const quote = names.asset(units?.quote ?? "");
  const base = names.asset(units?.base ?? "");
  const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

  const format = (f: FieldSpec, v: unknown): string => {
    // Tham số người dùng bỏ trống: "Not set" (UI_REVIEW F2); "Not provided" chỉ cho dữ liệu backend thiếu.
    // Công tắc chưa có trong config cũ lấy mặc định của schema (Smart quoting tắt, Stop loss on SoDEX bật).
    if (f.type.kind === "bool" && v === undefined)
      return BOOL_DEFAULT_ON.has(f.key) ? ta("yes") : ta("no");
    // Copy Trade (DEC-163): nguồn trader là mã ("hyperliquid") và danh sách market là mảng, không phải chữ thường.
    if (f.key === "leaderSource" && typeof v === "string" && v !== "")
      return t.has(`options.leaderSource.${v}`) ? t(`options.leaderSource.${v}`) : v;
    // Đòn bẩy theo market (DEC-226): mỗi market kèm đòn bẩy của nó; dòng Leverage hiện khoảng.
    const perLev =
      strategy === "copy_trade" &&
      typeof config.leverageByMarket === "object" &&
      config.leverageByMarket !== null
        ? (config.leverageByMarket as Record<string, unknown>)
        : null;
    if (f.key === "markets" && Array.isArray(v)) {
      const ms = v
        .filter((m): m is string => typeof m === "string")
        .map((m) => {
          const l = perLev?.[m];
          return typeof l === "number"
            ? t("marketLeverage", { market: names.market(m), lev: l })
            : names.market(m);
        });
      return ms.length === 0 ? ta("notSet") : ms.join(", ");
    }
    if (f.key === "leverage" && perLev !== null) {
      const levs = Object.values(perLev).filter((l): l is number => typeof l === "number");
      if (levs.length > 0) {
        const low = Math.min(...levs);
        const high = Math.max(...levs);
        return low === high ? `${String(low)}×` : t("leverageRange", { low, high });
      }
    }
    if (v === undefined || v === null || v === "") return ta("notSet");
    const k = f.type;
    switch (k.kind) {
      case "enum":
        return t(`options.${k.optionsKey}.${str(v)}`);
      case "bool":
        return v === true ? ta("yes") : ta("no");
      case "market":
        return names.market(str(v));
      case "date":
        return formatDate(str(v));
      case "int":
        return `${formatAmount(str(v), 0)?.text ?? str(v)}${k.unit === "×" ? "×" : k.unit === undefined ? "" : ` ${k.unit}`}`;
      case "decimal": {
        const n = formatAmount(str(v))?.text ?? str(v);
        if (k.unit === "quote") return `${n} ${quote}`.trim();
        if (k.unit === "base") return `${n} ${base}`.trim();
        if (k.unit === "%") return `${n}%`;
        if (k.unit === "×") return `${n}×`;
        return k.unit === undefined ? n : `${n} ${k.unit}`;
      }
      case "text":
      case "time":
      case "arbAsset":
      case "assets":
        return str(v);
    }
  };

  const fields = FIELDS[strategy].filter(
    (f) => f.type.kind !== "assets" && visible(f, config as Record<string, never>),
  );
  const rows: ConfigRow[] = [];
  const label = (f: FieldSpec) => t(`fields.${f.label ?? f.key}.label`);
  for (const f of fields) {
    // Công tắc đã ẩn khỏi form (Close at entry / Pause on fast moves, DEC-241): chỉ hiện khi bot cũ đang bật.
    if (f.hidden === true && f.type.kind === "bool" && config[f.key] !== true) continue;
    if (f.key === "upperPrice" && fields.some((x) => x.key === "lowerPrice")) continue;
    if (f.key === "spacing" && fields.some((x) => x.key === "gridLevels")) continue;
    if (f.key === "lowerPrice" && fields.some((x) => x.key === "upperPrice")) {
      const lo = fields.find((x) => x.key === "lowerPrice");
      const hi = fields.find((x) => x.key === "upperPrice");
      if (lo !== undefined && hi !== undefined)
        rows.push({
          key: "range",
          label: ta("priceRange"),
          value: `${formatAmount(str(config.lowerPrice))?.text ?? ""} – ${format(hi, config.upperPrice)}`,
        });
      continue;
    }
    if (f.key === "gridLevels") {
      const sp = fields.find((x) => x.key === "spacing");
      rows.push({
        key: f.key,
        label: label(f),
        value:
          sp === undefined
            ? format(f, config[f.key])
            : `${format(f, config[f.key])} · ${format(sp, config.spacing)}`,
      });
      continue;
    }
    rows.push({
      key: f.key,
      label: label(f),
      value: format(f, config[f.key]),
      how: f.label ?? f.key,
    });
  }
  return rows;
}

export function ConfigList({ rows }: { rows: readonly ConfigRow[] }) {
  return (
    <dl className="m-0 grid gap-x-10 gap-y-2.5 text-sm tabular-nums sm:grid-cols-2">
      {rows.map((r) => (
        <div key={r.key} className="flex min-w-0 justify-between gap-4">
          <dt className="flex items-center gap-1 text-ink-2">
            {r.label}
            {r.how === undefined ? null : <HowItWorksInfo labelKey={r.how} name={r.label} />}
          </dt>
          <dd className="m-0 text-right font-bold break-words">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
