"use client";

import type { ResearchMarket, ResearchMarkets } from "@drift/shared";
import { BottomSheet, Button } from "@drift/ui";
import { useTranslations } from "next-intl";
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

// Chọn tài sản cho News bot version (#306; thiết kế bot-versions-editor.html, bot-versions-picker-mobile.html): chọn
// nhiều market SoDEX đang listed (bản chụp của scheduler, DEC-337), tìm kiếm, nhóm Crypto / Stocks, chip có ×, "Clear
// all", bàn phím ↑ ↓ Enter Esc. Desktop: danh sách thả xuống dưới ô; điện thoại: bottom sheet có nút Done.

export interface MarketsState {
  data: ResearchMarkets | undefined;
  loading: boolean;
  error: boolean;
}

const KINDS = ["crypto", "stock"] as const;

function matches(m: ResearchMarket, q: string): boolean {
  if (q === "") return true;
  const s = q.toLowerCase();
  return (
    m.market.toLowerCase().includes(s) ||
    m.base.toLowerCase().includes(s) ||
    (m.displayName?.toLowerCase().includes(s) ?? false)
  );
}

/** "<b>SOL</b>-USD" như thiết kế: in đậm phần khớp đầu tiên của tên market. */
function Highlight({ text, q }: { text: string; q: string }) {
  const i = q === "" ? -1 : text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <strong>{text.slice(i, i + q.length)}</strong>
      {text.slice(i + q.length)}
    </>
  );
}

export function AssetPicker({
  markets,
  value,
  onChange,
  mode,
  mobile,
  disabled = false,
  onOpenChange,
  describedBy,
  invalid = false,
}: {
  markets: MarketsState;
  value: readonly string[];
  onChange: (next: string[]) => void;
  mode: "only" | "except";
  mobile: boolean;
  /** Chỉ xem (Rules của một version đã lưu). */
  disabled?: boolean;
  /** Danh sách đang mở: sheet chứa nó để Esc chỉ đóng danh sách. */
  onOpenChange?: (open: boolean) => void;
  describedBy?: string | undefined;
  invalid?: boolean;
}) {
  const t = useTranslations("signalAnalysis.research.versions.picker");
  const ts = useTranslations("signalAnalysis.research.versions.sheet");
  const items = markets.data?.items ?? null;
  const unavailable = !disabled && (markets.error || (!markets.loading && items === null));
  const off = disabled || unavailable || items === null;
  const [sheet, setSheet] = useState(false);
  const status = disabled ? null : markets.loading ? (
    <span className="text-xs text-muted">{t("loading")}</span>
  ) : unavailable ? (
    <span role="status" className="text-xs font-semibold text-warn">
      {markets.error ? t("error") : t("missing")}
    </span>
  ) : markets.data?.stale === true ? (
    <span role="status" className="text-xs font-semibold text-warn">
      {t("stale")}
    </span>
  ) : null;
  const toggle = (m: string) => {
    onChange(value.includes(m) ? value.filter((x) => x !== m) : [...value, m]);
  };
  const chips = (
    <Chips
      value={value}
      disabled={disabled}
      onRemove={(m) => {
        onChange(value.filter((x) => x !== m));
      }}
    />
  );

  if (mobile)
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {chips}
          {value.length === 0 ? (
            <span className="text-sm text-muted">{t("picked", { n: 0 })}</span>
          ) : null}
        </div>
        {disabled ? null : (
          <Button
            variant="secondary"
            disabled={off}
            aria-describedby={describedBy}
            onClick={() => {
              setSheet(true);
              onOpenChange?.(true);
            }}
          >
            {t("open")}
          </Button>
        )}
        {status}
        <BottomSheet
          open={sheet}
          onOpenChange={(o) => {
            setSheet(o);
            onOpenChange?.(o);
          }}
          title={mode === "only" ? t("titleOnly") : t("titleExcept")}
          closeLabel={ts("close")}
          footer={
            <Button
              onClick={() => {
                setSheet(false);
                onOpenChange?.(false);
              }}
            >
              {t("done", { n: value.length })}
            </Button>
          }
        >
          <Combo
            items={items ?? []}
            value={value}
            onToggle={toggle}
            onClear={() => {
              onChange([]);
            }}
            alwaysOpen
            chips={chips}
          />
        </BottomSheet>
      </div>
    );

  return (
    <div className="flex flex-col gap-1.5">
      <Combo
        items={items ?? []}
        value={value}
        onToggle={toggle}
        onClear={() => {
          onChange([]);
        }}
        disabled={off}
        chips={chips}
        onOpenChange={onOpenChange}
        describedBy={describedBy}
        invalid={invalid}
      />
      {disabled ? null : <span className="text-xs text-muted">{t("hint")}</span>}
      {status}
    </div>
  );
}

function Chips({
  value,
  disabled,
  onRemove,
}: {
  value: readonly string[];
  disabled: boolean;
  onRemove: (m: string) => void;
}) {
  const t = useTranslations("signalAnalysis.research.versions.picker");
  return (
    <>
      {value.map((m) => (
        <span
          key={m}
          className="inline-flex items-center gap-1 rounded-full bg-accent-tint py-1 pl-3 pr-1 text-sm font-bold text-ink"
        >
          {m}
          {disabled ? null : (
            <button
              type="button"
              aria-label={t("remove", { m })}
              onClick={() => {
                onRemove(m);
              }}
              className="flex size-7 items-center justify-center rounded-full text-accent-ink hover:bg-surface"
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
        </span>
      ))}
    </>
  );
}

function Combo({
  items,
  value,
  onToggle,
  onClear,
  chips,
  disabled = false,
  alwaysOpen = false,
  onOpenChange,
  describedBy,
  invalid = false,
}: {
  items: readonly ResearchMarket[];
  value: readonly string[];
  onToggle: (m: string) => void;
  onClear: () => void;
  chips: ReactNode;
  disabled?: boolean;
  alwaysOpen?: boolean;
  onOpenChange?: ((open: boolean) => void) | undefined;
  describedBy?: string | undefined;
  invalid?: boolean;
}) {
  const t = useTranslations("signalAnalysis.research.versions.picker");
  const id = useId();
  const listId = `${id}-list`;
  const [q, setQ] = useState("");
  const [openState, setOpenState] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const open = alwaysOpen || (openState && !disabled);
  const setOpen = (o: boolean) => {
    if (alwaysOpen) return;
    setOpenState(o);
    onOpenChange?.(o);
  };
  const query = q.trim();
  const groups = useMemo(
    () =>
      KINDS.map((k) => ({
        kind: k,
        items: items.filter((m) => m.kind === k && matches(m, query)),
      })),
    [items, query],
  );
  const flat = groups.flatMap((g) => g.items);
  const cur = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const optId = (m: string) => `${id}-opt-${m}`;

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (flat.length === 0) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive((cur + d + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = flat[cur];
      if (open && m !== undefined) onToggle(m.market);
    } else if (e.key === "Escape") {
      if (!alwaysOpen && open) setOpen(false);
    }
  };

  return (
    <div ref={wrap} className="relative flex flex-col">
      <div
        className={`flex min-h-tap flex-wrap items-center gap-1.5 rounded-control border bg-surface px-2 py-1.5 focus-within:border-accent ${
          invalid ? "border-neg" : "border-border-input"
        } ${disabled ? "bg-surface-2" : ""}`}
      >
        {chips}
        <input
          type="search"
          role="combobox"
          aria-label={t("search")}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          aria-activedescendant={
            open && cur >= 0 && flat[cur] !== undefined ? optId(flat[cur].market) : undefined
          }
          disabled={disabled}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
          }}
          onBlur={(e) => {
            if (!wrap.current?.contains(e.relatedTarget)) setOpen(false);
          }}
          onKeyDown={onKey}
          className="min-h-9 min-w-[8rem] flex-1 border-0 bg-transparent px-1 text-sm text-ink outline-none disabled:cursor-not-allowed"
        />
        {value.length === 0 || disabled ? null : (
          <button
            type="button"
            onClick={onClear}
            className="min-h-9 px-2 text-sm font-bold text-accent-ink underline"
          >
            {t("clear")}
          </button>
        )}
      </div>
      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label={t("list")}
          aria-multiselectable="true"
          className={
            alwaysOpen
              ? "mt-2 flex flex-col gap-0.5"
              : "absolute inset-x-0 top-full z-10 mt-2 flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-tile border border-border bg-surface p-1.5 shadow-card"
          }
        >
          {groups.map((g) => {
            const head = `${id}-g-${g.kind}`;
            return (
              <div key={g.kind} role="presentation" className="flex flex-col gap-0.5">
                <div
                  id={head}
                  role="presentation"
                  className="px-2.5 pb-1 pt-2 text-xs font-bold uppercase tracking-wide text-muted"
                >
                  {t(`groups.${g.kind}`)}
                </div>
                {g.items.length === 0 ? (
                  <div role="presentation" className="px-2.5 py-1.5 text-sm text-muted">
                    {t(`noMatch.${g.kind}`, { q: query })}
                  </div>
                ) : (
                  <div role="group" aria-labelledby={head} className="flex flex-col gap-0.5">
                    {g.items.map((m) => {
                      const i = flat.indexOf(m);
                      const selected = value.includes(m.market);
                      return (
                        <div
                          key={m.market}
                          id={optId(m.market)}
                          role="option"
                          aria-selected={selected}
                          // Focus ở ô tìm (aria-activedescendant); option chỉ nhận chuột / chạm.
                          tabIndex={-1}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setActive(i);
                            onToggle(m.market);
                          }}
                          className={`flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-[10px] px-2.5 text-sm ${
                            i === cur ? "bg-accent-tint" : ""
                          }`}
                        >
                          <span>
                            <Highlight text={m.market} q={query} />
                            {m.displayName === null ? null : ` · ${m.displayName}`}
                          </span>
                          <span className="flex items-center gap-2 text-xs text-muted">
                            {m.status === "TRADING" ? null : (
                              <span className="rounded-full bg-warn-bg px-2 py-0.5 font-bold text-warn">
                                {t("halted")}
                              </span>
                            )}
                            {t("perps")}
                            <span aria-hidden="true" className="w-3 font-bold text-accent-ink">
                              {selected ? "✓" : ""}
                            </span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
