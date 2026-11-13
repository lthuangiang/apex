"use client";

import { oauthConsentInfoSchema, oauthDecisionSchema, type McpScope } from "@drift/shared";
import { Button, ErrorState, Skeleton } from "@drift/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { z } from "zod";

import { api, ApiError } from "@/lib/api";

// Màn consent OAuth cho MCP (docs/MCP.md mục 4, DEC-167, DEC-TBD-mcp-oauth). api kiểm tra tham số trước; tên client do
// client tự khai nên chỉ hiện kèm host (không logo, không link từ client). Chưa kết nối SoDEX thì không cấp read / draft.

const infoView = z.union([
  z.object({ consent: oauthConsentInfoSchema }),
  z.object({ redirect: z.string() }),
]);

const PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "resource",
  "scope",
  "state",
] as const;

export function ConsentPage() {
  const t = useTranslations("oauth");
  const search = useSearchParams();
  const params = useMemo(() => {
    const out: Record<string, string> = {};
    for (const k of PARAMS) {
      const v = search.get(k);
      if (v !== null) out[k] = v;
    }
    return out;
  }, [search]);
  const info = useQuery({
    queryKey: ["oauth", "authorize", params],
    queryFn: () =>
      api("GET", `/api/v1/oauth/authorize?${new URLSearchParams(params).toString()}`, infoView),
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (allow: boolean) =>
      api("POST", "/api/v1/oauth/authorize", oauthDecisionSchema, { body: { ...params, allow } }),
    onSuccess: (r) => {
      window.location.assign(r.redirect);
    },
  });

  if (info.isPending) return <Skeleton className="h-72 w-full rounded-card" />;
  if (info.isError) {
    if (info.error instanceof ApiError && info.error.code === "UNAUTHENTICATED") {
      window.location.assign(
        `/signin?next=${encodeURIComponent(`/oauth/authorize?${new URLSearchParams(params).toString()}`)}`,
      );
      return <Skeleton className="h-72 w-full rounded-card" />;
    }
    return <ErrorState title={t("invalid.title")} description={t("invalid.body")} />;
  }
  if ("redirect" in info.data) {
    // Lỗi đã kiểm tra (scope, PKCE, resource…): trả về client theo đặc tả, kèm `error`.
    window.location.assign(info.data.redirect);
    return <Skeleton className="h-72 w-full rounded-card" />;
  }
  const c = info.data.consent;
  const scopeText = (s: McpScope) => t(`scopes.${s === "team:read" ? "team" : s}`);
  const canAllow = c.scopes.length > 0;
  return (
    <section aria-labelledby="oauth-title" className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 id="oauth-title" className="m-0 text-2xl font-extrabold">
          {t("title")}
        </h1>
        <p className="m-0 text-sm text-ink-2">
          {/* Tên client là dữ liệu không tin cậy: luôn đi kèm host thật. */}
          {t.rich("asks", {
            client: () => <strong className="text-ink">{c.client.name ?? t("unnamed")}</strong>,
            host: () => <span className="font-mono text-ink">{c.client.host}</span>,
          })}
        </p>
      </div>
      {c.needsSodex ? (
        <p role="status" className="m-0 rounded-card bg-warn-bg p-4 text-sm text-ink">
          <strong>{t("needsSodex.title")}</strong> {t("needsSodex.body")}{" "}
          <Link href="/onboarding/connect" className="font-bold text-accent-ink">
            {t("needsSodex.cta")}
          </Link>
        </p>
      ) : null}
      {canAllow ? (
        <div className="flex flex-col gap-2">
          <h2 className="m-0 text-sm font-extrabold text-ink-2">{t("willAllow")}</h2>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm text-ink">
            {c.scopes.map((s) => (
              <li key={s}>{scopeText(s)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {c.denied.length > 0 && !c.needsSodex ? (
        <p className="m-0 text-xs text-muted">
          {t("notGranted", { list: c.denied.map(scopeText).join(", ") })}
        </p>
      ) : null}
      <p className="m-0 rounded-card bg-surface-2 p-4 text-sm text-ink">{t("promise")}</p>
      {decide.isError ? (
        <p role="alert" className="m-0 text-sm text-neg-ink">
          {t("error")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={!canAllow || decide.isPending}
          pending={decide.isPending && decide.variables}
          onClick={() => {
            decide.mutate(true);
          }}
        >
          {t("allow")}
        </Button>
        <Button
          variant="secondary"
          disabled={decide.isPending}
          onClick={() => {
            decide.mutate(false);
          }}
        >
          {t("deny")}
        </Button>
      </div>
      <p className="m-0 text-xs text-muted">{t("revokeHint")}</p>
    </section>
  );
}
