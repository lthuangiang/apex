"use client";

import { botSummarySchema, dec, DECIMAL_STRING_PATTERN, UserRole } from "@drift/shared";
import { Button, ComingSoonChip, Field, inputClassName, LiveBadge } from "@drift/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { WorkspaceShell } from "@/components/workspace-shell";
import { api, ApiError } from "@/lib/api";
import { feeLabels } from "@/lib/format";
import { useMarketLast, useMarkets } from "@/lib/markets";
import { ME_KEY, useBuilderFeeRate, useMe, useTwoFactorNeeded } from "@/lib/queries";
import { BELOW_LG, useMediaQuery } from "@/lib/use-media";

import { emptyValues, FIELDS, toConfig, type FormValues } from "../fields";
import { defaultBotName } from "../form-layout";
import { liveHints, previewModel, priceMarketOf } from "../preview";

import { AiPanel, useAiParameters } from "./ai-params";
import { fieldErrorsOf, useBotErrorText } from "./bot-errors";
import { BotForm } from "./bot-form";
import { MarketChart } from "./market-chart";
import { CheckList, leverageWarning, useDryRunChecks } from "./start-checks";
import { VisualPanel } from "./visual-panel";

// Create (SCREENS.md mục 8.2, artboard "Create"): cột trái (flex 3) là phần trực quan, cột phải (flex 2)
// là Settings, "Before it starts" nằm dưới hai cột. Lưu draft trước; checks do server tính theo draft
// đã lưu. Start chỉ gửi yêu cầu: trạng thái Running đến từ backend (quy tắc 1.6).

const ENGINE_CHIP: Record<string, string> = {
  Spot: "bg-accent-tint text-accent-ink",
  Perps: "bg-unknown-bg text-unknown",
};

const versionAck = z.object({ version: z.number(), status: z.string() });

export function CreateBot({
  strategy,
  suggestionId,
  preset,
  draft,
}: {
  strategy: keyof typeof FIELDS;
  suggestionId?: string;
  /** Giá trị điền sẵn từ `?market=` (Watchlist, DEC-74). */
  preset?: FormValues | undefined;
  /** Mở lại draft đã lưu (Strategy Lab › Continue): điền config đã lưu, Save ghi version mới, Start như Create. */
  draft?: { id: string; name: string; values: FormValues };
}) {
  const t = useTranslations("createBot");
  const tb = useTranslations("common.badges");
  const qc = useQueryClient();
  const me = useMe();
  // Builder fee riêng của user nếu team đặt (DEC-159).
  const builderRate = useBuilderFeeRate(strategy);
  const [values, setValues] = useState<FormValues>(() => ({
    ...emptyValues(strategy),
    ...preset,
    ...draft?.values,
  }));
  const [name, setName] = useState(draft?.name ?? "");
  const [botId, setBotId] = useState<string | null>(draft?.id ?? null);
  const [dirty, setDirty] = useState(draft === undefined);
  const [savedNow, setSavedNow] = useState(false);
  const [ack, setAck] = useState(false);
  const [levAck, setLevAck] = useState(false);
  const [code, setCode] = useState("");
  const [started, setStarted] = useState(false);
  const keys = useRef({ save: crypto.randomUUID(), start: crypto.randomUUID() });
  const s = (k: string) => t(`strategies.${strategy}.${k}`);
  const marketList = useMarkets().data?.items ?? [];
  const defaultName = defaultBotName(s("name"), values, marketList);
  const update = useCallback((next: FormValues) => {
    setValues(next);
    setDirty(true);
    setAck(false);
    setLevAck(false);
  }, []);
  const ai = useAiParameters({
    strategy,
    values,
    setValues: update,
    context: "create",
    // Draft đã có tham số người dùng lưu: không tự điền AI đè lên.
    auto: draft === undefined,
    ...(suggestionId === undefined ? {} : { suggestionId }),
  });
  // Max loss mặc định của người dùng (Settings › Trading defaults): chỉ là gợi ý trong placeholder.
  const capitalRaw = values.investment ?? values.margin;
  const capitalText = typeof capitalRaw === "string" ? capitalRaw.replace(/,/g, "").trim() : "";
  const pct = me.data?.defaultMaxLossPct ?? null;
  const defaultMaxLoss: Record<string, string> =
    pct !== null && DECIMAL_STRING_PATTERN.test(capitalText) && dec(capitalText).gt(0)
      ? {
          maxLoss: t("ai.example", {
            value: dec(capitalText).mul(pct).div(100).toDecimalPlaces(2).toString(),
          }),
        }
      : {};
  const source = ai.state.paramSource;
  const aiId = ai.state.mode === "ai" ? ai.state.suggestion?.id : undefined;

  const save = useMutation({
    mutationFn: async () => {
      const config = toConfig(strategy, values);
      const opts = { idempotencyKey: keys.current.save };
      if (botId === null) {
        const bot = await api("POST", "/api/v1/bots", botSummarySchema, {
          ...opts,
          body: {
            strategy,
            name: name.trim() === "" ? defaultName : name.trim(),
            paramSource: source,
            ...(aiId === undefined ? {} : { aiSuggestionId: aiId }),
            config,
          },
        });
        return bot.id;
      }
      await api("POST", `/api/v1/bots/${botId}/versions`, versionAck, {
        ...opts,
        body: { paramSource: source, config },
      });
      return botId;
    },
    onSuccess: async (id) => {
      keys.current.save = crypto.randomUUID();
      setBotId(id);
      setDirty(false);
      setSavedNow(true);
      await qc.invalidateQueries({ queryKey: ["checks", id] });
    },
    onError: () => {
      keys.current.save = crypto.randomUUID();
    },
  });

  // Checks chạy trên form chưa lưu (UI_REVIEW H2); Start tự lưu draft nếu cần rồi mới start.
  const dry = useDryRunChecks(strategy, values);
  const checks = dry.query;

  const start = useMutation({
    mutationFn: (id: string) =>
      api("POST", `/api/v1/bots/${id}/actions/start`, botSummarySchema, {
        idempotencyKey: keys.current.start,
        body: { acknowledged: true, ...(code === "" ? {} : { twoFactorCode: code }) },
      }),
    onSuccess: () => {
      setStarted(true);
      void qc.invalidateQueries({ queryKey: ME_KEY });
    },
    onError: () => {
      keys.current.start = crypto.randomUUID();
    },
  });

  const priceMarket = priceMarketOf(strategy, values);
  const last = useMarketLast(priceMarket);
  const lastPrice = priceMarket === null ? null : (last.data ?? null);
  const tp = useTranslations("createBot.preview.hints");
  const hints = Object.fromEntries(
    Object.entries(liveHints(strategy, values, lastPrice?.price ?? null)).map(([k, h]) => [
      k,
      tp(h.key, h.params),
    ]),
  );
  // TWAP Start at theo múi giờ trong Settings (IMP-03, DEC-91).
  const tz = me.data?.timezone;
  useEffect(() => {
    if (strategy !== "twap" || tz === undefined) return;
    setValues((v) => (v.timeZone === tz ? v : { ...v, timeZone: tz }));
  }, [strategy, tz]);
  if (strategy === "twap" && tz !== undefined)
    hints.startTime = t("fields.startTime.hintTz", { tz });

  // Ô mã 2FA chỉ hiện khi đã bật 2FA mà phiên chưa được tin trong 2 giờ qua (DEC-115).
  const twoFactorNeeded =
    useTwoFactorNeeded() ||
    (start.error instanceof ApiError && start.error.code === "TWO_FACTOR_REQUIRED");
  const [startAfterSave, setStartAfterSave] = useState(false);
  const levWarn = leverageWarning(checks.data);
  const levText = (lev: string | null | undefined, mode: string | null | undefined) =>
    t("beforeStart.leverageValue", { leverage: lev ?? "", mode: mode ?? "" });
  // Điều kiện còn thiếu để bật Start, hiện ngay trên nút (UI_REVIEW H2); mỗi mục là link tới chỗ cần sửa.
  const fieldLabel = (k: string) => {
    const f = FIELDS[strategy].find((x) => x.key === k);
    return f === undefined ? k : t(`fields.${f.label ?? f.key}.label`);
  };
  // Form chưa hợp lệ: kể tên từng ô còn thiếu / sai; bấm vào là mở Advanced (nếu cần) và đưa con trỏ tới ô đó.
  const formMissing = dry.valid
    ? []
    : dry.invalidKeys.length === 0
      ? [{ label: t("beforeStart.missing.form"), target: "settings" }]
      : dry.invalidKeys.map((k) => ({
          label: t("beforeStart.missing.field", { field: fieldLabel(k) }),
          target: "settings",
          field: k,
        }));
  const missing: { label: string; target: string; field?: string }[] = [
    ...formMissing,
    ...(checks.data?.checks ?? [])
      .filter((c) => dry.valid && !c.ok)
      .map((c) => ({
        label: t("beforeStart.missing.fix", {
          check: t(`beforeStart.${c.key}`, { engine: s("engine") }),
        }),
        target: `check-${c.key}`,
      })),
    ...(dry.valid && checks.data === undefined
      ? [
          {
            label:
              checks.error === null
                ? t("beforeStart.missing.wait")
                : t("beforeStart.missing.fix", { check: t("beforeStart.checksFailedShort") }),
            target: "before-title",
          },
        ]
      : []),
    ...(levWarn !== null && !levAck
      ? [{ label: t("beforeStart.missing.leverage"), target: "start-lev-ack" }]
      : []),
    ...(ack ? [] : [{ label: t("beforeStart.missing.ack"), target: "start-ack" }]),
    ...(!twoFactorNeeded || code.length >= 6
      ? []
      : [{ label: t("beforeStart.missing.code"), target: "start-2fa" }]),
  ];
  // AI parameters cần vốn (UI_REVIEW E7): viền lỗi ô vốn còn trống và đưa con trỏ tới đó.
  const capitalKey = FIELDS[strategy].find((f) => f.amount === true)?.key;
  const capitalEmpty = capitalKey !== undefined && (values[capitalKey] ?? "") === "";
  const needCapital = ai.state.needsCapital && !ai.state.loading && capitalEmpty;
  const [focusKey, setFocusKey] = useState<{ key: string; n: number } | null>(null);
  useEffect(() => {
    if (needCapital) setFocusKey((f) => ({ key: capitalKey, n: (f?.n ?? 0) + 1 }));
  }, [needCapital, capitalKey]);
  const errors = {
    ...fieldErrorsOf(save.error, t("errors.fieldRequired")),
    ...(needCapital ? { [capitalKey]: [t("ai.needsCapitalField")] } : {}),
  };
  const engine = s("engine");
  const errorText = useBotErrorText();

  const startBot = () => {
    void (async () => {
      // Form đã đổi (hoặc chưa lưu): lưu draft / version mới trước, server chạy lại check khi start.
      let id = botId;
      if (id === null || dirty) {
        setStartAfterSave(true);
        try {
          id = await save.mutateAsync();
        } catch {
          return;
        } finally {
          setStartAfterSave(false);
        }
      }
      start.mutate(id);
    })();
  };
  // Thanh dính đáy (mobile, UI_REVIEW G5): còn thiếu điều kiện thì cuộn tới mục đầu tiên thay vì start.
  const focusField = (key: string) => {
    setFocusKey((f) => ({ key, n: (f?.n ?? 0) + 1 }));
  };
  const goToMissing = () => {
    const first = missing[0];
    if (first?.field !== undefined) {
      focusField(first.field);
      return;
    }
    const target = first?.target;
    if (target === undefined) return;
    const el = document.getElementById(target);
    el?.scrollIntoView({ block: "center" });
    (el?.matches("input, button") === true
      ? el
      : el?.querySelector<HTMLElement>("input, button")
    )?.focus({
      preventScroll: true,
    });
  };

  const isMobile = useMediaQuery(BELOW_LG);
  const hasPreview = previewModel(strategy, values, lastPrice?.price ?? null, Date.now()) !== null;
  const visual = (
    <VisualPanel strategy={strategy} values={values} last={lastPrice} inline={isMobile} />
  );

  return (
    <WorkspaceShell current="bots" isTeam={me.data?.role === UserRole.team}>
      <div className="flex flex-col gap-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <Link href="/bots" className="text-[13px] font-bold no-underline">
              {t("back")}
            </Link>
            <h1 className="m-0 text-[26px] font-extrabold">
              {draft === undefined
                ? t("title", { name: s("name") })
                : t("continueTitle", { name: draft.name })}
            </h1>
            <p className="m-0 text-sm text-ink-2">{s("what")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-[5px] text-[11px] font-extrabold tracking-[0.04em] ${ENGINE_CHIP[engine] ?? "bg-ink text-surface"}`}
            >
              {engine}
            </span>
            <LiveBadge label={tb("live")} className="h-8 px-3" />
            <span title={t("paperReason")}>
              <ComingSoonChip label={t("paperSoon")} />
            </span>
          </div>
        </header>

        <div className="flex flex-wrap items-start gap-4">
          {isMobile ? null : (
            // Widget chart nằm dưới Preview / Backtest ở cột trái (IMP-05). Cột cao hơn màn hình nên bỏ sticky.
            <div className="flex min-w-0 flex-[3_1_480px] flex-col gap-4 self-start">
              {visual}
              <MarketChart
                strategy={strategy}
                values={values}
                lastPrice={lastPrice?.price ?? null}
              />
            </div>
          )}

          <section
            id="settings"
            aria-label={t("settingsLabel")}
            className="flex min-w-0 flex-[2_1_340px] flex-col gap-[18px] rounded-card border border-border bg-surface p-[18px]"
          >
            <AiPanel ai={ai} />
            {ai.enabled ? null : <p className="m-0 text-sm text-ink-2">{t("manualHint")}</p>}
            <BotForm
              strategy={strategy}
              values={values}
              errors={errors}
              disabled={started || ai.state.loading}
              sources={ai.state.sources}
              hints={hints}
              placeholders={{
                ...defaultMaxLoss,
                ...Object.fromEntries(
                  Object.entries(ai.state.placeholders).map(([k, v]) => [
                    k,
                    t("ai.example", { value: v }),
                  ]),
                ),
              }}
              onChange={update}
              focusKey={focusKey}
              preview={
                isMobile ? { node: visual, at: hasPreview ? "advanced" : "amount" } : undefined
              }
              afterMarket={
                isMobile ? (
                  <MarketChart
                    inline
                    strategy={strategy}
                    values={values}
                    lastPrice={lastPrice?.price ?? null}
                  />
                ) : undefined
              }
              advancedExtra={
                <Field label={t("fields.name.label")}>
                  {(p) => (
                    <input
                      {...p}
                      className={inputClassName}
                      value={name}
                      placeholder={defaultName}
                      disabled={botId !== null}
                      onChange={(e) => {
                        setName(e.target.value);
                      }}
                    />
                  )}
                </Field>
              }
            />
          </section>
        </div>

        <section
          aria-labelledby="before-title"
          className="flex flex-col gap-3.5 rounded-card border border-border bg-surface p-[18px]"
        >
          <h2 id="before-title" className="m-0 text-[17px] font-extrabold">
            {t("beforeStart.title")}
          </h2>
          {started ? (
            <div
              role="status"
              className="flex flex-col gap-2.5 rounded-[16px] border border-warn-bar bg-warn-bg p-4 text-warn"
            >
              <strong className="text-base">{t("beforeStart.requested")}</strong>
              <p className="m-0 text-sm">{t("beforeStart.requestedBody")}</p>
              <Link
                href={`/agent/${botId ?? ""}`}
                className="flex min-h-tap items-center self-start rounded-control bg-surface px-4 text-sm font-bold no-underline"
              >
                {t("beforeStart.watch")}
              </Link>
            </div>
          ) : (
            <>
              {!dry.valid || checks.data === undefined ? (
                <p className="m-0 rounded-control bg-surface-2 px-3.5 py-3 text-sm text-ink-2">
                  {!dry.valid && dry.invalidKeys.length > 0
                    ? t("beforeStart.checksMissing", {
                        fields: dry.invalidKeys.map(fieldLabel).join(", "),
                      })
                    : dry.valid && checks.error !== null
                      ? // Server từ chối (ví dụ api chưa cùng bản schema): nói rõ lỗi, không đứng mãi ở "Fill in…".
                        Object.keys(fieldErrorsOf(checks.error)).length > 0
                        ? t("errors.invalidFields", {
                            fields: Object.keys(fieldErrorsOf(checks.error))
                              .map(fieldLabel)
                              .join(", "),
                          })
                        : errorText(checks.error)
                      : dry.valid
                        ? t("beforeStart.checksLoading")
                        : t("beforeStart.checksIncomplete")}
                </p>
              ) : (
                <CheckList checks={checks.data} engine={engine} />
              )}
              <p className="m-0 rounded-[14px] bg-surface-2 px-3.5 py-3 text-[13px] leading-normal text-ink-2 tabular-nums">
                {t("beforeStart.fee", {
                  fee: s("fee"),
                  rate: feeLabels(builderRate).pct,
                })}
              </p>
              {strategy === "volume_maker" ? (
                <>
                  <p className="m-0 text-xs text-ink-2">{t("beforeStart.noSelfTrade")}</p>
                  <p className="m-0 text-xs font-bold">{t("beforeStart.sopoints")}</p>
                </>
              ) : strategy === "volume_farm" ? (
                <>
                  <p className="m-0 text-xs text-ink-2">{t("beforeStart.farmCost")}</p>
                  <p className="m-0 text-xs font-bold">{t("beforeStart.sopoints")}</p>
                </>
              ) : null}
              {levWarn === null ? null : (
                <div className="flex flex-col gap-2.5 rounded-[14px] border border-warn-bar bg-warn-bg px-4 py-3.5 text-sm text-warn">
                  <p className="m-0 font-semibold">
                    {t("beforeStart.leverageWarn", {
                      market: levWarn.market ?? "",
                      current: levText(levWarn.currentLeverage, levWarn.currentMode),
                      target: levText(levWarn.leverage, levWarn.marginMode),
                    })}
                  </p>
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      id="start-lev-ack"
                      type="checkbox"
                      className="mt-px size-5 flex-none accent-accent"
                      checked={levAck}
                      onChange={() => {
                        setLevAck(!levAck);
                      }}
                    />
                    <span>{t("beforeStart.leverageAck", { market: levWarn.market ?? "" })}</span>
                  </label>
                </div>
              )}
              <label className="flex cursor-pointer items-start gap-3 rounded-[14px] border-[1.5px] border-border-input px-4 py-3.5 text-sm leading-[1.45]">
                <input
                  id="start-ack"
                  type="checkbox"
                  className="mt-px size-5 flex-none accent-accent"
                  checked={ack}
                  onChange={() => {
                    setAck(!ack);
                  }}
                />
                <span>
                  {t(
                    strategy === "volume_maker"
                      ? "beforeStart.ackVm"
                      : strategy === "volume_farm"
                        ? "beforeStart.ackVf"
                        : "beforeStart.ack",
                  )}
                </span>
              </label>
              <div className="flex flex-wrap items-end gap-2.5">
                {twoFactorNeeded ? (
                  <div id="start-2fa" className="flex-[1_1_160px]">
                    <Field label={t("beforeStart.twoFactor")}>
                      {(p) => (
                        <input
                          {...p}
                          className={inputClassName}
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          value={code}
                          onChange={(e) => {
                            setCode(e.target.value.trim());
                          }}
                        />
                      )}
                    </Field>
                  </div>
                ) : null}
                <div className="hidden lg:contents">
                  <Button
                    variant="tonal"
                    className="min-h-[50px] flex-[1_1_140px]"
                    pending={save.isPending}
                    onClick={() => {
                      save.mutate();
                    }}
                  >
                    {t("beforeStart.saveDraft")}
                  </Button>
                  <Button
                    variant="danger"
                    className="min-h-[50px] flex-[2_1_200px]"
                    pending={start.isPending || (save.isPending && startAfterSave)}
                    disabled={missing.length > 0 || ai.state.loading}
                    onClick={startBot}
                  >
                    {t("beforeStart.start")}
                  </Button>
                </div>
              </div>
              {missing.length === 0 ? null : (
                <p className="m-0 text-sm text-ink-2">
                  <strong>{t("beforeStart.toStart")}</strong>{" "}
                  {missing.map((m, i) => (
                    <span key={m.label}>
                      {i === 0 ? null : " · "}
                      <a
                        href={`#${m.target}`}
                        className="font-semibold text-accent-ink"
                        onClick={(ev) => {
                          if (m.field === undefined) return;
                          ev.preventDefault();
                          focusField(m.field);
                        }}
                      >
                        {m.label}
                      </a>
                    </span>
                  ))}
                </p>
              )}
              {savedNow && !dirty && save.error === null && start.error === null ? (
                <p role="status" className="m-0 text-sm text-pos">
                  {t("beforeStart.draftSaved")}{" "}
                  <Link href="/bots" className="font-semibold text-accent-ink">
                    {t("beforeStart.draftSavedLink")}
                  </Link>
                </p>
              ) : null}
              {save.error === null && start.error === null ? null : (
                <p role="alert" className="m-0 text-sm text-neg-ink">
                  {/* Có lỗi theo field: kể tên field, kể cả field đang ẩn trong Advanced settings. */}
                  {Object.keys(fieldErrorsOf(save.error ?? start.error)).length > 0
                    ? t("errors.invalidFields", {
                        fields: Object.keys(fieldErrorsOf(save.error ?? start.error))
                          .map((k) => {
                            const f = FIELDS[strategy].find((x) => x.key === k);
                            return f === undefined ? k : t(`fields.${f.label ?? f.key}.label`);
                          })
                          .join(", "),
                      })
                    : errorText(save.error ?? start.error)}
                </p>
              )}
              <p className="m-0 text-xs text-muted">{t("notForecast")}</p>
            </>
          )}
        </section>
        {started ? null : (
          <>
            <div aria-hidden="true" className="h-16 lg:hidden" />
            <div className="fixed inset-x-0 bottom-[calc(84px+env(safe-area-inset-bottom))] z-30 flex gap-2.5 border-t border-border bg-surface px-4 py-2.5 lg:hidden">
              <Button
                variant="tonal"
                className="min-h-tap flex-[1_1_0]"
                pending={save.isPending && !startAfterSave}
                onClick={() => {
                  save.mutate();
                }}
              >
                {t("beforeStart.saveDraft")}
              </Button>
              <Button
                variant="danger"
                className="min-h-tap flex-[2_1_0]"
                pending={start.isPending || (save.isPending && startAfterSave)}
                disabled={ai.state.loading}
                onClick={missing.length > 0 ? goToMissing : startBot}
              >
                {t("beforeStart.start")}
              </Button>
            </div>
          </>
        )}
      </div>
    </WorkspaceShell>
  );
}
