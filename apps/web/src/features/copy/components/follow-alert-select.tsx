"use client";

import { FOLLOW_ALERT_LEVELS, type FollowAlertLevel } from "@drift/shared";
import { Button } from "@drift/ui";
import { Bell, ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { useFollow, useSetFollowAlert } from "../api";
import { useCopyErrorText } from "../errors";

// Ô chọn "Alerts: Big moves ▾" cho một trader đang follow (DEC-209, PM chốt vị trí A): trên hàng trader
// ở Following. Trạng thái lấy từ backend; đang lưu thì khoá, lỗi thì hiện câu chữ (không nuốt lỗi).

export function FollowAlertSelect({
  address,
  trader,
  level,
}: {
  address: string;
  /** Tên hiển thị của trader cho nhãn trình đọc màn hình. */
  trader: string;
  level: FollowAlertLevel;
}) {
  const t = useTranslations("copy.followAlerts");
  const set = useSetFollowAlert();
  const errorText = useCopyErrorText();
  const pending = set.isPending ? set.variables.level : null;
  const current = pending ?? level;
  // Pill gọn "🔔 Big moves ▾" (người dùng chọn): select gốc của trình duyệt bỏ khung mặc định, giữ bàn phím và
  // trình đọc màn hình; vùng bấm vẫn ≥ 44px chiều cao.
  return (
    <div className="flex flex-col gap-1">
      <span className="relative inline-flex w-fit items-center">
        <Bell
          aria-hidden="true"
          size={14}
          strokeWidth={2.2}
          className={`pointer-events-none absolute left-3 ${current === "off" ? "text-muted" : "text-accent-ink"}`}
        />
        <select
          aria-label={t("ariaLabel", { trader })}
          value={current}
          disabled={set.isPending}
          onChange={(e) => {
            set.mutate({ address, level: e.target.value as FollowAlertLevel });
          }}
          className={`min-h-tap cursor-pointer appearance-none rounded-full border border-border bg-surface py-0 pr-8 pl-8 text-xs font-bold disabled:opacity-60 ${
            current === "off" ? "text-ink-2" : "text-ink"
          }`}
        >
          {FOLLOW_ALERT_LEVELS.map((l) => (
            <option key={l} value={l}>
              {t(`levels.${l}`)}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          size={14}
          strokeWidth={2.4}
          className="pointer-events-none absolute right-3 text-ink-2"
        />
      </span>
      {set.isError ? (
        <p role="alert" className="m-0 text-xs font-semibold text-neg-ink">
          {errorText(set.error)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Hồ sơ trader khi đã follow (PM chốt vị trí A): nút "★ Following ▾" mở menu gồm 3 mức cảnh báo và Unfollow. Cùng
 * nguồn dữ liệu với ô chọn ở Following.
 */
export function FollowingMenu({ address, level }: { address: string; level: FollowAlertLevel }) {
  const t = useTranslations("copy");
  const ta = useTranslations("copy.followAlerts");
  const set = useSetFollowAlert();
  const follow = useFollow();
  const errorText = useCopyErrorText();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Trả focus về nút mở menu (Button của @drift/ui không nhận ref).
      ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const shown = set.isPending ? set.variables.level : level;
  const error = set.isError ? set.error : follow.isError ? follow.error : null;
  return (
    <div ref={ref} className="relative">
      <Button
        variant="secondary"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {t("common.following")}
        <span aria-hidden="true">▾</span>
      </Button>
      {open ? (
        <div
          id={id}
          className="absolute top-full right-0 z-40 mt-2 flex w-72 flex-col gap-3 rounded-tile border border-border bg-surface p-4 shadow-lg"
        >
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0" disabled={set.isPending}>
            <legend className="mb-1 text-xs font-extrabold text-ink-2">{ta("menuTitle")}</legend>
            {FOLLOW_ALERT_LEVELS.map((l) => (
              <label
                key={l}
                className="grid min-h-tap cursor-pointer grid-cols-[auto_1fr] items-center gap-x-2.5 rounded-[10px] px-2 py-1 text-sm hover:bg-surface-2"
              >
                <input
                  type="radio"
                  name={`${id}-level`}
                  value={l}
                  checked={shown === l}
                  onChange={() => {
                    set.mutate({ address, level: l });
                  }}
                  className="row-span-2 size-4 accent-accent"
                />
                <span className="font-bold">{ta(`levels.${l}`)}</span>
                <span className="text-xs text-muted">{ta(`hints.${l}`)}</span>
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            disabled={follow.isPending}
            onClick={() => {
              follow.mutate({ address, on: false });
            }}
            className="min-h-tap rounded-[10px] border-t border-border pt-2 text-left text-sm font-bold text-neg-ink disabled:opacity-60"
          >
            {t("following.unfollow")}
          </button>
          {error === null ? null : (
            <p role="alert" className="m-0 text-xs font-semibold text-neg-ink">
              {errorText(error)}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
