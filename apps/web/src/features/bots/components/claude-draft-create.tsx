"use client";

import { UserRole } from "@drift/shared";
import { Skeleton } from "@drift/ui";

import { WorkspaceShell } from "@/components/workspace-shell";
import { useMe } from "@/lib/queries";

import { isLaunched } from "../fields";

import { ClaudeDraftGone, fromClaudeOf, useClaudeDraft } from "./claude-draft";
import { CreateBot } from "./create-bot";

// `/bots/new/:strategy?draft=` (DEC-TBD-mcp-drafts): tải bản nháp từ Claude rồi mở màn Create có sẵn, điền sẵn.

export function ClaudeDraftLoading() {
  const me = useMe();
  return (
    <WorkspaceShell current="bots" isTeam={me.data?.role === UserRole.team}>
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    </WorkspaceShell>
  );
}

/** `/bots/new/:strategy?draft=`: bản nháp bot mới. */
export function ClaudeDraftCreate({ strategy, draftId }: { strategy: string; draftId: string }) {
  const q = useClaudeDraft(draftId);
  if (q.isPending) return <ClaudeDraftLoading />;
  const from = q.data?.botId === null ? fromClaudeOf(strategy, q.data) : null;
  if (from === null || !isLaunched(strategy)) return <ClaudeDraftGone />;
  return <CreateBot strategy={strategy} fromClaude={from} />;
}
