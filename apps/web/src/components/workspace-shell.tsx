"use client";

import { BotState, botListSchema } from "@drift/shared";
import { AppShell, LiveBadge, type MobileNav, type NavItem } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  Bot,
  ChevronDown,
  Ellipsis,
  House,
  Clock,
  Coins,
  FlaskConical,
  LayoutDashboard,
  ListOrdered,
  OctagonX,
  Settings,
  ShieldAlert,
  Sparkles,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { api } from "@/lib/api";
import { formatDateTime, shortAddress } from "@/lib/format";
import { useMe, useSodexConnection, useNotifications } from "@/lib/queries";

import { SignOutButton } from "./sign-out";

// Khung workspace theo artboard Main (SCREENS.md mục 8): sidebar thẻ nổi, Emergency ở cuối sidebar,
// cụm trạng thái nằm bên phải hàng tiêu đề của mỗi trang. Builder Revenue và Users chỉ hiện với role `team`.

const ITEMS = [
  ["overview", "/", LayoutDashboard, "main"],
  ["portfolio", "/portfolio", Wallet, "main"],
  ["agent", "/agent", Bot, "main"],
  ["bots", "/bots", FlaskConical, "main"],
  ["orders", "/orders", ListOrdered, "main"],
  ["risk", "/risk", ShieldAlert, "main"],
  ["analyst", "/analyst", Sparkles, "main"],
  ["revenue", "/admin/builder-revenue", Coins, "team"],
  ["users", "/admin/users", Users, "team"],
  ["settings", "/settings", Settings, "secondary"],
] as const satisfies readonly (readonly [
  string,
  string,
  LucideIcon,
  "main" | "team" | "secondary",
])[];

export type WorkspaceKey = (typeof ITEMS)[number][0];

// Chỉ role `team`; api vẫn tự kiểm tra role (DEC-64).
const TEAM_ONLY: ReadonlySet<WorkspaceKey> = new Set(["revenue", "users"]);

export function WorkspaceShell({
  current,
  isTeam,
  children,
}: {
  current: WorkspaceKey;
  isTeam: boolean;
  children: ReactNode;
}) {
  const t = useTranslations("common.nav");
  const tc = useTranslations("common");
  const navItems: NavItem[] = ITEMS.filter(([key]) => !TEAM_ONLY.has(key) || isTeam).map(
    ([key, href, Icon, group]) => ({
      key,
      label: t(key),
      href,
      icon: <Icon aria-hidden="true" size={20} />,
      current: key === current,
      group,
    }),
  );
  const byKey = (key: WorkspaceKey) => navItems.find((i) => i.key === key);
  const pick = (keys: readonly WorkspaceKey[]) =>
    keys.flatMap((k) => {
      const item = byKey(k);
      return item === undefined ? [] : [item];
    });
  // Bottom nav mobile (artboard Mobile-Home): Home · Portfolio · Agent (nổi) · Strategy · More.
  const mobileNav: MobileNav = {
    items: pick(["overview", "portfolio", "agent", "bots"]).map((item) => ({
      ...item,
      label: t(`mobile.${item.key as "overview" | "portfolio" | "agent" | "bots"}`),
      icon: item.key === "overview" ? <House aria-hidden="true" size={22} /> : item.icon,
    })),
    featuredKey: "agent",
    more: {
      label: t("mobile.more"),
      icon: <Ellipsis aria-hidden="true" size={22} />,
      items: pick(["orders", "risk", "analyst", "revenue", "users", "settings"]),
      footer: <MoreFooter />,
    },
  };
  return (
    <AppShell
      mobileNav={mobileNav}
      brand={
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex size-9 items-center justify-center rounded-[11px] bg-accent text-white"
          >
            <BrandMark />
          </span>
          <span className="flex flex-col">
            <span className="text-lg font-extrabold tracking-[0.06em]">{tc("brand")}</span>
            <span className="text-xs font-medium text-muted">{t("workspace")}</span>
          </span>
        </span>
      }
      navItems={navItems}
      headerExtras={<StatusCluster />}
      sidebarFooter={<EmergencyCard />}
      navLabel={t("label")}
      teamLabel={t("team")}
      skipLinkLabel={t("skip")}
      renderLink={({ children, ...props }) => <Link {...props}>{children}</Link>}
    >
      {children}
    </AppShell>
  );
}

/** Logo: đường giá trên trục (artboard Main). */
function BrandMark() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 15c3-6 6 2 9-3s5-5 7-4" />
      <path d="M4 20h16" />
    </svg>
  );
}

/**
 * Thẻ Emergency cuối sidebar: dẫn tới luồng Halt all ở Risk Center (người dùng xem lại trước khi chạy).
 * Không có bot nào đang chạy (hoặc chưa biết): thu lại thành một dòng nhạt (UI_REVIEW J8).
 */
function EmergencyCard() {
  const t = useTranslations("overview.emergency");
  const bots = useQuery({
    queryKey: ["bots"],
    queryFn: () => api("GET", "/api/v1/bots", botListSchema),
    staleTime: 5_000,
  });
  const running = (bots.data?.items ?? []).some((b) => b.state === BotState.running);
  if (!running) {
    return (
      <Link
        href="/risk#halt"
        // Cùng lề, cỡ icon (20 px) và cỡ chữ với các mục nav; màu đỏ nhạt để vẫn nhận ra là nút khẩn cấp.
        className="flex min-h-tap items-center gap-3 rounded-control px-3 text-sm font-semibold text-neg-ink no-underline hover:bg-neg-soft"
      >
        <OctagonX aria-hidden="true" size={20} />
        {t("cta")}
      </Link>
    );
  }
  return (
    <div className="flex flex-col gap-2.5 rounded-[16px] border border-neg-border bg-neg-soft p-3.5">
      <span className="text-xs font-bold tracking-[0.04em] text-neg-deep uppercase">
        {t("title")}
      </span>
      <span className="text-[13px] leading-[1.45] text-neg-text">{t("body")}</span>
      <Link
        href="/risk#halt"
        className="flex min-h-tap items-center justify-center gap-2 rounded-control border-[1.5px] border-neg bg-surface text-sm font-bold text-neg-ink no-underline"
      >
        <OctagonX aria-hidden="true" size={18} />
        {t("cta")}
      </Link>
    </div>
  );
}

/**
 * Chip "Updated …" riêng của trang (ví dụ "Positions updated 14:02:09", artboard Portfolio): thay chip
 * "Updated Xs ago" chung, không thêm chip thứ hai (UI_REVIEW E1.1).
 */
export const PageUpdatedContext = createContext<PageUpdated | null>(null);
/** `label` nhận chuỗi tương đối ("12s ago"); thời điểm tuyệt đối nằm ở tooltip (UI_REVIEW J8). */
export interface PageUpdated {
  label: (ago: string) => string;
  at: string;
}

/**
 * Cụm đầy đủ (account, LIVE, SoDEX, Updated, chuông, avatar) chỉ ở Overview như artboard Main; các trang
 * khác chỉ có LIVE, trạng thái SoDEX và chip riêng của trang (artboard Portfolio, Agent, Bots…).
 */
export const FullClusterContext = createContext(false);

/**
 * Cụm bên phải hàng tiêu đề: account, LIVE · MAINNET, trạng thái SoDEX, thời điểm cập nhật,
 * chuông thông báo, avatar (email + Sign out). Mọi giá trị lấy từ backend.
 */
function StatusCluster() {
  const t = useTranslations("common.shell");
  const tb = useTranslations("common.badges");
  const conn = useSodexConnection();
  const pageUpdated = useContext(PageUpdatedContext);
  const full = useContext(FullClusterContext);
  // Key hết hạn hoặc không ký được (UI_REVIEW H1): không ghi "SoDEX connected".
  const keyStatus = conn.data?.connection?.apiKey?.status;
  const keyBad = keyStatus === "unusable" || keyStatus === "expired";
  const notes = useNotifications(full);
  const c = conn.data?.connection ?? null;
  const unread = notes.data?.unread ?? 0;

  return (
    <>
      {c === null || !full ? null : <AccountSwitch address={c.address} />}
      <LiveBadge label={tb("live")} className="h-8 px-3" />
      {conn.isSuccess ? (
        keyBad ? (
          <Link
            href="/settings"
            className="inline-flex h-8 items-center gap-2 rounded-full border border-warn-bar bg-warn-bg px-3 text-[13px] font-semibold text-warn no-underline"
          >
            <span aria-hidden="true" className="size-2 rounded-full bg-warn-bar" />
            {t("sodexKeyRenew")}
          </Link>
        ) : (
          <span className="inline-flex h-8 items-center gap-2 rounded-full border border-border bg-surface px-3 text-[13px] font-semibold text-ink-2">
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${
                c?.status === "connected"
                  ? "bg-pos-dot ring-[3px] ring-pos-bg"
                  : c?.status === "connecting"
                    ? "bg-warn-bar"
                    : "bg-neg"
              }`}
            />
            {c?.status === "connected"
              ? t("sodexConnected")
              : c?.status === "connecting"
                ? t("sodexConnecting")
                : t("sodexNotConnected")}
          </span>
        )
      ) : null}
      {pageUpdated !== null ? (
        <PageUpdatedChip {...pageUpdated} />
      ) : c === null || !full ? null : (
        <UpdatedAgo at={conn.dataUpdatedAt} />
      )}
      {full ? <NotificationsAndAccount unread={unread} /> : null}
    </>
  );
}

function NotificationsAndAccount({ unread }: { unread: number }) {
  const t = useTranslations("common.shell");
  return (
    <>
      <Link
        href="/settings?tab=notifications"
        aria-label={t("notifications", { n: unread })}
        className="relative flex size-11 items-center justify-center rounded-[14px] border border-border bg-surface text-ink-2"
      >
        <Bell aria-hidden="true" size={20} />
        {unread > 0 ? (
          <span
            aria-hidden="true"
            className="absolute top-[9px] right-2.5 size-2 rounded-full border-2 border-surface bg-neg"
          />
        ) : null}
      </Link>
      <AccountMenu />
    </>
  );
}

/** Số giây kể từ `at`, cập nhật mỗi 5 s. */
function useAgeSeconds(at: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, 5_000);
    return () => {
      clearInterval(id);
    };
  }, []);
  return Math.max(0, Math.round((now - at) / 1000));
}

/**
 * Trạng thái gọn cho hàng tiêu đề mobile (artboard Mobile-Home, M-Portfolio): chip LIVE nhỏ cạnh tiêu đề và
 * dòng "● SoDEX · 12s ago" dưới tiêu đề. Chọn account, chuông, avatar nằm trong sheet More.
 */
export function MobileLiveChip() {
  const tb = useTranslations("common.badges");
  return <LiveBadge label={tb("liveShort")} className="h-[26px] shrink-0 px-2.5 text-[11px]" />;
}

export function MobileSodexStatus() {
  const t = useTranslations("common.shell");
  const conn = useSodexConnection();
  const s = useAgeSeconds(conn.dataUpdatedAt);
  if (!conn.isSuccess) return null;
  const keyStatus = conn.data.connection?.apiKey?.status;
  const keyBad = keyStatus === "unusable" || keyStatus === "expired";
  const status = conn.data.connection?.status;
  const label = keyBad
    ? t("sodexKeyRenew")
    : status === "connected"
      ? s < 60
        ? t("sodexAgoSeconds", { n: s })
        : s < 3600
          ? t("sodexAgoMinutes", { n: Math.floor(s / 60) })
          : t("sodexAgoHours", { n: Math.floor(s / 3600) })
      : status === "connecting"
        ? t("sodexConnecting")
        : t("sodexNotConnected");
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted tabular-nums">
      <span
        aria-hidden="true"
        className={`size-[7px] rounded-full ${keyBad ? "bg-warn-bar" : status === "connected" ? "bg-pos-dot" : status === "connecting" ? "bg-warn-bar" : "bg-neg"}`}
      />
      {label}
    </span>
  );
}

/** Cuối sheet More (mobile): account SoDEX, thông báo, email + Sign out. */
function MoreFooter() {
  const t = useTranslations("common.shell");
  const conn = useSodexConnection();
  const notes = useNotifications();
  const me = useMe();
  const c = conn.data?.connection ?? null;
  const unread = notes.data?.unread ?? 0;
  return (
    <>
      {c === null ? null : (
        <Link
          href="/settings"
          className="flex min-h-tap items-center gap-3 rounded-control px-3 text-sm font-semibold text-ink-2 no-underline"
        >
          <span className="font-bold text-ink">{t("mainAccount")}</span>
          <span className="text-muted tabular-nums">{shortAddress(c.address)}</span>
        </Link>
      )}
      <Link
        href="/settings?tab=notifications"
        className="flex min-h-tap items-center gap-3 rounded-control px-3 text-sm font-semibold text-ink-2 no-underline"
      >
        <Bell aria-hidden="true" size={20} />
        {t("notifications", { n: unread })}
      </Link>
      {me.data === undefined ? null : (
        <span className="truncate px-3 text-sm text-ink-2" title={me.data.email}>
          {me.data.email}
        </span>
      )}
      <SignOutButton />
    </>
  );
}

/** "12s ago" / "3m ago" / "2h ago" từ số giây. */
function useAgo(at: number): string {
  const t = useTranslations("common.shell");
  const s = useAgeSeconds(at);
  return s < 60
    ? t("agoSeconds", { n: s })
    : s < 3600
      ? t("agoMinutes", { n: Math.floor(s / 60) })
      : t("agoHours", { n: Math.floor(s / 3600) });
}

/** Chip thời điểm riêng của trang: chữ tương đối, giờ tuyệt đối ở tooltip (UI_REVIEW J8). */
function PageUpdatedChip({ label, at }: PageUpdated) {
  const ago = useAgo(Date.parse(at));
  return (
    <span
      title={formatDateTime(at)}
      className="hidden h-8 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-[13px] font-medium text-muted tabular-nums lg:inline-flex"
    >
      <Clock aria-hidden="true" size={14} />
      <time dateTime={at}>{label(ago)}</time>
    </span>
  );
}

/** "Updated 12s ago": thời điểm DRIFT đọc lại trạng thái SoDEX gần nhất. */
function UpdatedAgo({ at }: { at: number }) {
  const t = useTranslations("common.shell");
  const s = useAgeSeconds(at);
  const label =
    s < 60
      ? t("updatedSeconds", { n: s })
      : s < 3600
        ? t("updatedMinutes", { n: Math.floor(s / 60) })
        : t("updatedHours", { n: Math.floor(s / 3600) });
  return (
    <span
      title={formatDateTime(at)}
      className="hidden h-8 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-[13px] font-medium text-muted tabular-nums lg:inline-flex"
    >
      <Clock aria-hidden="true" size={14} />
      <time dateTime={new Date(at).toISOString()}>{label}</time>
    </span>
  );
}

/** Menu bật/tắt dùng chung: đóng khi bấm ra ngoài hoặc nhấn Escape. */
function Popover({
  className = "",
  button,
  buttonLabel,
  buttonClassName,
  children,
}: {
  className?: string;
  button: ReactNode;
  /** Bỏ trống khi nút đã có chữ hiển thị (axe: label-content-name-mismatch). */
  buttonLabel?: string;
  buttonClassName: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        {...(buttonLabel === undefined ? {} : { "aria-label": buttonLabel })}
        aria-expanded={open}
        aria-controls={id}
        className={buttonClassName}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {button}
      </button>
      {open ? (
        <div
          id={id}
          className="absolute top-full right-0 z-50 mt-2 flex w-64 flex-col gap-3 rounded-tile border border-border bg-surface p-4 shadow-lg"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** "Main account ▾": một account SoDEX mỗi người dùng; menu hiện địa chỉ và lối vào SoDEX access. */
function AccountSwitch({ address }: { address: string }) {
  const t = useTranslations("common.shell");
  const ts = useTranslations("settings.tabs");
  return (
    <Popover
      className="hidden lg:block"
      buttonClassName="flex min-h-tap items-center gap-2.5 rounded-[14px] border border-border bg-surface px-3.5 text-sm font-semibold text-ink"
      button={
        <>
          <span
            aria-hidden="true"
            className="flex size-[26px] items-center justify-center rounded-lg bg-accent-tint text-xs font-extrabold text-accent"
          >
            {t("mainAccount").slice(0, 1)}
          </span>
          {t("mainAccount")}
          <ChevronDown aria-hidden="true" size={16} />
        </>
      }
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-bold">{t("mainAccount")}</span>
        <span className="text-xs text-muted tabular-nums">{shortAddress(address)}</span>
      </span>
      <Link href="/settings" className="text-sm font-bold">
        {ts("access")}
      </Link>
    </Popover>
  );
}

/** Avatar: menu chứa email đang đăng nhập và Sign out. */
function AccountMenu() {
  const t = useTranslations("common.shell");
  const me = useMe();
  const initials = me.data === undefined ? "" : initialsOf(me.data.displayName ?? me.data.email);
  return (
    <Popover
      buttonClassName="flex size-11 items-center justify-center rounded-full bg-ink text-sm font-bold text-surface"
      // Chữ viết tắt chỉ để nhìn; tên của nút là "Account menu" qua chữ sr-only, không dùng aria-label
      // (axe label-content-name-mismatch khi aria-label khác chữ hiển thị).
      button={
        <>
          <span aria-hidden="true">{initials}</span>
          <span className="sr-only">{t("accountMenu")}</span>
        </>
      }
    >
      {me.data === undefined ? null : (
        <span className="flex min-w-0 flex-col gap-0.5">
          {me.data.displayName === null ? null : (
            <span className="truncate text-sm font-bold">{me.data.displayName}</span>
          )}
          <span className="truncate text-sm text-ink-2" title={me.data.email}>
            {me.data.email}
          </span>
        </span>
      )}
      <SignOutButton />
    </Popover>
  );
}

function initialsOf(name: string): string {
  const words =
    name
      .split("@")[0]
      ?.split(/[^A-Za-z]+/)
      .filter(Boolean) ?? [];
  const letters =
    words.length >= 2
      ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
      : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase();
}
