import type { ReactNode } from "react";

import { cx } from "../lib/cx";

import { ShellHeaderExtras } from "./app-shell";

export interface PageHeaderProps {
  title: string;
  description?: string;
  /** Badge cạnh tiêu đề, ví dụ LiveBadge, ComingSoonChip. */
  badges?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, badges, actions, className }: PageHeaderProps) {
  return (
    <header className={cx("flex flex-wrap items-start justify-between gap-4", className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-extrabold text-ink">{title}</h1>
          {badges}
        </div>
        {description ? <p className="text-sm text-ink-2">{description}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        {actions}
        <ShellHeaderExtras />
      </div>
    </header>
  );
}
