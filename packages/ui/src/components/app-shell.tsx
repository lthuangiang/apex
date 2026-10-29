import { createContext, useContext, useState, type ReactNode } from "react";

import { cx } from "../lib/cx";

import { BottomSheet } from "./bottom-sheet";

export interface NavItem {
  key: string;
  label: string;
  href: string;
  icon: ReactNode;
  current?: boolean;
  /**
   * `team`: nhóm có nhãn nhỏ riêng, chỉ dành cho role team (Builder Revenue, Users; UI_REVIEW J8).
   * `secondary`: nằm sau đường kẻ, tách khỏi nhóm điều hướng chính (Settings).
   */
  group?: "main" | "team" | "secondary";
}

export interface NavLinkProps {
  href: string;
  className: string;
  "aria-current"?: "page";
  children: ReactNode;
}

export interface AppShellProps {
  brand: ReactNode;
  navItems: readonly NavItem[];
  /** Nhãn cho landmark điều hướng, ví dụ "Main". */
  navLabel: string;
  /** Nhãn nhỏ phía trên nhóm `team`, ví dụ "Team". */
  teamLabel?: string;
  /** Câu chữ link bỏ qua điều hướng, ví dụ "Skip to content". */
  skipLinkLabel: string;
  /**
   * Cụm trạng thái chung ở bên phải hàng tiêu đề (account, LIVE, SoDEX, chuông, avatar).
   * Không có thanh trên cùng riêng: tiêu đề trang render cụm này qua `<ShellHeaderExtras />`.
   */
  headerExtras?: ReactNode;
  /** Nội dung cuối sidebar desktop, ví dụ thẻ Emergency. */
  sidebarFooter?: ReactNode;
  /**
   * Bottom nav mobile (artboard Mobile-Home): vài mục chính, một mục nổi ở giữa (`featuredKey`)
   * và nút "More" mở danh sách các trang còn lại. Không truyền thì bottom nav dùng `navItems`.
   */
  mobileNav?: MobileNav;
  /** Cho phép app dùng `next/link`; mặc định là thẻ `<a>`. */
  renderLink?: (props: NavLinkProps) => ReactNode;
  children: ReactNode;
}

export interface MobileNav {
  items: readonly NavItem[];
  /** Mục nổi ở giữa, nền primary. */
  featuredKey?: string;
  /** `footer`: nội dung cuối sheet (ví dụ email, thông báo, Sign out trên mobile). */
  more?: { label: string; icon: ReactNode; items: readonly NavItem[]; footer?: ReactNode };
}

const HeaderExtrasContext = createContext<ReactNode>(null);

/** Cụm trạng thái chung của AppShell; đặt ở bên phải hàng tiêu đề của mỗi trang. */
export function ShellHeaderExtras() {
  return <>{useContext(HeaderExtrasContext)}</>;
}

const defaultLink = ({ children, ...props }: NavLinkProps) => <a {...props}>{children}</a>;

/**
 * Khung trang theo artboard Main: sidebar dạng thẻ nổi khi ≥ 1024px, bottom nav khi nhỏ hơn
 * (docs/DESIGN.md, Responsive). Không có thanh trên cùng; cụm trạng thái nằm trong hàng tiêu đề.
 * Nội dung không bao giờ làm cả trang cuộn ngang.
 */
export function AppShell({
  brand,
  navItems,
  navLabel,
  teamLabel,
  skipLinkLabel,
  headerExtras,
  sidebarFooter,
  mobileNav,
  renderLink = defaultLink,
  children,
}: AppShellProps) {
  const link = (item: NavItem, className: string, content: ReactNode) =>
    renderLink({
      href: item.href,
      className,
      ...(item.current ? { "aria-current": "page" as const } : {}),
      children: content,
    });
  const sideItem = (item: NavItem) => (
    <li key={item.key}>
      {link(
        item,
        cx(
          "flex min-h-tap items-center gap-3 rounded-control px-3 text-sm",
          item.current
            ? "bg-accent font-bold text-white shadow-accent"
            : "font-semibold text-ink-2 hover:bg-surface-2",
        ),
        <>
          <span aria-hidden="true" className="size-5 [&>svg]:size-5">
            {item.icon}
          </span>
          {item.label}
        </>,
      )}
    </li>
  );
  const mainItems = navItems.filter((i) => i.group !== "secondary" && i.group !== "team");
  const teamItems = navItems.filter((i) => i.group === "team");
  const secondaryItems = navItems.filter((i) => i.group === "secondary");

  return (
    <HeaderExtrasContext.Provider value={headerExtras ?? null}>
      <div className="min-h-dvh overflow-x-clip bg-bg text-ink">
        <a
          href="#main"
          className="sr-only z-50 rounded-control bg-surface px-4 py-2 font-semibold focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
        >
          {skipLinkLabel}
        </a>
        <div className="flex items-start gap-5 lg:p-5">
          <aside className="sticky top-5 hidden max-h-[calc(100dvh-2.5rem)] w-60 shrink-0 flex-col gap-5 overflow-y-auto rounded-card border border-border bg-surface px-3.5 py-5 lg:flex">
            <div className="px-2 py-1">{brand}</div>
            <nav aria-label={navLabel}>
              <ul className="flex flex-col gap-0.5">{mainItems.map(sideItem)}</ul>
              {teamItems.length > 0 ? (
                <>
                  <div aria-hidden="true" className="mx-2 my-2.5 h-px bg-border" />
                  {teamLabel === undefined ? null : (
                    <span
                      id="nav-team"
                      className="block px-3 pb-1 text-[11px] font-extrabold tracking-[0.08em] text-muted uppercase"
                    >
                      {teamLabel}
                    </span>
                  )}
                  <ul
                    aria-labelledby={teamLabel === undefined ? undefined : "nav-team"}
                    className="flex flex-col gap-0.5"
                  >
                    {teamItems.map(sideItem)}
                  </ul>
                </>
              ) : null}
              {secondaryItems.length > 0 ? (
                <>
                  <div aria-hidden="true" className="mx-2 my-2.5 h-px bg-border" />
                  <ul className="flex flex-col gap-0.5">{secondaryItems.map(sideItem)}</ul>
                </>
              ) : null}
            </nav>
            {/* Ngăn bằng vạch như các nhóm nav, không để khoảng trống lớn trước footer. */}
            {sidebarFooter ? (
              <div className="-mt-2.5 flex flex-col gap-2.5">
                <div aria-hidden="true" className="mx-2 h-px bg-border" />
                {sidebarFooter}
              </div>
            ) : null}
          </aside>
          <main
            id="main"
            tabIndex={-1}
            className="min-w-0 flex-1 px-4 pt-4 pb-[calc(6rem+env(safe-area-inset-bottom))] lg:p-0"
          >
            {children}
          </main>
        </div>
        <MobileBottomNav label={navLabel} nav={mobileNav ?? { items: navItems }} link={link} />
      </div>
    </HeaderExtrasContext.Provider>
  );
}

const tabClass = (current: boolean | undefined) =>
  cx(
    "flex min-h-12 flex-col items-center justify-center gap-[3px] px-1 text-[11px] whitespace-nowrap",
    current ? "font-bold text-accent" : "font-semibold text-muted",
  );

/** Bottom nav mobile (< 1024px). Nhãn không bao giờ bị cắt: tối đa 5 mục, phần còn lại ở "More". */
function MobileBottomNav({
  label,
  nav,
  link,
}: {
  label: string;
  nav: MobileNav;
  link: (item: NavItem, className: string, content: ReactNode) => ReactNode;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreCurrent = nav.more?.items.some((i) => i.current) ?? false;
  return (
    <nav
      aria-label={label}
      className="fixed inset-x-0 bottom-0 z-40 rounded-t-[26px] bg-surface px-2 pb-[calc(0.625rem+env(safe-area-inset-bottom))] shadow-float lg:hidden"
    >
      <ul className="flex h-[74px] items-center justify-around">
        {nav.items.map((item) => (
          <li key={item.key} className="min-w-14">
            {item.key === nav.featuredKey
              ? link(
                  item,
                  "-mt-[26px] flex flex-col items-center gap-1 text-[11px] font-bold text-ink",
                  <>
                    <span
                      aria-hidden="true"
                      className="flex size-[58px] items-center justify-center rounded-[20px] bg-accent text-white shadow-accent [&>svg]:size-[26px]"
                    >
                      {item.icon}
                    </span>
                    {item.label}
                  </>,
                )
              : link(
                  item,
                  tabClass(item.current),
                  <>
                    <span aria-hidden="true" className="[&>svg]:size-[22px]">
                      {item.icon}
                    </span>
                    {item.label}
                  </>,
                )}
          </li>
        ))}
        {nav.more ? (
          <li className="min-w-14">
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              className={cx(tabClass(moreCurrent), "w-full")}
              onClick={() => {
                setMoreOpen(true);
              }}
            >
              <span aria-hidden="true" className="[&>svg]:size-[22px]">
                {nav.more.icon}
              </span>
              {nav.more.label}
            </button>
            <BottomSheet open={moreOpen} onOpenChange={setMoreOpen} title={nav.more.label}>
              <ul className="flex flex-col gap-1">
                {nav.more.items.map((item) => (
                  <li key={item.key}>
                    {link(
                      item,
                      cx(
                        "flex min-h-tap items-center gap-3 rounded-control px-3 text-sm",
                        item.current
                          ? "bg-accent font-bold text-white"
                          : "font-semibold text-ink-2 hover:bg-surface-2",
                      ),
                      <>
                        <span aria-hidden="true" className="size-5 [&>svg]:size-5">
                          {item.icon}
                        </span>
                        {item.label}
                      </>,
                    )}
                  </li>
                ))}
              </ul>
              {nav.more.footer === undefined ? null : (
                <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
                  {nav.more.footer}
                </div>
              )}
            </BottomSheet>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
