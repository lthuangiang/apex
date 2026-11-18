"use client";

import type { SignalHiddenLead, SignalSuggestion } from "@drift/shared";
import { AlertTriangle, Info, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, type KeyboardEvent, type ReactNode } from "react";

// Thành phần nhỏ dùng chung của Signal Analysis.

export function Section({
  id,
  title,
  sub,
  right,
  children,
  className = "",
}: {
  id: string;
  title: string;
  sub?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface px-3 py-4 md:px-5 ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={id} className="m-0 text-base font-extrabold">
            {title}
          </h2>
          {sub === undefined ? null : <p className="m-0 mt-0.5 text-[12.5px] text-muted">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Kpi({
  label,
  value,
  sub,
  valueTone = "text-ink",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  valueTone?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-tile bg-surface-2 px-3.5 py-3">
      <span className="text-[13px] font-bold text-ink-2">{label}</span>
      <span className={`text-[22px] font-extrabold leading-tight ${valueTone}`}>{value}</span>
      {sub === undefined ? null : <span className="text-xs text-muted">{sub}</span>}
    </div>
  );
}

export function ThinTag() {
  const t = useTranslations("signalAnalysis");
  return (
    <span className="ml-1.5 inline-flex whitespace-nowrap rounded-full bg-warn-bg px-2 py-0.5 text-xs font-bold text-warn">
      {t("thin")}
    </span>
  );
}

export function Na() {
  const t = useTranslations("common.missing");
  return <span className="text-muted">{t("notAvailable")}</span>;
}

const selectCls =
  "min-h-11 max-w-full min-w-36 cursor-pointer rounded-control border border-border-input bg-surface px-3 text-sm font-semibold text-ink";

export function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-[12.5px] font-bold text-ink-2">
      {label}
      <select
        value={value}
        onChange={(e) => {
          const o = options.find((x) => x.value === e.target.value);
          if (o !== undefined) onChange(o.value);
        }}
        className={selectCls}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Nút chọn một trong vài giá trị (radiogroup, phím mũi tên), cao 44 px. */
export function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
  labelId,
}: {
  label?: string;
  labelId?: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const onKey = (e: KeyboardEvent) => {
    const i = options.findIndex((o) => o.value === value);
    const d =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (d === 0) return;
    e.preventDefault();
    const next = options[(i + d + options.length) % options.length];
    if (next === undefined) return;
    onChange(next.value);
    refs.current.get(next.value)?.focus();
  };
  return (
    <div
      role="radiogroup"
      {...(labelId === undefined ? { "aria-label": label } : { "aria-labelledby": labelId })}
      className="inline-flex flex-wrap gap-1 rounded-control bg-surface-2 p-1"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              if (el === null) refs.current.delete(o.value);
              else refs.current.set(o.value, el);
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onKeyDown={onKey}
            onClick={() => {
              onChange(o.value);
            }}
            className={`min-h-11 cursor-pointer rounded-[10px] border-0 px-3 text-sm font-semibold md:min-h-10 ${on ? "bg-surface text-ink shadow-sm" : "bg-transparent text-ink-2"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Tab dạng nút (tablist) cho Breakdown; phím mũi tên đổi tab. */
export function Tabs<T extends string>({
  label,
  value,
  options,
  onChange,
  panelId,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  panelId: string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const onKey = (e: KeyboardEvent) => {
    const i = options.findIndex((o) => o.value === value);
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (d === 0) return;
    e.preventDefault();
    const next = options[(i + d + options.length) % options.length];
    if (next === undefined) return;
    onChange(next.value);
    refs.current.get(next.value)?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex gap-1 overflow-x-auto border-b border-border"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              if (el === null) refs.current.delete(o.value);
              else refs.current.set(o.value, el);
            }}
            type="button"
            role="tab"
            id={`${panelId}-${o.value}`}
            aria-selected={on}
            aria-controls={panelId}
            tabIndex={on ? 0 : -1}
            onKeyDown={onKey}
            onClick={() => {
              onChange(o.value);
            }}
            className={`min-h-11 cursor-pointer whitespace-nowrap border-0 border-b-2 bg-transparent px-3 text-sm font-bold ${on ? "border-accent text-accent-ink" : "border-transparent text-ink-2"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Khung cuộn ngang cho bảng nhiều cột (390 px): focus được bằng bàn phím, có bóng mép. */
export function ScrollTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="region"
      aria-label={label}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- khối cuộn được phải nhận focus để cuộn bằng bàn phím.
      tabIndex={0}
      className="-mx-3 overflow-x-auto bg-[linear-gradient(to_right,var(--surface)_30%,transparent),linear-gradient(to_left,var(--surface)_30%,transparent),linear-gradient(to_right,var(--border),transparent),linear-gradient(to_left,var(--border),transparent)] bg-[length:40px_100%,40px_100%,12px_100%,12px_100%] bg-[position:left,right,left,right] bg-no-repeat [background-attachment:local,local,scroll,scroll] md:mx-0"
    >
      {children}
    </div>
  );
}

export const th =
  "whitespace-nowrap border-b border-border px-2.5 py-2 text-right align-bottom text-xs font-bold text-ink-2 first:text-left";
export const td =
  "whitespace-nowrap border-b border-border px-2.5 py-2.5 text-right text-[13px] first:text-left";

export function ColHead({ main, sub }: { main: string; sub?: string }) {
  return (
    <>
      {main}
      {sub === undefined ? null : (
        <span className="block text-xs font-semibold text-muted">{sub}</span>
      )}
    </>
  );
}

/** Thanh nhỏ quanh 0 cho cột net (trang trí, số luôn ghi cạnh). */
export function DivBar({ v, max, bad }: { v: number | null; max: number; bad: boolean }) {
  if (v === null) return null;
  const w = Math.min(50, (Math.abs(v) / (max || 1)) * 50);
  return (
    <span
      aria-hidden="true"
      className="relative mr-2 inline-block h-2 w-20 rounded-full bg-surface-2 align-middle"
    >
      <span
        className={`absolute top-0 h-2 rounded-full ${bad ? "bg-neg" : "bg-pos-dot"}`}
        style={
          v < 0 ? { right: "50%", width: `${String(w)}%` } : { left: "50%", width: `${String(w)}%` }
        }
      />
    </span>
  );
}

export function StateBox({
  kind,
  what,
  onRetry,
  onClear,
  emptyTitle,
}: {
  kind: "loading" | "error" | "empty";
  what: string;
  onRetry?: () => void;
  onClear?: () => void;
  emptyTitle?: string;
}) {
  const t = useTranslations("signalAnalysis.states");
  if (kind === "loading")
    return (
      <div
        aria-busy="true"
        className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
      >
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} aria-hidden="true" className="h-16 rounded-tile bg-surface-2" />
          ))}
        </div>
        <span aria-hidden="true" className="h-40 rounded-tile bg-surface-2" />
        <p role="status" className="m-0 text-[12.5px] text-muted">
          {t("loading", { what })}
        </p>
      </div>
    );
  if (kind === "error")
    return (
      <div
        role="alert"
        className="flex flex-col items-center gap-2.5 rounded-card border border-border bg-surface px-4 py-10 text-center"
      >
        <strong className="text-base">{t("errorTitle")}</strong>
        <span className="text-sm text-muted">{t("errorBody")}</span>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-control border-0 bg-accent px-[18px] text-sm font-bold text-white"
        >
          <RefreshCw aria-hidden="true" size={16} />
          {t("retry")}
        </button>
      </div>
    );
  return (
    <div className="flex flex-col items-center gap-2 rounded-card border border-border bg-surface px-4 py-12 text-center">
      <strong className="text-base">{emptyTitle}</strong>
      <span className="max-w-md text-sm text-muted">{t("emptyBody")}</span>
      {onClear === undefined ? null : (
        <button
          type="button"
          onClick={onClear}
          className="min-h-11 cursor-pointer rounded-control border border-border-input bg-surface px-4 text-sm font-bold text-ink"
        >
          {t("clear")}
        </button>
      )}
    </div>
  );
}

export function ThinBanner({ n, unit }: { n: number; unit: "fills" | "entries" }) {
  const t = useTranslations("signalAnalysis.states");
  return (
    <div
      role="note"
      className="flex items-start gap-2.5 rounded-tile bg-warn-bg px-4 py-3 text-[13px] text-warn"
    >
      <AlertTriangle aria-hidden="true" size={18} className="mt-0.5 flex-none" />
      <span>
        {t.rich(unit === "fills" ? "thinFills" : "thinEntries", {
          n,
          b: (c) => <b>{c}</b>,
        })}
      </span>
    </div>
  );
}

export function StaleNote({ time }: { time: string }) {
  const t = useTranslations("signalAnalysis.states");
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-tile bg-surface-2 px-4 py-3 text-[13px] text-ink-2"
    >
      <Info aria-hidden="true" size={18} className="mt-0.5 flex-none" />
      <span>{t("stale", { time })}</span>
    </div>
  );
}

/** Danh sách gợi ý (VB / MM): tiêu đề + câu có số + "Based on …" + link tới breakdown + nhãn "Needs approval". */
export function Suggestions({
  id,
  items,
  hidden,
  render,
  hiddenLabel,
  footer,
  unit,
}: {
  id: string;
  items: readonly SignalSuggestion[];
  hidden: readonly SignalHiddenLead[];
  render: (s: SignalSuggestion) => {
    title: string;
    body: ReactNode;
    link: string;
    onLink: () => void;
  };
  hiddenLabel: (h: SignalHiddenLead) => string;
  footer: string;
  unit: "fills" | "entries";
}) {
  const t = useTranslations("signalAnalysis.suggestions");
  return (
    <Section id={id} title={t("title")} sub={t(unit === "fills" ? "subFills" : "subEntries")}>
      {items.length === 0 ? (
        <p className="m-0 text-sm text-ink-2">{t("none")}</p>
      ) : (
        <ol className="m-0 grid list-none gap-3 p-0 md:grid-cols-2">
          {items.map((s, i) => {
            const r = render(s);
            return (
              <li
                key={s.key}
                className="flex flex-col gap-2 rounded-tile border border-border p-3.5"
              >
                <div className="flex items-start gap-2.5">
                  <span
                    aria-hidden="true"
                    className="flex size-6 flex-none items-center justify-center rounded-full bg-accent-tint text-xs font-extrabold text-accent-ink"
                  >
                    {i + 1}
                  </span>
                  <h3 className="m-0 text-[15px] font-extrabold">{r.title}</h3>
                </div>
                <p className="m-0 text-[13px] leading-relaxed text-ink-2">{r.body}</p>
                <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  <span>{t(unit === "fills" ? "basedFills" : "basedEntries", { n: s.n })}</span>
                  <button
                    type="button"
                    onClick={r.onLink}
                    className="min-h-6 cursor-pointer border-0 bg-transparent p-0 text-xs font-bold text-accent-ink underline"
                  >
                    {t("see", { what: r.link })}
                  </button>
                  <span
                    title={t("approvalTip")}
                    className="rounded-full border border-border-input px-2 py-0.5 font-bold text-ink-2"
                  >
                    {t("approval")}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {hidden.length === 0 ? null : (
        <p className="m-0 flex flex-wrap items-center gap-2 rounded-tile bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2">
          <Info aria-hidden="true" size={14} className="flex-none" />
          <span>
            {t.rich("hidden", {
              count: hidden.length,
              list: hidden.map(hiddenLabel).join("; "),
              b: (c) => <b>{c}</b>,
            })}
          </span>
          <ThinTag />
        </p>
      )}
      <p className="m-0 flex items-center gap-1.5 text-xs text-muted">
        <Info aria-hidden="true" size={14} className="flex-none" />
        {footer}
      </p>
    </Section>
  );
}
