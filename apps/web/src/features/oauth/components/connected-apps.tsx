"use client";

import { connectedAppsSchema, type McpScope } from "@drift/shared";
import { Button, ConfirmDialog, EmptyState, ErrorState, Skeleton } from "@drift/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { z } from "zod";

import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

// Settings › Connected apps (docs/MCP.md mục 4, DEC-167): app AI đã được cho phép đọc dữ liệu DeskLabs qua MCP.
// Revoke từng app có hiệu lực ngay (MCP kiểm tra token mỗi request).

const KEY = ["oauth", "apps"] as const;

export function ConnectedApps() {
  const t = useTranslations("oauth.apps");
  const ts = useTranslations("oauth.scopes");
  const te = useTranslations("common.errors");
  const qc = useQueryClient();
  const apps = useQuery({
    queryKey: KEY,
    queryFn: () => api("GET", "/api/v1/oauth/apps", connectedAppsSchema),
  });
  const [pending, setPending] = useState<{ clientId: string; label: string } | null>(null);
  const key = useRef(crypto.randomUUID());
  const revoke = useMutation({
    mutationFn: (clientId: string) =>
      api("DELETE", `/api/v1/oauth/apps/${encodeURIComponent(clientId)}`, z.null(), {
        idempotencyKey: key.current,
      }),
    onSuccess: async () => {
      key.current = crypto.randomUUID();
      setPending(null);
      await qc.invalidateQueries({ queryKey: KEY });
    },
  });
  const scopeText = (s: McpScope) => ts(s === "team:read" ? "team" : s);

  return (
    <section aria-labelledby="connected-apps" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="connected-apps" className="m-0 text-lg font-extrabold">
          {t("title")}
        </h2>
        <p className="m-0 text-sm text-ink-2">{t("body")}</p>
      </div>
      {apps.isPending ? (
        <Skeleton className="h-24 w-full rounded-card" />
      ) : apps.isError ? (
        <ErrorState
          title={te("generic")}
          retryLabel={te("retry")}
          onRetry={() => {
            void apps.refetch();
          }}
        />
      ) : apps.data.items.length === 0 ? (
        // Lối vào trang hướng dẫn /claude (MCP M6, W7; mockup docs/mockups/mcp-guide/ConnectedApps.dc.html).
        <EmptyState
          title={t("empty")}
          description={t("emptyBody")}
          action={
            <Link
              href="/claude"
              className="inline-flex min-h-tap items-center rounded-control bg-accent px-4 text-sm font-bold text-white no-underline hover:bg-accent-ink"
            >
              {t("howTo")}
            </Link>
          }
        />
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {apps.data.items.map((a) => {
              const label = a.name ?? t("unnamed");
              return (
                <li
                  key={a.clientId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-bold text-ink">
                      {label} <span className="font-mono text-xs text-muted">{a.host}</span>
                    </span>
                    <span className="text-xs text-ink-2">
                      {a.scopes.map(scopeText).join(" · ")}
                    </span>
                    <span className="text-xs text-muted">
                      {a.lastUsedAt === null
                        ? t("neverUsed", { date: formatDateTime(a.connectedAt) })
                        : t("lastUsed", { date: formatDateTime(a.lastUsedAt) })}
                    </span>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setPending({ clientId: a.clientId, label });
                    }}
                  >
                    {t("revoke")}
                  </Button>
                </li>
              );
            })}
          </ul>
          <Link href="/claude" className="self-start text-sm font-bold text-accent-ink">
            {t("howToLink")}
          </Link>
        </>
      )}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={t("confirmTitle", { app: pending?.label ?? "" })}
        consequencesLabel={t("confirmWhat")}
        consequences={[t("confirmBody")]}
        confirmLabel={t("revoke")}
        cancelLabel={t("cancel")}
        tone="danger"
        pending={revoke.isPending}
        {...(revoke.isError ? { error: t("error") } : {})}
        onConfirm={() => {
          if (pending !== null) revoke.mutate(pending.clientId);
        }}
      />
    </section>
  );
}
