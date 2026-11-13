"use client";

import type { notificationListSchema } from "@drift/shared";
import { BottomSheet } from "@drift/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  CircleHelp,
  KeyRound,
  Pause,
  Send,
  ShieldAlert,
  Sparkles,
  Square,
  UserRound,
  Check,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { z } from "zod";

import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { NOTIFICATIONS_KEY, useFeatures, useMe, useNotifications } from "@/lib/queries";

import {
  actionOf,
  badgeText,
  isQuiet,
  needsYou,
  splitByDay,
  targetOf,
  type NotificationItem,
} from "../model";
import { useNotificationText } from "../text";

// Panel chuông (docs/NOTIFICATIONS.md mục 7, artboard NT-InApp): popover 420 px trên máy tính, sheet toàn
// màn hình trên điện thoại. Tab All / Needs you, nhóm Today / Earlier, Mark all read; bấm một dòng thì
// đánh dấu đã đọc rồi mở màn hình liên quan. Danh sách đầy đủ vẫn ở Settings › Notifications.

type NotificationList = z.infer<typeof notificationListSchema>;

const ICONS: Record<NotificationItem["type"], { icon: LucideIcon; tone: string }> = {
  bot_paused: { icon: Pause, tone: "bg-neg-bg text-neg-ink" },
  bot_stopped: { icon: Square, tone: "bg-neg-bg text-neg-ink" },
  unknown_order: { icon: CircleHelp, tone: "bg-warn-bg text-warn" },
  risk_alert: { icon: ShieldAlert, tone: "bg-neg-bg text-neg-ink" },
  key_fee: { icon: KeyRound, tone: "bg-warn-bg text-warn" },
  fill: { icon: Check, tone: "bg-pos-bg text-pos" },
  daily_summary: { icon: Sparkles, tone: "bg-accent-tint text-accent" },
  leader_big_move: { icon: UserRound, tone: "bg-bg text-ink-2" },
  telegram_connected: { icon: Send, tone: "bg-pos-bg text-pos" },
  telegram_moved: { icon: Send, tone: "bg-bg text-ink-2" },
  telegram_blocked: { icon: Send, tone: "bg-warn-bg text-warn" },
  // Báo team chỉ đi Telegram (DEC-184), không có bản in-app; có ở đây để map đủ loại.
  team_signup: { icon: UserRound, tone: "bg-bg text-ink-2" },
  team_sodex_connected: { icon: UserRound, tone: "bg-bg text-ink-2" },
  team_bot_started: { icon: UserRound, tone: "bg-bg text-ink-2" },
};
/** Bot dừng đúng kế hoạch hoặc bot tiền ảo: không tô đỏ (DEC-180). */
const QUIET_TONE = "bg-bg text-ink-2";

/** Đánh dấu đã đọc: cập nhật cache ngay rồi gọi API (`all` = Mark all read). */
export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api("POST", `/api/v1/notifications/${encodeURIComponent(id)}/read`, z.unknown(), {
        idempotencyKey: crypto.randomUUID(),
      }),
    onMutate: (id) => {
      const at = new Date().toISOString();
      qc.setQueryData<NotificationList>(NOTIFICATIONS_KEY, (old) => {
        if (old === undefined) return old;
        let cleared = 0;
        const items = old.items.map((n) => {
          if (n.readAt !== null || (id !== "all" && n.id !== id)) return n;
          cleared += 1;
          return { ...n, readAt: at };
        });
        return { items, unread: id === "all" ? 0 : Math.max(0, old.unread - cleared) };
      });
    },
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    },
  });
}

/** Nút chuông ở cụm trạng thái (máy tính): mở popover. */
export function NotificationBell({ unread }: { unread: number }) {
  const t = useTranslations("common.shell");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const badge = badgeText(unread);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label={t("notifications", { n: unread })}
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        className={`relative flex size-11 items-center justify-center rounded-[14px] border text-ink-2 ${
          open ? "border-2 border-accent bg-accent-tint" : "border-border bg-surface"
        }`}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Bell aria-hidden="true" size={20} />
        {badge === null ? null : (
          <span
            aria-hidden="true"
            className="absolute -top-1.5 -right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-bg bg-neg px-1 text-[11.5px] font-extrabold text-surface tabular-nums"
          >
            {badge}
          </span>
        )}
      </button>
      {open ? (
        <div
          id={id}
          className="absolute top-full right-0 z-50 mt-2 w-[420px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-[22px] border border-border bg-surface shadow-lg"
        >
          <NotificationPanel
            variant="popover"
            onNavigate={() => {
              close(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Chuông ở hàng tiêu đề điện thoại: mở cùng sheet toàn màn hình (docs/NOTIFICATIONS.md mục 7). */
export function MobileNotificationBell({ unread }: { unread: number }) {
  const t = useTranslations("common.shell");
  const tn = useTranslations("notifications");
  const [open, setOpen] = useState(false);
  const badge = badgeText(unread);
  return (
    <>
      <button
        type="button"
        aria-label={t("notifications", { n: unread })}
        aria-haspopup="dialog"
        className="relative flex size-11 flex-none items-center justify-center rounded-[14px] border border-border bg-surface text-ink-2"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Bell aria-hidden="true" size={20} />
        {badge === null ? null : (
          <span
            aria-hidden="true"
            className="absolute -top-1.5 -right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-bg bg-neg px-1 text-[11.5px] font-extrabold text-surface tabular-nums"
          >
            {badge}
          </span>
        )}
      </button>
      <BottomSheet open={open} onOpenChange={setOpen} title={tn("title")} fullScreen>
        <NotificationPanel
          variant="sheet"
          onNavigate={() => {
            setOpen(false);
          }}
        />
      </BottomSheet>
    </>
  );
}

/** Dòng "Notifications" trong sheet More (điện thoại): mở sheet toàn màn hình. */
export function MobileNotificationsButton({ unread }: { unread: number }) {
  const t = useTranslations("common.shell");
  const tn = useTranslations("notifications");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        className="flex min-h-tap items-center gap-3 rounded-control px-3 text-left text-sm font-semibold text-ink-2"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Bell aria-hidden="true" size={20} />
        {t("notifications", { n: unread })}
      </button>
      <BottomSheet open={open} onOpenChange={setOpen} title={tn("title")} fullScreen>
        <NotificationPanel
          variant="sheet"
          onNavigate={() => {
            setOpen(false);
          }}
        />
      </BottomSheet>
    </>
  );
}

export function NotificationPanel({
  variant,
  onNavigate,
}: {
  /** `sheet`: tiêu đề do BottomSheet hiện, panel không lặp lại. */
  variant: "popover" | "sheet";
  onNavigate: () => void;
}) {
  const t = useTranslations("notifications");
  const notes = useNotifications();
  const me = useMe();
  const aiDesk = useFeatures().data?.aiDesk === true;
  const markRead = useMarkRead();
  const text = useNotificationText();
  const [tab, setTab] = useState<"all" | "needs">("all");
  const headingId = useId();
  const tabsId = useId();
  const allTab = useRef<HTMLButtonElement>(null);
  const needsTab = useRef<HTMLButtonElement>(null);
  const timeZone = me.data?.timezone ?? "Asia/Ho_Chi_Minh";

  const items = notes.data?.items ?? [];
  const needs = needsYou(items);
  const shown = tab === "all" ? items : needs;
  const { today, earlier } = splitByDay(shown, new Date(), timeZone);
  const unread = notes.data?.unread ?? 0;

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = tab === "all" ? "needs" : "all";
    setTab(next);
    (next === "all" ? allTab : needsTab).current?.focus();
  };

  const time = (n: NotificationItem, isToday: boolean) =>
    isToday
      ? new Intl.DateTimeFormat("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
          timeZone,
        }).format(new Date(n.createdAt))
      : formatDate(Date.parse(n.createdAt), timeZone).replace(/, \d{4}$/, "");

  const row = (n: NotificationItem, isToday: boolean) => {
    const { icon: Icon, tone: incidentTone } = ICONS[n.type];
    const tone = isQuiet(n) ? QUIET_TONE : incidentTone;
    const { title, body } = text(n);
    const unreadRow = n.readAt === null;
    return (
      <li key={n.id}>
        <Link
          href={targetOf(n, aiDesk)}
          className={`relative flex gap-3 px-[18px] py-3 text-ink no-underline hover:bg-bg ${
            unreadRow ? "bg-accent-tint/40" : ""
          }`}
          onClick={() => {
            if (unreadRow) markRead.mutate(n.id);
            onNavigate();
          }}
        >
          {unreadRow ? (
            <span
              aria-hidden="true"
              className="absolute top-[22px] left-[7px] size-[7px] rounded-full bg-accent"
            />
          ) : null}
          <span
            aria-hidden="true"
            className={`flex size-[34px] shrink-0 items-center justify-center rounded-[11px] ${tone}`}
          >
            <Icon size={16} />
          </span>
          <span className="flex min-w-0 flex-col gap-0.5 text-[13px] leading-[1.45]">
            <b className="text-sm">
              {unreadRow ? <span className="sr-only">{t("panel.unreadPrefix")} </span> : null}
              {title}
            </b>
            {body === null ? null : <span className="text-ink-2">{body}</span>}
            <span className="text-xs text-muted tabular-nums">
              <time dateTime={n.createdAt}>{time(n, isToday)}</time>
              {isToday ? ` · ${t(`panel.actions.${actionOf(n, aiDesk)}`)} →` : null}
            </span>
          </span>
        </Link>
      </li>
    );
  };

  const section = (label: string, list: NotificationItem[], isToday: boolean) =>
    list.length === 0 ? null : (
      <section aria-label={label}>
        <h3 className="m-0 px-[18px] pt-2 pb-1 text-[11.5px] font-extrabold tracking-[0.06em] text-muted uppercase">
          {label}
        </h3>
        <ul className="m-0 list-none p-0">{list.map((n) => row(n, isToday))}</ul>
      </section>
    );

  const panelBody =
    notes.data === undefined ? (
      notes.isError ? (
        <p role="alert" className="m-0 px-[18px] py-6 text-sm text-ink-2">
          {t("panel.loadFailed")}
        </p>
      ) : (
        <p className="m-0 px-[18px] py-6 text-sm text-muted">{t("panel.loading")}</p>
      )
    ) : shown.length === 0 ? (
      <p className="m-0 px-[18px] py-6 text-sm text-ink-2">{t("panel.empty")}</p>
    ) : (
      <>
        {section(t("panel.today"), today, true)}
        {section(t("panel.earlier"), earlier, false)}
      </>
    );

  return (
    <div
      {...(variant === "popover"
        ? { role: "dialog", "aria-labelledby": headingId }
        : { "aria-label": t("title") })}
      className={`flex flex-col ${variant === "popover" ? "max-h-[min(640px,80vh)]" : "min-h-0 flex-1"}`}
    >
      <div className="flex items-center justify-between gap-2 px-[18px] pt-4 pb-2.5">
        {variant === "popover" ? (
          <h2 id={headingId} className="m-0 text-[17px] font-extrabold">
            {t("title")}
          </h2>
        ) : (
          <span />
        )}
        {unread === 0 ? null : (
          <button
            type="button"
            className="min-h-tap border-none bg-transparent text-[13px] font-bold text-accent-ink"
            onClick={() => {
              markRead.mutate("all");
            }}
          >
            {t("markAll")}
          </button>
        )}
      </div>
      <div
        role="tablist"
        aria-label={t("panel.tabsLabel")}
        className="flex gap-1.5 px-[18px] pb-2.5"
      >
        <button
          ref={allTab}
          id={`${tabsId}-all`}
          type="button"
          role="tab"
          aria-selected={tab === "all"}
          aria-controls={`${tabsId}-panel`}
          tabIndex={tab === "all" ? 0 : -1}
          className={tabClass(tab === "all")}
          onClick={() => {
            setTab("all");
          }}
          onKeyDown={onTabKey}
        >
          {t("panel.all")}
        </button>
        <button
          ref={needsTab}
          id={`${tabsId}-needs`}
          type="button"
          role="tab"
          aria-selected={tab === "needs"}
          aria-controls={`${tabsId}-panel`}
          tabIndex={tab === "needs" ? 0 : -1}
          className={tabClass(tab === "needs")}
          onClick={() => {
            setTab("needs");
          }}
          onKeyDown={onTabKey}
        >
          {needs.length === 0 ? t("panel.needsYou") : t("panel.needsYouCount", { n: needs.length })}
        </button>
      </div>
      <div
        id={`${tabsId}-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto pb-1"
      >
        {panelBody}
        {notes.isError && notes.data !== undefined ? (
          <p role="status" className="m-0 px-[18px] py-2 text-xs text-muted">
            {t("panel.staleSince", {
              time: new Intl.DateTimeFormat("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                hourCycle: "h23",
                timeZone,
              }).format(new Date(notes.dataUpdatedAt)),
            })}
          </p>
        ) : null}
      </div>
      <div className="flex justify-between gap-2 border-t border-border bg-bg px-[18px] py-3 text-[13px] font-bold">
        <Link href="/settings?tab=notifications" className="no-underline" onClick={onNavigate}>
          {t("panel.settings")}
        </Link>
        <Link
          href="/settings?tab=notifications#all-notifications"
          className="no-underline"
          onClick={onNavigate}
        >
          {t("panel.seeAll")}
        </Link>
      </div>
    </div>
  );
}

function tabClass(selected: boolean): string {
  return `inline-flex min-h-8 items-center rounded-full px-3 text-[12.5px] font-extrabold ${
    selected ? "border-none bg-ink text-surface" : "border border-border bg-surface text-ink-2"
  }`;
}
