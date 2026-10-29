"use client";

import { botDetailSchema, BotState, UserRole } from "@drift/shared";
import { Button, ConfirmDialog } from "@drift/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { PageHead } from "@/components/workspace";
import { WorkspaceShell } from "@/components/workspace-shell";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/queries";

import { FIELDS, fromConfig, isLaunched, toConfig, type FormValues } from "../fields";

import { AiPanel, useAiParameters } from "./ai-params";
import { fieldErrorsOf, useBotErrorText } from "./bot-errors";
import { BotForm } from "./bot-form";

// Edit bot (SCREENS.md mục 8.4, artboard "Bot-Edit"): thay đổi lưu thành version mới; version cũ chạy
// tiếp cho tới khi engine xác nhận version mới (DOMAIN.md mục 7.4). Strategy/market bị khoá.

const versionAck = z.object({ version: z.number(), status: z.string() });

export function BotEdit({ botId }: { botId: string }) {
  const t = useTranslations("botEdit");
  const ts = useTranslations("states");
  const tf = useTranslations("createBot");
  const qc = useQueryClient();
  const me = useMe();
  const [waitingFor, setWaitingFor] = useState<number | null>(null);
  const detail = useQuery({
    queryKey: ["bot", botId],
    queryFn: () => api("GET", `/api/v1/bots/${botId}`, botDetailSchema),
    refetchInterval: waitingFor === null ? false : 1_000,
  });
  const errorText = useBotErrorText();
  const [values, setValues] = useState<FormValues | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [aiInfo, setAiInfo] = useState<RetuneInfo>({ paramSource: "manual", sources: {} });
  const key = useRef(crypto.randomUUID());

  const bot = detail.data?.bot;
  const active = detail.data?.versions.find((v) => v.status === "active");
  const strategy = bot !== undefined && isLaunched(bot.strategy) ? bot.strategy : undefined;
  const base =
    strategy !== undefined && active !== undefined ? fromConfig(strategy, active.config) : null;
  useEffect(() => {
    if (values === null && base !== null) setValues(base);
  }, [values, base]);

  const live = waitingFor !== null && active !== undefined && active.version >= waitingFor;
  const apply = useMutation({
    mutationFn: () => {
      if (strategy === undefined || values === null) throw new Error("not ready");
      return api("POST", `/api/v1/bots/${botId}/versions`, versionAck, {
        idempotencyKey: key.current,
        body: {
          paramSource: aiInfo.paramSource,
          ...(aiInfo.suggestionId === undefined ? {} : { aiSuggestionId: aiInfo.suggestionId }),
          config: toConfig(strategy, values),
        },
      });
    },
    onSuccess: async (r) => {
      key.current = crypto.randomUUID();
      setConfirm(false);
      setWaitingFor(r.version);
      await qc.invalidateQueries({ queryKey: ["bot", botId] });
    },
    onError: () => {
      key.current = crypto.randomUUID();
    },
  });

  if (
    bot === undefined ||
    strategy === undefined ||
    active === undefined ||
    values === null ||
    base === null
  ) {
    return (
      <WorkspaceShell current="bots" isTeam={me.data?.role === UserRole.team}>
        {null}
      </WorkspaceShell>
    );
  }
  const next = Math.max(...(detail.data?.versions.map((v) => v.version) ?? [active.version])) + 1;
  const before = toConfig(strategy, base);
  const after = toConfig(strategy, values);
  const changes = FIELDS[strategy].filter(
    (f) => JSON.stringify(before[f.key]) !== JSON.stringify(after[f.key]),
  );
  const isDraft = bot.state === BotState.draft;
  const label = (k: string) =>
    tf(`fields.${FIELDS[strategy].find((f) => f.key === k)?.label ?? k}.label`);

  return (
    <WorkspaceShell current="bots" isTeam={me.data?.role === UserRole.team}>
      <div className="flex flex-col gap-5">
        <Link href={isDraft ? "/bots" : `/agent/${botId}`} className="text-sm font-bold">
          {tf("back")}
        </Link>
        <PageHead
          title={t("title", { name: bot.name })}
          subtitle={t("sub", { state: ts(bot.state), version: active.version, next })}
        />
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section
            aria-labelledby="change-title"
            className="flex flex-col gap-4 rounded-card bg-surface p-5"
          >
            <h2 id="change-title" className="m-0 text-lg font-extrabold">
              {t("changeable")}
            </h2>
            <BotForm
              strategy={strategy}
              values={values}
              errors={fieldErrorsOf(apply.error)}
              lockedReason={t("lockedHint")}
              disabled={waitingFor !== null && !live}
              onChange={setValues}
              sources={aiInfo.sources}
            />
            <h2 className="m-0 text-lg font-extrabold">{t("locked")}</h2>
            <dl className="m-0 flex flex-col gap-1">
              <div className="flex justify-between gap-2">
                <dt className="text-sm text-ink-2">{tf("paramsTitle")}</dt>
                <dd className="m-0 text-sm font-bold">{tf(`strategies.${strategy}.name`)}</dd>
              </div>
              {FIELDS[strategy]
                .filter((f) => f.locked === true)
                .map((f) => (
                  <div key={f.key} className="flex justify-between gap-2">
                    <dt className="text-sm text-ink-2">{label(f.key)}</dt>
                    <dd className="m-0 text-sm font-bold">{JSON.stringify(before[f.key] ?? "")}</dd>
                  </div>
                ))}
            </dl>
            <p className="m-0 text-xs text-muted">{t("lockedHint")}</p>
          </section>
          <aside
            aria-labelledby="diff-title"
            className="flex flex-col gap-3 self-start rounded-card bg-surface p-5"
          >
            <RetuneBox
              strategy={strategy}
              values={values}
              setValues={setValues}
              onInfo={setAiInfo}
            />
            <h2 id="diff-title" className="m-0 text-lg font-extrabold">
              {t("changes", { version: active.version, next })}
            </h2>
            {changes.length === 0 ? (
              <p className="m-0 text-sm text-ink-2">{t("noChanges")}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {changes.map((f) => (
                  <li key={f.key} className="text-sm">
                    {label(f.key)}: <s>{JSON.stringify(before[f.key] ?? "")}</s> →{" "}
                    <strong>{JSON.stringify(after[f.key] ?? "")}</strong>
                  </li>
                ))}
              </ul>
            )}
            {isDraft ? null : (
              <>
                <h3 className="m-0 text-sm font-bold">{t("whatHappens")}</h3>
                <p className="m-0 text-sm text-ink-2">{t("applyEffect")}</p>
              </>
            )}
            <div role="status" aria-live="polite">
              {waitingFor === null ? null : live ? (
                <strong>{t("live", { next: waitingFor })}</strong>
              ) : (
                <span>{t("applying", { next: waitingFor })}</span>
              )}
            </div>
            {apply.error === null ? null : (
              <p role="alert" className="m-0 text-sm text-neg-ink">
                {errorText(apply.error)}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={changes.length === 0}
                onClick={() => {
                  setValues(base);
                }}
              >
                {t("discard")}
              </Button>
              <Button
                disabled={changes.length === 0 || (waitingFor !== null && !live)}
                onClick={() => {
                  if (live) setWaitingFor(null);
                  setConfirm(true);
                }}
              >
                {t("review", { next })}
              </Button>
            </div>
            {isDraft ? (
              <Link href={`/agent/${botId}`} className="font-bold">
                {tf("beforeStart.start")}
              </Link>
            ) : null}
            <h3 className="m-0 mt-2 text-sm font-bold">{t("history")}</h3>
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
              {detail.data?.versions.map((v) => (
                <li key={v.id}>
                  v{v.version} · {v.status} · {formatDateTime(v.appliedAt ?? v.createdAt)}
                </li>
              ))}
            </ul>
          </aside>
        </div>
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={t("dialog.title", { next, name: bot.name })}
          consequencesLabel={t("whatHappens")}
          consequences={[
            ...changes.map(
              (f) =>
                `${label(f.key)}: ${JSON.stringify(before[f.key] ?? "")} → ${JSON.stringify(after[f.key] ?? "")}`,
            ),
            ...(isDraft ? [] : [t("applyEffect")]),
          ]}
          confirmLabel={t("dialog.apply", { next })}
          cancelLabel={t("dialog.keep", { version: active.version })}
          pending={apply.isPending}
          onConfirm={() => {
            apply.mutate();
          }}
        />
      </div>
    </WorkspaceShell>
  );
}

interface RetuneInfo {
  paramSource: "ai" | "ai_edited" | "manual";
  suggestionId?: string;
  sources: Record<string, "ai" | "edited">;
}

/** "Retune with AI": chỉ ghi đè field sửa được; khác biệt hiện ở panel diff trước khi apply. */
function RetuneBox({
  strategy,
  values,
  setValues,
  onInfo,
}: {
  strategy: keyof typeof FIELDS;
  values: FormValues;
  setValues: (v: FormValues) => void;
  onInfo: (i: RetuneInfo) => void;
}) {
  const editable = useCallback(
    (k: string) => !FIELDS[strategy].some((f) => f.key === k && f.locked === true),
    [strategy],
  );
  const ai = useAiParameters({
    strategy,
    values,
    setValues,
    context: "retune",
    auto: false,
    editable,
  });
  const { paramSource, suggestion, mode } = ai.state;
  const sourcesKey = JSON.stringify(ai.state.sources);
  useEffect(() => {
    onInfo({
      paramSource,
      ...(mode === "ai" && suggestion !== null ? { suggestionId: suggestion.id } : {}),
      sources: JSON.parse(sourcesKey) as Record<string, "ai" | "edited">,
    });
  }, [paramSource, mode, suggestion, sourcesKey, onInfo]);
  return <AiPanel ai={ai} retune />;
}
