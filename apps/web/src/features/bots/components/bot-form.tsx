"use client";

import { Field, inputClassName, SegmentedControl, Switch } from "@drift/ui";
import { useTranslations } from "next-intl";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

import { useMarketNames, useMarkets } from "@/lib/markets";

import { FIELDS, visible, type AssetRow, type FieldSpec, type FormValues } from "../fields";
import { advancedSummary, fallbackQuote, sectionOf, SECTIONS, type Section } from "../form-layout";
import { unitsOf } from "../preview";

import { AmountLines } from "./amount-lines";
import { ArbAssetPicker, RebalanceAssets } from "./asset-pickers";
import { MarketPicker } from "./market-picker";

// Form tham số bot theo bố cục UI_REVIEW G2/G3 (DEC-68): Market → Amount → Strategy → Risk → Advanced
// settings (đóng mặc định, nhớ trạng thái trong trình duyệt). Lỗi field lấy nguyên văn từ server (zod
// schema của chiến lược). Màn Edit truyền `lockedReason` để ẩn field bị khoá.

const ADVANCED_OPEN_KEY = "drift.bots.advancedOpen";

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(ADVANCED_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}
function writeOpen(open: boolean) {
  try {
    window.localStorage.setItem(ADVANCED_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Trình duyệt chặn storage: chỉ mất phần nhớ trạng thái.
  }
}

export function BotForm({
  strategy,
  values,
  onChange,
  errors,
  lockedReason,
  disabled,
  sources,
  placeholders,
  hints,
  advancedExtra,
  focusKey,
  preview,
}: {
  strategy: keyof typeof FIELDS;
  values: FormValues;
  onChange: (next: FormValues) => void;
  errors: Record<string, string[]>;
  /** Có giá trị ở màn Edit: field `locked` không hiện. */
  lockedReason?: string;
  disabled?: boolean;
  /** Chip nguồn giá trị từng field: "ai" (AI điền) hoặc "edited" (người dùng sửa giá trị AI). */
  sources?: Record<string, "ai" | "edited">;
  /** Placeholder sau khi Clear parameters: "e.g. <giá trị AI>". */
  placeholders?: Record<string, string>;
  /** Gợi ý động thay cho gợi ý tĩnh (ví dụ "9.3% below last price"). */
  hints?: Record<string, string>;
  /** Phần thêm ở cuối Advanced settings (ô Bot name ở màn Create). */
  advancedExtra?: ReactNode;
  /** Đổi `n` → cuộn tới và focus field `key` (ví dụ ô vốn khi AI parameters cần vốn, UI_REVIEW E7). */
  focusKey?: { key: string; n: number } | null;
  /** Mobile (UI_REVIEW G5): Preview chưa có dữ liệu nằm sau Amount; có dữ liệu thì ngay trước Advanced. */
  preview?: { node: ReactNode; at: "amount" | "advanced" } | undefined;
}) {
  const t = useTranslations("createBot");
  const names = useMarketNames();
  const markets = useMarkets();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(readOpen());
  }, []);

  const set = (key: string, v: string | boolean | AssetRow[]) => {
    const spec = FIELDS[strategy].find((f) => f.key === key);
    const cleared = Object.fromEntries(
      (v === values[key] ? [] : (spec?.clears ?? [])).map((k) => [k, ""]),
    );
    onChange({ ...values, ...cleared, [key]: v });
  };

  const shown = FIELDS[strategy].filter(
    (f) =>
      f.hidden !== true && visible(f, values) && (lockedReason === undefined || f.locked !== true),
  );
  const advanced = shown.filter((f) => sectionOf(f) === "advanced");
  const advancedKeys = advanced.map((f) => f.key).join(",");

  // Lỗi từ server nằm trong Advanced → mở section; rồi focus field lỗi đầu tiên (UI_REVIEW G2).
  const errorKeys = Object.keys(errors).join(",");
  useEffect(() => {
    if (errorKeys === "") return;
    const adv = new Set(advancedKeys.split(","));
    if (errorKeys.split(",").some((k) => adv.has(k))) setOpen(true);
    requestAnimationFrame(() => {
      root.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  }, [errorKeys, advancedKeys]);

  useEffect(() => {
    if (focusKey === undefined || focusKey === null) return;
    if (advancedKeys.split(",").includes(focusKey.key)) setOpen(true);
    requestAnimationFrame(() => {
      const el = root.current?.querySelector<HTMLElement>(
        `[data-field="${focusKey.key}"] input, [data-field="${focusKey.key}"] button`,
      );
      el?.scrollIntoView({ block: "center" });
      el?.focus({ preventScroll: true });
    });
  }, [focusKey, advancedKeys]);

  const noMarketQuote = fallbackQuote(strategy, values, markets.data?.items ?? []);
  const unitOf = (f: FieldSpec): string | undefined => {
    if (f.type.kind !== "decimal" && f.type.kind !== "int") return undefined;
    const u = f.type.unit;
    if (u === undefined) return undefined;
    if (u !== "quote" && u !== "base") return u;
    const m = values.market ?? values.perpMarket;
    const units = unitsOf(typeof m === "string" ? m : "");
    if (units === null) return u === "quote" ? noMarketQuote : undefined;
    return names.asset(u === "quote" ? units.quote : units.base);
  };

  const renderField = (f: FieldSpec): ReactNode => {
    const labelKey = f.label ?? f.key;
    // Field hiện theo điều kiện `when` là bắt buộc khi đã hiện (UI_REVIEW G4).
    const label = `${t(`fields.${labelKey}.label`)}${f.optional === true && f.when === undefined ? ` ${t("optional")}` : ""}`;
    const hint = hints?.[f.key] ?? t(`fields.${labelKey}.hint`);
    const error = errors[f.key]?.[0];
    const unit = unitOf(f);
    const v = values[f.key];
    const src = sources?.[f.key];
    const common = {
      label,
      ...(src === undefined
        ? {}
        : {
            source: {
              tone: src,
              label: src === "ai" ? t("ai.chipAi") : t("ai.chipEdited"),
            },
          }),
      ...(hint === "" ? {} : { hint }),
      ...(error === undefined ? {} : { error }),
      ...(unit === undefined ? {} : { unit }),
    };
    if (f.type.kind === "enum") {
      const { optionsKey, options } = f.type;
      return (
        <div className="flex flex-col gap-1.5">
          <span aria-hidden="true" className="text-sm font-semibold text-ink">
            {label}
          </span>
          <SegmentedControl
            fullWidth
            label={label}
            options={options.map((o) => ({
              value: o,
              label: t(`options.${optionsKey}.${o}`),
            }))}
            value={typeof v === "string" ? v : (options[0] ?? "")}
            onValueChange={(next) => {
              set(f.key, next);
            }}
            {...(disabled === true ? { disabled: true } : {})}
          />
          {hint === "" ? null : <p className="m-0 text-xs text-muted">{hint}</p>}
          {error === undefined ? null : <p className="mt-1 text-sm text-neg-ink">⚠ {error}</p>}
        </div>
      );
    }
    if (f.type.kind === "bool") {
      return (
        <Switch
          label={label}
          checked={v === true}
          onCheckedChange={(next) => {
            set(f.key, next);
          }}
          {...(disabled === true ? { disabled: true } : {})}
        />
      );
    }
    if (f.type.kind === "assets") {
      const quote = values.quoteAsset;
      return (
        <RebalanceAssets
          rows={Array.isArray(v) ? v : []}
          quoteAsset={typeof quote === "string" ? quote : ""}
          disabled={disabled}
          label={t(`fields.${labelKey}.label`)}
          hint={hint}
          error={error}
          onChange={(rows) => {
            set(f.key, rows);
          }}
        />
      );
    }
    if (f.type.kind === "arbAsset") {
      // Lỗi của hai market ẩn hiện dưới ô Asset.
      const arbError = error ?? errors.spotMarket?.[0] ?? errors.perpMarket?.[0];
      return (
        <Field {...common} {...(arbError === undefined ? {} : { error: arbError })}>
          {(p) => (
            <ArbAssetPicker
              value={typeof v === "string" ? v : ""}
              disabled={disabled}
              inputProps={p}
              onChange={(next) => {
                onChange({ ...values, ...next });
              }}
            />
          )}
        </Field>
      );
    }
    if (f.type.kind === "market") {
      const fromField = "engineKey" in f.type ? values[f.type.engineKey] : undefined;
      const engine = "engine" in f.type ? f.type.engine : fromField === "perps" ? "perps" : "spot";
      return (
        <Field {...common}>
          {(p) => (
            <MarketPicker
              engine={engine}
              value={typeof v === "string" ? v : ""}
              disabled={disabled}
              inputProps={p}
              onChange={(m) => {
                set(f.key, m);
              }}
            />
          )}
        </Field>
      );
    }
    const kind = f.type.kind;
    const placeholder = f.type.kind === "text" ? (f.type.placeholder ?? "") : "";
    return (
      <Field {...common}>
        {(p) => (
          <input
            {...p}
            className={inputClassName}
            type={kind === "date" ? "date" : kind === "time" ? "time" : "text"}
            inputMode={
              kind === "text" || kind === "date" || kind === "time"
                ? "text"
                : kind === "int"
                  ? "numeric"
                  : "decimal"
            }
            readOnly={f.fixed !== undefined}
            value={typeof v === "string" ? v : ""}
            placeholder={placeholders?.[f.key] ?? placeholder}
            disabled={disabled}
            onChange={(e) => {
              set(f.key, e.target.value);
            }}
          />
        )}
      </Field>
    );
  };

  // Field cùng `row` gộp một hàng; dưới 480 px xuống một cột (UI_REVIEW G5).
  const renderFields = (fields: FieldSpec[]) => {
    const out: ReactNode[] = [];
    for (const f of fields) {
      const row = f.row === undefined ? [f] : fields.filter((x) => x.row === f.row);
      if (row[0] !== f) continue;
      const cell = (x: FieldSpec) => (
        <div
          key={x.key}
          data-field={x.key}
          className={
            row.length === 1
              ? undefined
              : x.width === "wide"
                ? "min-w-0 min-[480px]:flex-[2_1_0]"
                : x.width === "narrow"
                  ? "min-w-0 min-[480px]:flex-[1_1_0]"
                  : "min-w-0 min-[480px]:flex-1"
          }
        >
          {renderField(x)}
        </div>
      );
      out.push(
        row.length === 1 ? (
          cell(f)
        ) : (
          <div key={`row-${f.row ?? ""}`} className="flex flex-col gap-3 min-[480px]:flex-row">
            {row.map(cell)}
          </div>
        ),
      );
    }
    return out;
  };

  const title = (s: Section) => (s === "market" ? t("groups.2") : t(`sections.${s}`));
  const adv = advancedSummary(advanced, values, errors, (key, v) => t(`options.${key}.${v}`));
  const advSources = [
    ...new Set(advanced.map((f) => sources?.[f.key]).filter((x) => x !== undefined)),
  ];
  const summary = [
    ...adv.enums,
    ...(adv.optionalUnset > 0 ? [t("advanced.optionalUnset", { n: adv.optionalUnset })] : []),
  ].join(" · ");

  const previewAfterAmount =
    preview?.at === "amount" && shown.some((f) => sectionOf(f) === "amount");

  return (
    <div ref={root} className="flex flex-col gap-5">
      {SECTIONS.map((s) => {
        const fields = shown.filter((f) => sectionOf(f) === s);
        if (fields.length === 0) return null;
        return (
          <Fragment key={s}>
            <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
              <legend className="mb-3 w-full border-b border-border pb-2 text-[15px] font-extrabold">
                {title(s)}
              </legend>
              {s === "amount" && (strategy === "spot_dca" || strategy === "futures_dca") ? (
                <p className="m-0 text-xs text-ink-2">{t("amount.dcaHint")}</p>
              ) : null}
              <div className="flex flex-col gap-3">{renderFields(fields)}</div>
              {s === "amount" ? <AmountLines strategy={strategy} values={values} /> : null}
            </fieldset>
            {s === "amount" && previewAfterAmount ? preview.node : null}
          </Fragment>
        );
      })}
      {preview !== undefined && !previewAfterAmount ? preview.node : null}
      {advanced.length === 0 && advancedExtra === undefined ? null : (
        <section className="flex flex-col rounded-control border border-border">
          <h3 className="m-0">
            <button
              type="button"
              aria-expanded={open}
              aria-controls="advanced-settings"
              className="flex min-h-tap w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left"
              onClick={() => {
                setOpen(!open);
                writeOpen(!open);
              }}
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2 text-[15px] font-extrabold">
                  {t("advanced.title")}
                  {advSources.map((src) => (
                    <span
                      key={src}
                      className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${src === "ai" ? "bg-accent-tint text-accent-ink" : "bg-surface-2 text-ink-2"}`}
                    >
                      {src === "ai" ? t("ai.chipAi") : t("ai.chipEdited")}
                    </span>
                  ))}
                </span>
                {adv.needValue > 0 ? (
                  <span className="text-xs font-semibold text-neg-ink">
                    {t("advanced.needValue", { n: adv.needValue })}
                  </span>
                ) : summary === "" ? null : (
                  <span className="text-xs font-normal text-muted">{summary}</span>
                )}
              </span>
              <span aria-hidden="true" className="text-muted">
                {open ? "▴" : "▾"}
              </span>
            </button>
          </h3>
          <div id="advanced-settings" hidden={!open} className="flex flex-col gap-3 px-3.5 pb-3.5">
            {renderFields(advanced)}
            {advancedExtra}
          </div>
        </section>
      )}
    </div>
  );
}
