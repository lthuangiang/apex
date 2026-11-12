"use client";

import { Pause, ShieldAlert, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { useFeatures, useNotifications } from "@/lib/queries";

import { mergeToast, newAlerts, targetOf, type NotificationItem } from "../model";
import { useNotificationText } from "../text";

// Toast cho Bot problems và Risk (docs/NOTIFICATIONS.md mục 7, artboard NT-InApp): aria-live assertive,
// tự ẩn sau 8 s nhưng không ẩn khi đang hover hoặc focus; mỗi lúc chỉ 1 toast, nhiều sự kiện thì gộp.

export const TOAST_MS = 8_000;

// Id đã thấy trong tab này. Ở mức module để không bật lại toast khi chuyển trang (shell mount lại).
let seenIds: Set<string> | null = null;

/** Chỉ dùng trong test. */
export function resetToastMemory(): void {
  seenIds = null;
}

export function NotificationToasts() {
  const t = useTranslations("notifications");
  const notes = useNotifications();
  const aiDesk = useFeatures().data?.aiDesk === true;
  const text = useNotificationText();
  const [shown, setShown] = useState<NotificationItem[]>([]);
  const [held, setHeld] = useState(false);
  const card = useRef<HTMLDivElement>(null);

  const items = notes.data?.items;
  useEffect(() => {
    if (items === undefined) return;
    const r = newAlerts(seenIds, items);
    seenIds = r.seen;
    if (r.fresh.length > 0) setShown((cur) => mergeToast(cur, r.fresh));
  }, [items]);

  // Đếm lại 8 s mỗi khi nội dung đổi; dừng khi đang hover hoặc focus.
  useEffect(() => {
    if (shown.length === 0 || held) return;
    const id = setTimeout(() => {
      setShown([]);
    }, TOAST_MS);
    return () => {
      clearTimeout(id);
    };
  }, [shown, held]);

  const first = shown[0];
  const visible = first !== undefined;

  // Giữ toast khi chuột đang ở trên hoặc focus đang ở trong (WCAG 2.2.1: người dùng đủ thời gian đọc).
  useEffect(() => {
    const el = card.current;
    if (!visible || el === null) return;
    let hover = false;
    let focus = false;
    const sync = () => {
      setHeld(hover || focus);
    };
    const enter = () => {
      hover = true;
      sync();
    };
    const leave = () => {
      hover = false;
      sync();
    };
    const focusIn = () => {
      focus = true;
      sync();
    };
    const focusOut = (e: FocusEvent) => {
      if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
      focus = false;
      sync();
    };
    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);
    el.addEventListener("focusin", focusIn);
    el.addEventListener("focusout", focusOut);
    return () => {
      el.removeEventListener("mouseenter", enter);
      el.removeEventListener("mouseleave", leave);
      el.removeEventListener("focusin", focusIn);
      el.removeEventListener("focusout", focusOut);
      setHeld(false);
    };
  }, [visible]);

  const dismiss = () => {
    setShown([]);
  };

  const merged = shown.length > 1;
  const body = first === undefined ? null : text(first);
  const Icon = first?.type === "risk_alert" && !merged ? ShieldAlert : Pause;

  return (
    // Vùng live luôn có trong DOM để trình đọc màn hình đọc được nội dung khi nó xuất hiện.
    <div
      role="status"
      aria-live="assertive"
      aria-atomic="true"
      className="pointer-events-none fixed right-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[60] w-[400px] max-w-[calc(100vw-2rem)] lg:right-7 lg:bottom-7"
    >
      {first === undefined || body === null ? null : (
        <div
          ref={card}
          className="pointer-events-auto flex items-start gap-3 rounded-[18px] bg-ink px-[18px] py-4 text-surface shadow-lg"
        >
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-neg"
          >
            <Icon size={16} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <b className="text-[14.5px]">
              {merged ? t("toast.merged", { n: shown.length }) : body.title}
            </b>
            {merged || body.body === null ? null : (
              <span className="text-[13px] text-on-ink-2">{body.body}</span>
            )}
            <Link
              href={
                merged ? "/settings?tab=notifications#all-notifications" : targetOf(first, aiDesk)
              }
              className="mt-0.5 self-start text-[13px] font-extrabold text-on-ink-accent no-underline"
              onClick={dismiss}
            >
              {merged ? t("toast.seeAll") : t("toast.review")}
            </Link>
          </div>
          <button
            type="button"
            aria-label={t("toast.dismiss")}
            className="flex size-8 shrink-0 items-center justify-center rounded-full border-none bg-surface/10 text-surface"
            onClick={dismiss}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
