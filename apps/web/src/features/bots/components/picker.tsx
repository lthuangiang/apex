"use client";

import { BottomSheet, Button, inputClassName } from "@drift/ui";
import { useTranslations } from "next-intl";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";

import { useMediaQuery } from "@/lib/use-media";

import { matchRank, type PickItem } from "../pickers";

// Combobox chọn từ danh sách dài (market, tài sản; UI_REVIEW G6). Tìm theo nhiều khoá, bỏ qua hoa thường
// và các ký tự `/ - _` cùng tiền tố `v` của coin SoDEX; khớp đầu chuỗi xếp trước khớp giữa chuỗi.
// Dưới 768 px mở thành bottom sheet có ô tìm riêng (cỡ chữ 16 px, không bị iOS tự zoom).

const MOBILE = "(max-width: 767px)";
const useIsMobile = () => useMediaQuery(MOBILE);

export function Picker({
  items,
  value,
  onChange,
  disabled,
  inputProps,
  placeholder,
  loading,
  noMatch,
  sheetTitle,
  info,
  selectedLabel,
}: {
  items: readonly PickItem[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
  /** id / aria-* do `Field` cấp cho ô nhập. */
  inputProps: InputHTMLAttributes<HTMLInputElement>;
  placeholder: string;
  loading: boolean;
  /** Câu khi không có kết quả cho chuỗi đã gõ. */
  noMatch: (query: string) => string;
  sheetTitle: string;
  /** Dòng thông tin dưới ô khi đã chọn (chỉ trường có dữ liệu). */
  info?: ReactNode;
  /** Tên hiển thị của giá trị đang chọn; mặc định lấy `label` trong `items`. */
  selectedLabel?: string | undefined;
}) {
  const t = useTranslations("createBot.picker");
  const mobile = useIsMobile();
  const listId = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLInputElement>(null);

  const q = (query ?? "").trim();
  const groups = useMemo(() => {
    if (q === "") {
      const byGroup = new Map<string, PickItem[]>();
      for (const it of items) {
        const g = it.group ?? "";
        byGroup.set(g, [...(byGroup.get(g) ?? []), it]);
      }
      return [...byGroup.entries()];
    }
    const ranked = items
      .map((it, i) => ({ it, i, r: matchRank(it, q) }))
      .filter((x): x is { it: PickItem; i: number; r: 0 | 1 } => x.r !== null)
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.it);
    return [["", ranked] as [string, PickItem[]]];
  }, [items, q]);
  const flat = groups.flatMap(([, g]) => g);
  const showHeaders = groups.length > 1;

  // Dòng đang active luôn trong tầm nhìn khi đi bằng phím.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`#${CSS.escape(`${listId}-${String(active)}`)}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open, listId]);

  const close = () => {
    setOpen(false);
    setQuery(null);
  };
  const pick = (v: string) => {
    onChange(v);
    close();
  };
  const current = selectedLabel ?? items.find((it) => it.value === value)?.label ?? value;

  const keyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && open) {
      const it = flat[active];
      if (it !== undefined && it.disabled !== true) {
        e.preventDefault();
        pick(it.value);
      }
    } else if (e.key === "Escape" && open) {
      // Đóng và trả lại giá trị cũ (chưa đổi gì cho tới khi chọn).
      e.preventDefault();
      close();
    }
  };

  const combo = (id: string | undefined) => ({
    role: "combobox" as const,
    "aria-autocomplete": "list" as const,
    "aria-expanded": open,
    "aria-controls": listId,
    "aria-activedescendant": open && flat[active] ? `${listId}-${String(active)}` : undefined,
    autoComplete: "off",
    id,
  });

  const list = (
    <div
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label={sheetTitle}
      className={
        mobile
          ? "-mx-1 max-h-[60dvh] overflow-y-auto p-1"
          : "absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-control border border-border bg-surface p-1 shadow-float"
      }
    >
      {flat.length === 0 ? (
        <div role="presentation" className="px-3 py-2.5 text-sm text-muted">
          {loading ? t("loading") : q === "" ? t("empty") : noMatch(q)}
        </div>
      ) : (
        groups.map(([g, rows]) => (
          <div key={g} role="group" {...(showHeaders && g !== "" ? { "aria-label": g } : {})}>
            {showHeaders && g !== "" ? (
              <span
                aria-hidden="true"
                className="block px-3 pt-2 pb-1 text-[11px] font-extrabold tracking-[0.06em] text-muted uppercase"
              >
                {g}
              </span>
            ) : null}
            {rows.map((it) => {
              const i = flat.indexOf(it);
              return (
                <div
                  key={it.value}
                  id={`${listId}-${String(i)}`}
                  role="option"
                  aria-selected={it.value === value}
                  aria-disabled={it.disabled === true || undefined}
                  // Focus ở ô nhập (aria-activedescendant); option chỉ nhận chuột / chạm.
                  tabIndex={-1}
                  className={`flex min-h-11 items-center justify-between gap-3 rounded-[10px] px-3 text-sm ${it.disabled === true ? "cursor-not-allowed text-muted" : "cursor-pointer"} ${i === active ? "bg-accent-tint" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (it.disabled !== true) pick(it.value);
                  }}
                  onMouseEnter={() => {
                    setActive(i);
                  }}
                >
                  <span className="font-bold">{it.label}</span>
                  {it.secondary === undefined ? null : (
                    <span className="text-xs text-muted tabular-nums">{it.secondary}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <input
          {...inputProps}
          ref={triggerRef}
          {...(mobile ? {} : combo(inputProps.id))}
          className={`${inputClassName} ${value === "" || disabled === true ? "" : "pr-10"}`}
          placeholder={placeholder}
          value={mobile ? current : (query ?? current)}
          readOnly={mobile}
          disabled={disabled}
          onFocus={() => {
            if (!mobile) setOpen(true);
          }}
          onClick={() => {
            if (mobile) setOpen(true);
          }}
          onBlur={() => {
            if (!mobile) close();
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (mobile && (e.key === "Enter" || e.key === " " || e.key === "ArrowDown")) {
              e.preventDefault();
              setOpen(true);
              return;
            }
            keyDown(e);
          }}
        />
        {value === "" || disabled === true ? null : (
          <button
            type="button"
            aria-label={t("clear")}
            className="absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:bg-surface-2"
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={() => {
              onChange("");
              triggerRef.current?.focus();
            }}
          >
            ×
          </button>
        )}
        {open && !mobile ? list : null}
      </div>
      {value === "" || info === undefined ? null : (
        <p className="m-0 text-xs text-muted tabular-nums">{info}</p>
      )}
      {mobile ? (
        <BottomSheet
          open={open}
          onOpenChange={(o) => {
            if (o) setOpen(true);
            else close();
          }}
          title={sheetTitle}
          footer={
            <Button variant="secondary" onClick={close}>
              {t("close")}
            </Button>
          }
        >
          <input
            {...combo(undefined)}
            aria-label={placeholder}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- sheet mở ra để tìm; focus ngay ô tìm (UI_REVIEW G6).
            autoFocus
            type="search"
            className={`${inputClassName} text-base`}
            placeholder={placeholder}
            value={query ?? ""}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={keyDown}
          />
          {list}
        </BottomSheet>
      ) : null}
    </div>
  );
}
