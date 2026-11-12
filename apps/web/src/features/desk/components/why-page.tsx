"use client";

import { assetOf, suggestionViewSchema } from "@drift/shared";
import { Button, Skeleton } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

import { willParams } from "../plain";

import { plainQuote, useStartPaper, useStartPaperError } from "./recommended";

// AI Desk › Why this one (AI_DESK_RECOMMENDED.md mục 6): hiện đúng dữ liệu đã lưu của lần đề xuất này, không tính lại,
// nên số trên thẻ và trên trang luôn khớp. Không hiện backtest ở bản đầu (DEC-105).

export function WhyPage({ id }: { id: string }) {
  const t = useTranslations("desk");
  const tc = useTranslations("createBot.strategies");
  const te = useTranslations("common.errors");
  const q = useQuery({
    queryKey: ["suggestion", id],
    queryFn: () => api("GET", `/api/v1/reco/suggestions/${id}`, suggestionViewSchema),
  });
  const start = useStartPaper();
  const errorText = useStartPaperError();
  const s = q.data;
  const name =
    s === undefined ? "" : `${tc(`${s.strategy}.name` as "spot_grid.name")} · ${assetOf(s.market)}`;
  const k = (s?.strategy ?? "spot_grid") as "spot_grid";
  const will = s === undefined ? null : willParams(s.strategy, s.values, s.capital);
  const pct = s?.maxDrop === "unsure" ? "5" : s?.maxDrop;

  return (
    <Workspace current="desk">
      <div className="flex flex-col gap-5">
        <Link href="/desk" className="self-start text-sm font-bold text-accent-ink">
          ← {t("why.back")}
        </Link>
        {q.isPending ? <Skeleton className="h-64 w-full rounded-card" /> : null}
        {q.isError ? (
          <p role="alert" className="m-0">
            {q.error instanceof ApiError && q.error.code === "NOT_FOUND"
              ? t("why.notFound")
              : te("generic")}
          </p>
        ) : null}
        {s === undefined ? null : (
          <>
            <PageHead
              title={t("why.title", { name })}
              subtitle={t("why.subtitle", { time: formatDateTime(s.computedAt) })}
            />
            <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-2">
              <Card title={t("why.fits")}>
                <ul className="m-0 flex flex-col gap-1.5 pl-4 text-sm">
                  {s.reasons.map((r) => (
                    <li key={r}>{plainQuote(r)}</li>
                  ))}
                  {pct === undefined || pct === null ? null : (
                    <li>{t("why.lossChosen", { pct })}</li>
                  )}
                  {s.notes.map((n) => (
                    <li key={n} className="text-ink-2">
                      {n}
                    </li>
                  ))}
                </ul>
              </Card>
              <Card title={t("why.market")}>
                <p className="m-0 text-sm">{plainQuote(s.basis)}</p>
              </Card>
              <Card title={t("why.will")}>
                <p className="m-0 text-sm leading-relaxed">
                  {will === null ? null : `${t(`will.${k}`, will)} `}
                  {t("will.computed", { time: formatDateTime(s.computedAt) })}
                </p>
              </Card>
              <Card title={t("why.notChosen")}>
                {s.notSuggested.length === 0 ? (
                  <p className="m-0 text-sm text-ink-2">{t("why.nothingElse")}</p>
                ) : (
                  <ul className="m-0 flex flex-col gap-1.5 pl-4 text-sm">
                    {s.notSuggested.map((n) => (
                      <li key={`${n.title}${n.reason}`}>
                        <strong>{n.title}</strong>: {plainQuote(n.reason)}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title={t("why.whenLoses")} className="lg:col-span-2">
                <p className="m-0 text-sm">
                  {t(`strategy.${k}.lose`)} {t("why.noPromise")}
                </p>
              </Card>
            </div>
            {start.error === null ? null : (
              <p role="alert" className="m-0 text-sm text-neg-ink">
                {errorText(start.error)}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                pending={start.isPending}
                onClick={() => {
                  start.mutate(s);
                }}
              >
                {start.isPending ? t("card.trying") : t("card.try")}
              </Button>
              <Link
                href={`/bots/new/${s.strategy}?suggestion=${s.id}`}
                className="text-sm font-bold text-accent-ink"
              >
                {t("why.selfSetup")}
              </Link>
              {s.inputsVersion === null ? null : (
                <span className="text-xs text-muted">
                  {t("why.rules", { version: s.inputsVersion })}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </Workspace>
  );
}
