"use client";

import { Field, inputClassName, SegmentedControl, Switch } from "@drift/ui";
import { useTranslations } from "next-intl";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

import { useMarketNames, useMarkets } from "@/lib/markets";

import {
  copyKey,
  hintOf,
  howBaseOf,
  labelKeyOf,
  optionalKeyOf,
  optionKeyOf,
  rendered,
} from "../field-copy";
import { FIELDS, visible, type AssetRow, type FieldSpec, type FormValues } from "../fields";
import { advancedSummary, fallbackQuote, sectionOf, SECTIONS, type Section } from "../form-layout";
import { unitsOf } from "../preview";

import { AmountLines } from "./amount-lines";
import { ArbAssetPicker, RebalanceAssets } from "./asset-pickers";
import { HowItWorks } from "./how-it-works";
import { LossCaps } from "./loss-caps";
import { MarketPicker } from "./market-picker";

// Form tham số bot theo bố cục UI_REVIEW G2/G3 (DEC-68): Market → Amount → Strategy → Risk → Advanced
// settings (luôn đóng khi vào form, tự mở khi có lỗi bên trong). Lỗi field lấy nguyên văn từ server (zod
// schema của chiến lược). Màn Edit truyền `lockedReason` để ẩn field bị khoá.

// Class tĩnh cho hàng lưới `rowBreak` (Tailwind không đọc được class ghép động): số cột từ md, độ rộng tiêu đề nhóm.
const GRID_COLS: Record<number, string> = { 2: "md:grid-cols-2", 3: "md:grid-cols-3" };
const SPAN_COLS: Record<number, string> = { 2: "md:col-span-2", 3: "md:col-span-3" };

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
  afterMarket,
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
  /** Mobile (IMP-05): chart nằm ngay dưới ô Market. */
  afterMarket?: ReactNode;
}) {
  const t = useTranslations("createBot");
  const has = (key: string) => t.has(key);
  const names = useMarketNames();
  const markets = useMarkets();
  const root = useRef<HTMLDivElement>(null);
  // Luôn đóng mỗi lần vào form (người dùng yêu cầu 2026-11-17); chỉ tự mở khi có lỗi bên trong.
  const [open, setOpen] = useState(false);

  const set = (key: string, v: string | boolean | AssetRow[]) => {
    const spec = FIELDS[strategy].find((f) => f.key === key);
    const cleared = Object.fromEntries(
      (v === values[key] ? [] : (spec?.clears ?? [])).map((k) => [k, ""]),
    );
    onChange({ ...values, ...cleared, [key]: v });
  };

  const shown = FIELDS[strategy].filter(
    (f) =>
      f.hidden !== true &&
      visible(f, values) &&
      rendered(f, values, errors) &&
      (lockedReason === undefined || f.locked !== true),
  );
  // Field có `slot` vẽ trong khối riêng (Position loss limit trong "How your losses are capped").
  const lossCapFields = shown.filter((f) => f.slot === "lossCaps");
  const advanced = shown.filter((f) => f.slot === undefined && sectionOf(f) === "advanced");
  // Khối "How your losses are capped" nằm trong Advanced, ngay trước field có `blockBefore` (DEC-295).
  const capsAt = advanced.findIndex((f) => f.blockBefore === "lossCaps");
  const advancedKeys = [...advanced, ...(capsAt === -1 ? [] : lossCapFields)]
    .map((f) => f.key)
    .join(",");

  // Lỗi nằm trong Advanced → mở section; rồi cuộn tới và focus field lỗi đầu tiên (UI_REVIEW G2). Mỗi lần Save /
  // Start lỗi lại, lỗi cũ bị xoá lúc gửi nên effect chạy lại và mở lại section nếu người dùng đã đóng.
  const errorKeys = Object.keys(errors).join(",");
  useEffect(() => {
    if (errorKeys === "") return;
    const adv = new Set(advancedKeys.split(","));
    if (errorKeys.split(",").some((k) => adv.has(k))) setOpen(true);
    requestAnimationFrame(() => {
      const el = root.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      el?.scrollIntoView({ block: "center" });
      el?.focus({ preventScroll: true });
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
  const marketUnits = () => {
    const m = values.market ?? values.perpMarket;
    return unitsOf(typeof m === "string" ? m : "");
  };
  const unitOf = (f: FieldSpec): string | undefined => {
    if (f.type.kind !== "decimal" && f.type.kind !== "int") return undefined;
    // Đơn vị riêng của chiến lược ("orders", "steps back" của Market Making).
    const own = optionalKeyOf(strategy, f, "unit", has);
    if (own !== null) return t(own);
    const u = f.type.unit;
    if (u === undefined) return undefined;
    if (u !== "quote" && u !== "base") return u;
    const units = marketUnits();
    if (units === null) return u === "quote" ? noMarketQuote : undefined;
    return names.asset(u === "quote" ? units.quote : units.base);
  };

  /** `place`: class xếp ô trong hàng lưới (`rowBreak`), gắn lên khung Field. */
  const renderField = (f: FieldSpec, place?: string): ReactNode => {
    const labelText = t(labelKeyOf(strategy, f, has));
    // Field hiện theo điều kiện `when` là bắt buộc khi đã hiện (UI_REVIEW G4).
    const fullLabel = `${labelText}${f.optional === true && f.when === undefined ? ` ${t("optional")}` : ""}`;
    // Trong nhóm (`cluster`): nhãn hiện ngắn ("Min"), trình đọc màn hình đọc nhãn đầy đủ ("Order size, min").
    const shortKey = f.cluster === undefined ? null : copyKey(strategy, f, "short", has);
    const label = shortKey !== null && has(shortKey) ? t(shortKey) : fullLabel;
    const srLabel = label === fullLabel ? undefined : fullLabel;
    const base = marketUnits()?.base;
    const h = hintOf(strategy, f, values, has, base === undefined ? null : names.asset(base));
    const hint = hints?.[f.key] ?? t(h.key, h.params);
    const ownPlaceholder = optionalKeyOf(strategy, f, "placeholder", has);
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
      ...(place === undefined ? {} : { className: place }),
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
              label: t(optionKeyOf(strategy, f, optionsKey, o, has)),
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
      const sw = (
        <Switch
          label={label}
          checked={v === true}
          onCheckedChange={(next) => {
            set(f.key, next);
          }}
          {...(hint === "" ? {} : { description: hint })}
          {...(f.beta === true ? { badge: t("beta") } : {})}
          {...(disabled === true ? { disabled: true } : {})}
        />
      );
      if (f.beta !== true || error === undefined) return sw;
      return (
        <div className="flex flex-col gap-1">
          {sw}
          <p className="m-0 text-sm text-neg-ink">⚠ {error}</p>
        </div>
      );
    }
    if (f.type.kind === "assets") {
      const quote = values.quoteAsset;
      return (
        <RebalanceAssets
          rows={Array.isArray(v) ? v : []}
          quoteAsset={typeof quote === "string" ? quote : ""}
          disabled={disabled}
          label={labelText}
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
    const placeholder =
      ownPlaceholder !== null
        ? t(ownPlaceholder)
        : f.type.kind === "text"
          ? (f.type.placeholder ?? "")
          : "";
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
            {...(srLabel === undefined ? {} : { "aria-label": srLabel })}
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

  // "How it works" dưới cả hàng (không chen giữa hai ô cùng hàng), DEC-146.
  const howsOf = (row: FieldSpec[]): ReactNode[] =>
    row.flatMap((x) => {
      const howKey = howBaseOf(strategy, x, has);
      return howKey === null
        ? []
        : [
            <HowItWorks
              key={`how-${x.key}`}
              howKey={howKey}
              {...(row.length === 1 ? {} : { title: t(labelKeyOf(strategy, x, has)) })}
            />,
          ];
    });

  // Hàng `rowBreak: "md"` (DEC-295): lưới; từ md mỗi field một cột và nhãn / ô nhập / gợi ý / lỗi
  // của các ô thẳng hàng nhau (subgrid 4 dòng). Dưới md xuống một cột, trừ nhóm `cluster` (Min · Max) vẫn nằm cạnh
  // nhau; field ngoài nhóm xuống dưới cả nhóm.
  const gridRow = (row: FieldSpec[]): ReactNode => {
    const cluster = row[0]?.cluster;
    const members = cluster === undefined ? [] : row.filter((x) => x.cluster === cluster);
    const cell = (x: FieldSpec) => {
      const inCluster = cluster !== undefined && x.cluster === cluster;
      // `row-span-*` dùng shorthand `grid-row` (xoá `row-start`), nên hàng có nhóm đặt cả dòng bắt đầu lẫn số dòng.
      const place = [
        "min-w-0 md:grid md:grid-rows-subgrid",
        cluster === undefined
          ? "md:row-span-4"
          : inCluster
            ? "row-start-2 md:row-[2/span_4]"
            : "col-span-full mt-1.5 md:col-span-1 md:row-[2/span_4] md:mt-0",
      ].join(" ");
      const plain = x.type.kind === "enum" || x.type.kind === "bool" || x.type.kind === "assets";
      return (
        <div key={x.key} data-field={x.key} className="contents">
          {plain ? <div className={place}>{renderField(x)}</div> : renderField(x, place)}
        </div>
      );
    };
    return (
      <div
        key={`row-${row[0]?.row ?? ""}`}
        data-row={row[0]?.row}
        className={`grid gap-x-3 ${members.length === 2 ? "grid-cols-2 gap-y-1.5" : "grid-cols-1 gap-y-3"} ${GRID_COLS[row.length] ?? "md:grid-cols-2"} md:gap-y-1.5`}
      >
        {cluster === undefined ? null : (
          // Nhãn chung của nhóm; ô nhập đã có tên đầy đủ ("Order size, min") nên trình đọc màn hình bỏ qua dòng này.
          <p
            aria-hidden="true"
            className={`m-0 col-span-full text-sm font-semibold text-ink ${SPAN_COLS[members.length] ?? ""}`}
          >
            {t(`clusters.${cluster}`)}
          </p>
        )}
        {row.slice(0, members.length).map(cell)}
        {cluster !== undefined && has(`clusterHints.${cluster}`) ? (
          // Một dòng giải thích chung cho cả nhóm, nằm dưới các ô của nhóm (không lặp hint từng ô).
          <p
            className={`m-0 col-span-full text-xs text-muted md:col-start-1 md:row-start-6 ${SPAN_COLS[members.length] ?? ""}`}
          >
            {t(`clusterHints.${cluster}`)}
          </p>
        ) : null}
        {row.slice(members.length).map(cell)}
      </div>
    );
  };

  // Field cùng `row` gộp một hàng; dưới 480 px xuống một cột (UI_REVIEW G5).
  const renderFields = (fields: FieldSpec[]) => {
    const out: ReactNode[] = [];
    for (const f of fields) {
      const row = f.row === undefined ? [f] : fields.filter((x) => x.row === f.row);
      if (row[0] !== f) continue;
      if (row.length > 1 && f.rowBreak === "md") {
        out.push(gridRow(row));
        out.push(...howsOf(row));
        continue;
      }
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
      out.push(...howsOf(row));
    }
    return out;
  };

  // Tên / dòng giới thiệu section riêng của chiến lược (Market Making: "When to stop").
  const ownSection = (s: Section, leaf: "title" | "intro") => {
    const k = `sectionsByStrategy.${strategy}.${s}.${leaf}`;
    return has(k) ? t(k) : null;
  };
  const title = (s: Section) =>
    ownSection(s, "title") ?? (s === "market" ? t("groups.2") : t(`sections.${s}`));
  const adv = advancedSummary(advanced, values, errors, (key, v) => {
    const f = advanced.find((x) => x.type.kind === "enum" && x.type.optionsKey === key);
    return t(f === undefined ? `options.${key}.${v}` : optionKeyOf(strategy, f, key, v, has));
  });
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
        const fields = shown.filter((f) => f.slot === undefined && sectionOf(f) === s);
        if (fields.length === 0) return null;
        const intro = ownSection(s, "intro");
        return (
          <Fragment key={s}>
            <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
              <legend className="mb-3 w-full border-b border-border pb-2 text-[15px] font-extrabold">
                {title(s)}
              </legend>
              {intro === null ? null : <p className="m-0 text-xs text-ink-2">{intro}</p>}
              {s === "amount" && (strategy === "spot_dca" || strategy === "futures_dca") ? (
                <p className="m-0 text-xs text-ink-2">{t("amount.dcaHint")}</p>
              ) : null}
              <div className="flex flex-col gap-3">{renderFields(fields)}</div>
              {s === "amount" ? <AmountLines strategy={strategy} values={values} /> : null}
            </fieldset>
            {s === "market" ? afterMarket : null}
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
            {capsAt === -1 ? (
              renderFields(advanced)
            ) : (
              <>
                {renderFields(advanced.slice(0, capsAt))}
                <LossCaps values={values}>
                  {lossCapFields.length === 0 ? null : (
                    <div className="flex flex-col gap-3">{renderFields(lossCapFields)}</div>
                  )}
                </LossCaps>
                {renderFields(advanced.slice(capsAt))}
              </>
            )}
            {advancedExtra}
          </div>
        </section>
      )}
    </div>
  );
}
