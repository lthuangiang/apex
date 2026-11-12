"use client";

import { botSummarySchema, goLiveViewSchema, type GoLiveView } from "@drift/shared";
import { Button, inputClassName, Skeleton } from "@drift/ui";
import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { useBotErrorText } from "@/features/bots/components/bot-errors";
import {
  CheckList,
  leverageWarning,
  useDryRunChecks,
} from "@/features/bots/components/start-checks";
import { fromConfig, isLaunched, type FIELDS } from "@/features/bots/fields";
import { api, ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { useTwoFactorNeeded } from "@/lib/queries";

import { usePaperView } from "./paper-view";

// AI Desk › Use real money (AI_DESK_RECOMMENDED.md mục 9, DEC-105): tính lại tham số bằng `aiParameters()` với giá hiện
// tại, nêu rõ thay đổi, kiểm tra như luồng Start (dry run), xác nhận + 2FA. Tạo một bot MỚI `live` (không đổi `mode` của
// bot paper), rồi dừng bài thử; kết quả thử vẫn giữ lại. Bot paper không bao giờ thành bot thật.

type Strategy = keyof typeof FIELDS;

const LIVE_WARN_DAYS = 30;

function Body({ view, paperId, day }: { view: GoLiveView; paperId: string; day: number }) {
  const t = useTranslations("desk.golive");
  const tc = useTranslations("createBot");
  const router = useRouter();
  const errorText = useBotErrorText();
  const strategy = view.strategy as Strategy;
  const config = view.live?.values ?? view.paperConfig;
  const values = fromConfig(strategy, config);
  const dry = useDryRunChecks(strategy, values);
  const checks = dry.query.data;
  const levWarn = leverageWarning(checks);
  const [ack, setAck] = useState(false);
  const [levAck, setLevAck] = useState(false);
  const [code, setCode] = useState("");
  const twoFactorPrompt = useTwoFactorNeeded();
  const created = useRef<string | null>(null);
  const keys = useRef({ create: crypto.randomUUID(), start: crypto.randomUUID() });
  const start = useMutation({
    mutationFn: async () => {
      if (created.current === null) {
        const bot = await api("POST", "/api/v1/bots", botSummarySchema, {
          idempotencyKey: keys.current.create,
          body: {
            strategy,
            name: view.name,
            config,
            paramSource: "ai",
            ...(view.live === null ? {} : { aiSuggestionId: view.live.id }),
          },
        });
        created.current = bot.id;
      }
      const id = created.current;
      await api("POST", `/api/v1/bots/${id}/actions/start`, botSummarySchema, {
        idempotencyKey: keys.current.start,
        body: {
          acknowledged: true,
          ...(code.trim() === "" ? {} : { twoFactorCode: code.trim() }),
        },
      });
      // Bài thử dừng sau khi bot thật đã được nhận; lỗi ở bước này không chặn bot thật.
      await api("POST", `/api/v1/bots/${paperId}/actions/stop`, botSummarySchema, {
        idempotencyKey: crypto.randomUUID(),
        body: {},
      }).catch(() => null);
      return id;
    },
    onSuccess: (id) => {
      router.push(`/agent/${id}`);
    },
    onError: () => {
      keys.current.start = crypto.randomUUID();
    },
  });
  // Ô mã 2FA chỉ hiện khi đã bật 2FA mà phiên chưa được tin trong 2 giờ qua (DEC-115).
  const twoFactorNeeded =
    twoFactorPrompt ||
    (start.error instanceof ApiError && start.error.code === "TWO_FACTOR_REQUIRED");
  const ready =
    dry.valid &&
    checks?.allOk === true &&
    ack &&
    (levWarn === null || levAck) &&
    (!twoFactorNeeded || /^\d{6}$|^[A-Za-z0-9-]{8,11}$/.test(code.trim()));
  const editHref = `/bots/new/${view.strategy}${view.live === null ? "" : `?suggestion=${view.live.id}`}`;

  return (
    <>
      {day < LIVE_WARN_DAYS ? (
        <p className="m-0 rounded-[14px] border border-warn-bar bg-warn-bg px-4 py-3 text-sm text-warn">
          {t("under30", { day })}
        </p>
      ) : null}
      <Card title={t("changes")}>
        <p className="m-0 text-sm text-ink-2">
          {view.live === null ? t("noRecalc") : view.changes.length === 0 ? t("same") : t("moved")}
        </p>
        <div className="max-w-full overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th scope="col" className="py-2 pr-4 font-semibold">
                  {t("setting")}
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  {t("inTest")}
                </th>
                <th scope="col" className="py-2 font-semibold">
                  {t("real")}
                </th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {view.changes.map((c) => (
                <tr key={c.key} className="border-t border-border">
                  <th scope="row" className="py-2 pr-4 text-left font-semibold">
                    {isLaunched(strategy) ? labelOf(tc, c.key) : c.key}
                  </th>
                  <td className="py-2 pr-4">{c.from ?? "—"}</td>
                  <td className="py-2 font-bold">{c.to ?? "—"}</td>
                </tr>
              ))}
              <tr className="border-t border-border">
                <th scope="row" className="py-2 pr-4 text-left font-semibold">
                  {t("capital")}
                </th>
                <td className="py-2 pr-4">
                  {t("capitalFake", { capital: formatMoney(view.capital) ?? view.capital })}
                </td>
                <td className="py-2 font-bold">
                  {t("capitalReal", { capital: formatMoney(view.capital) ?? view.capital })}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <Link href={editHref} className="self-start text-sm font-bold text-accent-ink">
          {t("edit")}
        </Link>
      </Card>
      <Card title={t("checks")}>
        {checks === undefined ? (
          <p className="m-0 text-sm text-ink-2">{t("checking")}</p>
        ) : (
          <CheckList checks={checks} engine={view.market.includes("_") ? "spot" : "perps"} />
        )}
      </Card>
      <Card title={t("confirm")}>
        {levWarn === null ? null : (
          <label className="flex cursor-pointer items-start gap-3 rounded-[14px] border border-warn-bar bg-warn-bg px-4 py-3.5 text-sm text-warn">
            <input
              type="checkbox"
              className="mt-px size-5 flex-none accent-accent"
              checked={levAck}
              onChange={() => {
                setLevAck(!levAck);
              }}
            />
            <span>{tc("beforeStart.leverageAck", { market: levWarn.market ?? "" })}</span>
          </label>
        )}
        <label className="flex cursor-pointer items-start gap-3 rounded-[14px] border-[1.5px] border-border-input px-4 py-3.5 text-sm leading-[1.45]">
          <input
            type="checkbox"
            className="mt-px size-5 flex-none accent-accent"
            checked={ack}
            onChange={() => {
              setAck(!ack);
            }}
          />
          <span>{t("ack")}</span>
        </label>
        {twoFactorNeeded ? (
          <label className="flex max-w-[280px] flex-col gap-1 text-sm">
            <span className="font-semibold">{t("code")}</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              className={inputClassName}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
              }}
            />
          </label>
        ) : null}
        {start.error === null ? null : (
          <p role="alert" className="m-0 text-sm text-neg-ink">
            {t("failed", { reason: errorText(start.error) })}
          </p>
        )}
        <div>
          <Button
            pending={start.isPending}
            disabled={!ready}
            onClick={() => {
              start.mutate();
            }}
          >
            {start.isPending ? t("starting") : t("start")}
          </Button>
        </div>
        <p className="m-0 text-xs text-muted">{t("after")}</p>
      </Card>
    </>
  );
}

/** Nhãn field theo `createBot.fields`; field không có nhãn thì giữ tên key. */
function labelOf(tc: ReturnType<typeof useTranslations<"createBot">>, key: string): string {
  const k = `fields.${key}.label` as "fields.investment.label";
  return tc.has(k) ? tc(k) : key;
}

export function GoLivePage({ id }: { id: string }) {
  const t = useTranslations("desk.golive");
  const td = useTranslations("desk");
  const te = useTranslations("common.errors");
  const paper = usePaperView(id);
  const key = useRef(crypto.randomUUID());
  const load = useMutation({
    mutationFn: () =>
      api("POST", `/api/v1/desk/paper/${id}/go-live`, goLiveViewSchema, {
        idempotencyKey: key.current,
      }),
  });
  const { mutate } = load;
  useEffect(() => {
    mutate();
  }, [mutate]);
  const view = load.data;
  return (
    <Workspace current="desk">
      <div className="flex flex-col gap-5">
        <Link
          href={`/desk/paper/${id}/results`}
          className="self-start text-sm font-bold text-accent-ink"
        >
          ← {t("back")}
        </Link>
        <PageHead
          title={t("title")}
          subtitle={t("subtitle", { name: view?.name ?? "" })}
          action={
            <span className="inline-flex h-6 items-center rounded-full bg-neg-bg px-2.5 text-[11px] font-extrabold text-neg-ink">
              {td("liveChip")}
            </span>
          }
        />
        {load.isPending || paper.isPending ? (
          <Skeleton className="h-64 w-full rounded-card" />
        ) : null}
        {load.isError || paper.isError ? (
          <p role="alert" className="m-0">
            {te("generic")}
          </p>
        ) : null}
        {view === undefined || paper.data === undefined ? null : (
          <Body view={view} paperId={id} day={paper.data.day} />
        )}
      </div>
    </Workspace>
  );
}
