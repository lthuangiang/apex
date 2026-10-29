"use client";

import { UserRole } from "@drift/shared";
import { ShellHeaderExtras } from "@drift/ui";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { useMe } from "@/lib/queries";

import {
  FullClusterContext,
  MobileLiveChip,
  MobileSodexStatus,
  PageUpdatedContext,
  type PageUpdated,
  WorkspaceShell,
} from "./workspace-shell";

/** WorkspaceShell kèm role người dùng (Builder Revenue chỉ hiện với `team`). */
export function Workspace({
  current,
  children,
}: {
  current: ComponentProps<typeof WorkspaceShell>["current"];
  children: ReactNode;
}) {
  const me = useMe();
  return (
    <WorkspaceShell current={current} isTeam={me.data?.role === UserRole.team}>
      {children}
    </WorkspaceShell>
  );
}

/**
 * Hàng tiêu đề của mọi trang workspace: tiêu đề + mô tả bên trái (co lại, mô tả tự xuống dòng), cụm trạng
 * thái bên phải cùng hàng; chỉ xuống dòng khi thật sự thiếu chỗ (UI_REVIEW E1.1). `action` (ví dụ "+ New
 * bot") đứng cuối cụm như artboard.
 */
export function PageHead({
  title,
  subtitle,
  updated,
  action,
  full = false,
  back,
}: {
  title: string;
  subtitle: string;
  updated?: PageUpdated | null;
  action?: ReactNode;
  /** Cụm trạng thái đầy đủ (chỉ Overview, artboard Main). */
  full?: boolean;
  /** Nút ← trên mobile (artboard Mobile-Agent). */
  back?: { href: string; label: string };
}) {
  return (
    <header className="flex flex-col gap-3">
      {/* Mobile (artboard Mobile-Home, M-Portfolio): một hàng tiêu đề + chip LIVE, dòng trạng thái SoDEX. */}
      <div className="flex flex-col gap-1 lg:hidden">
        <div className="flex items-center justify-between gap-3">
          {back === undefined ? null : (
            <Link
              href={back.href}
              aria-label={back.label}
              className="-ml-2.5 flex size-11 flex-none items-center justify-center text-ink"
            >
              <ArrowLeft aria-hidden="true" size={22} />
            </Link>
          )}
          <h1 className="m-0 min-w-0 flex-1 text-2xl font-extrabold">{title}</h1>
          <MobileLiveChip />
        </div>
        <MobileSodexStatus />
        {action === undefined ? null : <div className="mt-2 flex">{action}</div>}
      </div>
      <div className="hidden flex-wrap items-center justify-between gap-x-4 gap-y-3 lg:flex">
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
          <h1 className="m-0 text-[28px] font-extrabold">{title}</h1>
          <p className="m-0 text-sm text-ink-2">{subtitle}</p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2.5">
          <FullClusterContext.Provider value={full}>
            <PageUpdatedContext.Provider value={updated ?? null}>
              <ShellHeaderExtras />
            </PageUpdatedContext.Provider>
          </FullClusterContext.Provider>
          {action}
        </div>
      </div>
    </header>
  );
}

export function Card({
  title,
  children,
  className = "",
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={`flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-5 ${className}`}
    >
      {title === undefined ? null : <h2 className="m-0 text-lg font-extrabold">{title}</h2>}
      {children}
    </section>
  );
}
