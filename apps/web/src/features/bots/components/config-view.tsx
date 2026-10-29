"use client";

import { useTranslations } from "next-intl";

import { formatAmount, formatDate } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";

import { FIELDS, isLaunched, visible, type FieldSpec } from "../fields";
import { unitsOf } from "../preview";

// Configuration của Trading Agent (UI_REVIEW F2, artboard Agent): giá trị đã định dạng (không JSON), nhãn enum
// giống form Create, đơn vị, tham số tuỳ chọn bỏ trống ghi "Not set". Gộp dòng như artboard: Price range
// (lower – upper), Grid levels "N · spacing".

export interface ConfigRow {
  key: string;
  label: string;
  value: string;
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
    rows.push({ key: f.key, label: label(f), value: format(f, config[f.key]) });
  }
  return rows;
}

export function ConfigList({ rows }: { rows: readonly ConfigRow[] }) {
  return (
    <dl className="m-0 grid gap-x-10 gap-y-2.5 text-sm tabular-nums sm:grid-cols-2">
      {rows.map((r) => (
        <div key={r.key} className="flex min-w-0 justify-between gap-4">
          <dt className="text-ink-2">{r.label}</dt>
          <dd className="m-0 text-right font-bold break-words">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
