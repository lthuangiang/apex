"use client";

import { botDraftViewSchema, UserRole, type BotDraftView } from "@drift/shared";
import { EmptyState } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { WorkspaceShell } from "@/components/workspace-shell";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/queries";

import { fromConfig, isLaunched, type FormValues } from "../fields";

// Bản nháp từ Claude qua MCP (DEC-167, DEC-223): `?draft=<id>` trên màn Create / Edit. Chỉ điền sẵn form;
// người dùng vẫn tự Save / Apply / Start theo luồng thường (kể cả "Before it starts"). Bản nháp hết hạn / không tồn
// tại / của người khác / bot đã archive: cùng một câu, không lộ là có tồn tại.

export interface FromClaude {
  values: FormValues;
  name: string | null;
  expiresAt: string;
}

export function useClaudeDraft(id: string | undefined) {
  return useQuery({
    queryKey: ["claude-draft", id],
    queryFn: () => api("GET", `/api/v1/drafts/${id ?? ""}`, botDraftViewSchema),
    enabled: id !== undefined,
    retry: false,
    staleTime: Infinity,
  });
}

export const fromClaudeOf = (strategy: string, d: BotDraftView): FromClaude | null =>
  isLaunched(strategy) && d.strategy === strategy
    ? { values: fromConfig(strategy, d.config), name: d.name, expiresAt: d.expiresAt }
    : null;

const CHIP =
  "inline-flex flex-none items-center rounded-full bg-accent-tint px-2 py-0.5 text-[11px] font-extrabold whitespace-nowrap text-accent-ink";

/** Banner trên form: chip "From Claude", câu nhắc chưa có gì thay đổi, giờ hết hạn theo múi giờ của người dùng. */
export function ClaudeDraftBanner({ expiresAt }: { expiresAt: string }) {
  const t = useTranslations("botDraft");
  const me = useMe();
  return (
    <section
      aria-label={t("chip")}
      className="flex flex-col gap-1 rounded-card bg-accent-tint/40 px-4 py-3 text-sm"
    >
      <p className="m-0 flex flex-wrap items-center gap-2 text-ink">
        <span className={CHIP}>{t("chip")}</span>
        {t("body")}
      </p>
      <p className="m-0 text-[13px] text-ink-2">
        {t("expires", { time: formatDateTime(expiresAt, me.data?.timezone) })}
      </p>
    </section>
  );
}

/** Bản nháp không mở được. */
export function ClaudeDraftGone() {
  const t = useTranslations("botDraft");
  const me = useMe();
  return (
    <WorkspaceShell current="bots" isTeam={me.data?.role === UserRole.team}>
      <EmptyState
        title={t("gone")}
        action={
          <Link href="/bots" className="text-sm font-bold">
            {t("openLab")}
          </Link>
        }
      />
    </WorkspaceShell>
  );
}
