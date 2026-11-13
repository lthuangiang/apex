"use client";

import {
  COPY_PRESET_KEYS,
  dec,
  presetFields,
  type CopyPreset,
  type CopyRequest,
} from "@drift/shared";
import { Button, EmptyState, ErrorState, Field, inputClassName, Skeleton } from "@drift/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

import { Card, PageHead, Workspace } from "@/components/workspace";
import { ApiError } from "@/lib/api";
import { useFeatures, useMe, useSodexConnection } from "@/lib/queries";

import { useCopyPreview, useStartCopy, useTrader } from "../api";
import { useCopyErrorText } from "../errors";
import { addr, base, holdText, usd } from "../format";

import { isPicked, MarketsCard, WhatYoullCopy, type MarketsPick } from "./copy-markets";
import { Avatar, CopySteps } from "./parts";

// Copy a trader (artboard CopyBot → CopyReview, DEC-163, STRATEGIES.md S12.1): người mới chỉ chọn Budget và mức an
// toàn; field S12 do server tính theo bảng S12.1 (client chỉ hiển thị cùng công thức `presetFields`). Review báo market
// bị bỏ (trùng bot khác cùng account, SoDEX gộp vị thế theo market), phí, xác nhận tiền thật. Không có "Try with fake
// money" cho copy (DEC-105).

const AMOUNTS = ["100", "250", "500", "1000"] as const;
/** Field số thập phân trong config server trả (chuỗi); không phải chuỗi thì dùng giá trị dự phòng. */
const strOr = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const DECIMAL = /^\d+(\.\d+)?$/;

function TextField({
  label,
  value,
  onChange,
  unit,
  hint,
  error,
  inputMode = "decimal",
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  hint?: string;
  error?: string;
  inputMode?: "decimal" | "numeric";
  autoComplete?: string;
}) {
  return (
    <Field
      label={label}
      {...(unit === undefined ? {} : { unit })}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
    >
      {(p) => (
        <input
          {...p}
          className={inputClassName}
          value={value}
          inputMode={inputMode}
          {...(autoComplete === undefined ? {} : { autoComplete })}
          onChange={(e) => {
            onChange(e.target.value.trim());
          }}
        />
      )}
    </Field>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => {
      setV(value);
    }, ms);
    return () => {
      clearTimeout(id);
    };
  }, [value, ms]);
  return v;
}

export function CopyFlowPage({ leader }: { leader: string | null }) {
  const t = useTranslations("copy");
  const router = useRouter();
  const features = useFeatures();
  const me = useMe();
  const address =
    leader !== null && /^0x[0-9a-fA-F]{40}$/.test(leader) ? leader.toLowerCase() : null;
  const trader = useTrader(address ?? "");
  const [step, setStep] = useState<"budget" | "review">("budget");
  const [budget, setBudget] = useState("500");
  const [preset, setPreset] = useState<CopyPreset>("balanced");
  const [adv, setAdv] = useState(false);
  const [direction, setDirection] = useState<"follow" | "inverse">("follow");
  const [slip, setSlip] = useState("0.3");
  const [margin, setMargin] = useState<"isolated" | "cross">("isolated");
  const [tp, setTp] = useState("");
  // Chọn market + đòn bẩy theo market (DEC-226).
  const [pick, setPick] = useState<MarketsPick>({ picked: null, perMarket: false, levs: {} });
  const [ack, setAck] = useState(false);
  const [code, setCode] = useState("");
  const start = useStartCopy();
  const conn = useSodexConnection();
  const errorText = useCopyErrorText();
  // Chưa kết nối SoDEX: chặn từ bước Budget (preview cần account SoDEX để đọc số dư và market).
  const noSodex = conn.isSuccess && conn.data.connection?.status !== "connected";
  useEffect(() => {
    if (features.data !== undefined && !features.data.aiDesk) router.replace("/");
  }, [features.data, router]);

  const budgetOk = DECIMAL.test(budget) && dec(budget).gt(0);
  const req: CopyRequest | null = useMemo(
    () =>
      address === null || !budgetOk
        ? null
        : {
            address,
            budget,
            preset,
            direction,
            marginMode: margin,
            ...(DECIMAL.test(slip) ? { maxSlippagePct: slip } : {}),
            ...(DECIMAL.test(tp) ? { takeProfitPct: tp } : {}),
            // Bỏ hết market: giữ yêu cầu trước đó (server cần ≥ 1), nút Continue khoá với câu "Pick at least one market."
            ...(pick.picked !== null && pick.picked.length > 0
              ? { markets: [...pick.picked] }
              : {}),
            ...(pick.perMarket
              ? {
                  leverageByMarket: Object.fromEntries(
                    Object.entries(pick.levs).filter(
                      ([m]) => pick.picked === null || pick.picked.includes(m),
                    ),
                  ),
                }
              : {}),
          },
    [address, budget, budgetOk, preset, direction, margin, slip, tp, pick],
  );
  const preview = useCopyPreview(useDebounced(req, 300));
  const p = preview.data;
  // Số hiển thị lấy từ config server tính (trần tổng theo đòn bẩy thấp nhất); chưa có preview thì công thức S12.1.
  const local = budgetOk ? presetFields(budget, preset) : null;
  const f =
    local === null
      ? null
      : p === undefined
        ? local
        : {
            ...local,
            fixedNotional: strOr(p.config.fixedNotional, local.fixedNotional),
            maxExposure: strOr(p.config.maxExposure, local.maxExposure),
            maxLoss: strOr(p.config.maxLoss, local.maxLoss),
          };
  const rows = p?.rows ?? [];
  const pickedRows = rows.filter((r) => isPicked(pick, r.market));
  const levOf = (r: (typeof rows)[number]) =>
    pick.perMarket
      ? Math.min(Math.max(1, pick.levs[r.market] ?? r.leverage), r.maxLeverage)
      : r.leverage;
  const noneOn = rows.length > 0 && pickedRows.length === 0;
  const allMarkets = rows.map((r) => r.market);
  const toggleMarket = (m: string) => {
    setPick((cur) => {
      const now = cur.picked ?? allMarkets;
      const next = now.includes(m) ? now.filter((x) => x !== m) : [...now, m];
      return { ...cur, picked: next.length === allMarkets.length ? null : next };
    });
  };
  // Budget lớn hơn số dư khả dụng: chỉ cảnh báo (không chặn), vì số dư thay đổi và SoDEX là nơi quyết định.
  const overBudget = budgetOk && p?.available != null && dec(budget).gt(dec(p.available));
  const overBudgetNote = overBudget ? (
    <p role="status" className="m-0 rounded-card bg-warn-bg p-4 text-sm text-warn">
      <strong>{t("budget.overBalance.title")}</strong>{" "}
      {t("budget.overBalance.body", {
        balance: usd(p.available, false, 2)?.replace("$", "") ?? "",
      })}
    </p>
  ) : null;
  const twofa =
    me.data?.twoFactorEnabled === true &&
    !(
      me.data.twoFactorTrustedUntil !== null &&
      Date.parse(me.data.twoFactorTrustedUntil) > Date.now()
    );

  if (address === null)
    return (
      <Workspace current="traders">
        <EmptyState
          title={t("budget.noLeader")}
          action={
            <Link href="/traders" className="font-bold text-accent">
              {t("budget.pick")}
            </Link>
          }
        />
      </Workspace>
    );

  const card = trader.data?.card;
  const head = (
    <div className="flex flex-col gap-3">
      <Link
        href={step === "budget" ? `/traders/${address}` : "#"}
        onClick={(e) => {
          if (step === "review") {
            e.preventDefault();
            setStep("budget");
          }
        }}
        className="self-start text-sm font-bold text-accent"
      >
        {step === "budget" ? t("budget.back") : t("review.back")}
      </Link>
      <PageHead
        title={
          step === "budget"
            ? t("budget.heading", { trader: card?.displayName ?? addr(address) })
            : t("review.heading")
        }
        subtitle={step === "budget" ? t("budget.title") : t("review.title")}
        back={{ href: `/traders/${address}`, label: t("budget.back") }}
      />
      <div className="flex flex-wrap items-center gap-3">
        {step === "review" ? (
          <span className="inline-flex h-8 items-center rounded-full bg-neg-bg px-3 text-sm font-bold text-neg">
            ● {t("review.mainnet")}
          </span>
        ) : null}
        <CopySteps at={step} />
      </div>
    </div>
  );

  const presetName = (k: CopyPreset) => t(`budget.presets.${k}.name`);

  return (
    <Workspace current="traders">
      <div className="flex flex-col gap-5">
        {head}
        {trader.isPending ? (
          <Skeleton className="h-96 rounded-card" />
        ) : trader.isError ? (
          <ErrorState
            title={t("common.loadError")}
            retryLabel={t("common.retry")}
            onRetry={() => {
              void trader.refetch();
            }}
          />
        ) : step === "budget" ? (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="flex flex-col gap-5">
              {noSodex ? (
                <section
                  role="status"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-warn-bg p-4 text-sm text-ink"
                >
                  <strong>{t("budget.connectTitle")}</strong>
                  <Link
                    href="/onboarding/connect"
                    className="inline-flex min-h-tap items-center rounded-[12px] bg-accent px-4 font-bold text-white no-underline hover:bg-accent-ink"
                  >
                    {t("budget.connect")}
                  </Link>
                </section>
              ) : null}
              <Card title={t("budget.howMuch")}>
                <TextField
                  label={t("budget.budget")}
                  value={budget}
                  unit={t("budget.unit")}
                  onChange={setBudget}
                  {...(budgetOk ? {} : { error: t("budget.budgetInvalid") })}
                />
                <p className="m-0 text-sm text-ink-2">
                  {p?.available == null
                    ? t("budget.availableUnknown")
                    : t("budget.available", {
                        balance: usd(p.available, false, 2)?.replace("$", "") ?? "",
                      })}
                </p>
                {overBudgetNote}
                <div className="flex flex-wrap gap-2">
                  {AMOUNTS.map((a) => (
                    <button
                      key={a}
                      type="button"
                      aria-pressed={budget === a}
                      onClick={() => {
                        setBudget(a);
                      }}
                      className={`min-h-tap rounded-control px-4 text-sm font-bold ${
                        budget === a
                          ? "border-2 border-accent bg-accent-tint text-accent-ink"
                          : "border border-border bg-surface text-ink"
                      }`}
                    >
                      {usd(a)}
                    </button>
                  ))}
                </div>
              </Card>

              <Card title={t("budget.safetyTitle")}>
                <p className="m-0 -mt-2 text-sm text-ink-2">{t("budget.safetyBody")}</p>
                <div
                  role="radiogroup"
                  aria-label={t("budget.safetyTitle")}
                  className="grid gap-3 sm:grid-cols-3"
                >
                  {COPY_PRESET_KEYS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={preset === k}
                      onClick={() => {
                        setPreset(k);
                      }}
                      className={`flex min-h-24 flex-col gap-1.5 rounded-[16px] p-4 text-left ${
                        preset === k
                          ? "border-2 border-accent bg-accent-tint"
                          : "border border-border bg-surface"
                      }`}
                    >
                      <span className="flex items-center gap-2 font-extrabold">
                        {presetName(k)}
                        {k === "balanced" ? (
                          <span className="rounded-[10px] bg-accent-tint px-2 py-0.5 text-[11px] font-extrabold text-accent-ink">
                            {t("budget.recommended")}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-sm text-ink-2">{t(`budget.presets.${k}.blurb`)}</span>
                    </button>
                  ))}
                </div>
                {f === null ? null : (
                  // Hộp tô nền 4 cột như artboard CopyBot; số "Stop everything at a loss of" màu đỏ.
                  <dl className="m-0 grid grid-cols-2 gap-2.5 rounded-[16px] bg-surface-2 px-4 py-3.5 sm:grid-cols-4">
                    <div className="flex flex-col gap-0.5">
                      <dt className="text-xs font-semibold text-ink-2">{t("budget.leverage")}</dt>
                      <dd className="m-0 text-base font-extrabold">{f.leverage}×</dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <dt className="text-xs font-semibold text-ink-2">{t("budget.perTrade")}</dt>
                      <dd className="m-0 text-base font-extrabold tabular-nums">
                        {t("budget.perTradeValue", {
                          value: usd(f.fixedNotional)?.replace("$", "") ?? "",
                        })}
                      </dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <dt className="text-xs font-semibold text-ink-2">{t("budget.stopLoss")}</dt>
                      <dd className="m-0 text-base font-extrabold">{f.stopLossPct}%</dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <dt className="text-xs font-semibold text-ink-2">{t("budget.maxLoss")}</dt>
                      <dd className="m-0 text-base font-extrabold tabular-nums text-neg">
                        {usd(f.maxLoss)}
                      </dd>
                    </div>
                  </dl>
                )}
                {f === null ? null : (
                  <p className="m-0 text-sm text-ink-2">
                    {t(p?.mixedLeverage === true ? "budget.exposureLowest" : "budget.exposure", {
                      value: usd(f.maxExposure)?.replace("$", "") ?? "",
                    })}
                  </p>
                )}
              </Card>

              <MarketsCard
                rows={rows.map((r) => ({ ...r, leverage: levOf(r) }))}
                loading={preview.isPending}
                pick={pick}
                presetName={presetName(preset)}
                presetLeverage={local?.leverage ?? 1}
                perTrade={f?.fixedNotional ?? null}
                cap={f?.maxExposure ?? null}
                onToggle={toggleMarket}
                onSelectAll={() => {
                  setPick((cur) => ({ ...cur, picked: null }));
                }}
                onPerMarket={(on) => {
                  // Bật per-market: bắt đầu từ đòn bẩy đang áp ở từng market.
                  setPick((cur) => ({
                    ...cur,
                    perMarket: on,
                    levs: on ? Object.fromEntries(rows.map((r) => [r.market, r.leverage])) : {},
                  }));
                }}
                onLeverage={(m, lev) => {
                  setPick((cur) => ({ ...cur, levs: { ...cur.levs, [m]: lev } }));
                }}
              />

              <section className="flex flex-col gap-3 rounded-card border border-border bg-surface p-5">
                <button
                  type="button"
                  aria-expanded={adv}
                  onClick={() => {
                    setAdv((v) => !v);
                  }}
                  className="flex items-center justify-between gap-3 text-left"
                >
                  <span className="text-lg font-extrabold">{t("budget.advanced")}</span>
                  <span className="text-sm text-ink-2">
                    {adv ? t("budget.hide") : t("budget.advancedHint")}
                  </span>
                </button>
                {adv ? (
                  <div className="flex flex-col gap-4">
                    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                      <legend className="mb-2 text-sm font-bold">{t("budget.direction")}</legend>
                      {(["follow", "inverse"] as const).map((d) => (
                        <label key={d} className="flex min-h-tap items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="direction"
                            checked={direction === d}
                            onChange={() => {
                              setDirection(d);
                            }}
                          />
                          {t(`budget.${d}`)}
                        </label>
                      ))}
                    </fieldset>
                    <TextField
                      label={t("budget.priceMove")}
                      value={slip}
                      unit="%"
                      hint={t("budget.priceMoveHelp")}
                      onChange={setSlip}
                    />
                    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                      <legend className="mb-2 text-sm font-bold">{t("budget.margin")}</legend>
                      {(["isolated", "cross"] as const).map((m) => (
                        <label key={m} className="flex min-h-tap items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="margin"
                            checked={margin === m}
                            onChange={() => {
                              setMargin(m);
                            }}
                          />
                          {t(`budget.${m}`)}
                        </label>
                      ))}
                    </fieldset>
                    <TextField
                      label={t("budget.takeProfit")}
                      value={tp}
                      unit="%"
                      onChange={setTp}
                    />
                  </div>
                ) : null}
              </section>
            </div>

            <aside className="flex flex-col gap-4">
              <Card title={t("budget.afterTitle")}>
                <ol className="m-0 flex list-decimal flex-col gap-2 pl-5 text-sm text-ink-2">
                  <li>{t("budget.after1")}</li>
                  <li>{t("budget.after2")}</li>
                  <li>{t("budget.after3")}</li>
                  <li>{t("budget.after4")}</li>
                </ol>
              </Card>
              <section className="flex flex-col gap-2 rounded-card bg-warn-bg p-5 text-sm text-warn">
                <strong>{t("budget.differTitle")}</strong>
                <p className="m-0">{t("budget.differBody")}</p>
              </section>
              <WhatYoullCopy
                picked={pickedRows.length}
                total={rows.length}
                levs={pickedRows.map(levOf)}
              />
              {preview.isError && !noSodex ? (
                <p role="alert" className="m-0 text-sm text-neg-ink">
                  {errorText(preview.error)}
                </p>
              ) : null}
              <Button
                disabled={!budgetOk || p === undefined || noSodex || preview.isError || noneOn}
                onClick={() => {
                  setStep("review");
                }}
              >
                {t("budget.continue")}
              </Button>
            </aside>
          </div>
        ) : p === undefined || f === null ? (
          <Skeleton className="h-96 rounded-card" />
        ) : (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="flex flex-col gap-5">
              <Card title={t("review.about")}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar address={address} />
                    <div className="flex min-w-0 flex-col">
                      <span className="font-extrabold tabular-nums">
                        {card?.displayName ?? addr(address)}
                      </span>
                      <span className="text-xs text-muted">
                        {card === undefined
                          ? t("common.hyperliquid")
                          : t("review.aboutLine", {
                              profit: usd(card.stats.profit, true) ?? "",
                              hold: holdText(card.stats.typicalHoldMs) ?? t("common.notEnough"),
                            })}
                      </span>
                    </div>
                  </div>
                  <Link href={`/traders/${address}`} className="text-sm font-bold text-accent">
                    {t("review.change")}
                  </Link>
                </div>
                <dl className="m-0 flex flex-col divide-y divide-border text-sm">
                  {[
                    [t("review.budget"), t("review.budgetValue", { value: budget })],
                    [
                      t("review.safety"),
                      t("review.safetyValue", { name: presetName(preset), lev: f.leverage }),
                    ],
                    [
                      t("review.perTrade"),
                      t("review.perTradeValue", {
                        value: usd(f.fixedNotional)?.replace("$", "") ?? "",
                      }),
                    ],
                    [
                      t("review.together"),
                      t("review.togetherValue", {
                        value: usd(f.maxExposure)?.replace("$", "") ?? "",
                      }),
                    ],
                    [t("review.stopLoss"), `${f.stopLossPct}%`],
                    [t("review.maxLoss"), usd(f.maxLoss) ?? ""],
                    [
                      t("review.markets"),
                      // Market đã chọn và đòn bẩy từng market (DEC-226).
                      p.rows
                        .filter((r) => r.selected)
                        .map((r) => t("review.marketLev", { market: r.market, lev: r.leverage }))
                        .join(", ") || t("common.notAvailable"),
                    ],
                    [t("review.direction"), t(`review.directions.${direction}`)],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3 py-2">
                      <dt className="text-ink-2">{k}</dt>
                      <dd className="m-0 text-right font-bold tabular-nums">{v}</dd>
                    </div>
                  ))}
                </dl>
              </Card>
              {overBudgetNote}
              {p.thinMarkets.map((m) => (
                <p key={`thin-${m}`} className="m-0 rounded-card bg-warn-bg p-4 text-sm text-warn">
                  <strong>{base(m)}</strong> · {t("review.thinMarket")}
                </p>
              ))}
              {p.dropped.map((d) => (
                <p key={d.market} className="m-0 rounded-card bg-warn-bg p-4 text-sm text-warn">
                  <strong>
                    {t(`review.dropped.${d.reason}.title`, { market: base(d.market) })}
                  </strong>{" "}
                  {t(`review.dropped.${d.reason}.body`, {
                    market: base(d.market),
                    bot: d.botName ?? "",
                  })}
                </p>
              ))}
              <Card title={t("review.costs")}>
                <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm text-ink-2">
                  <li>{t("review.cost1")}</li>
                  <li>{t("review.cost2", { fee: p.builderFeeMax })}</li>
                  <li>{t("review.cost3")}</li>
                </ul>
                <p className="m-0 text-sm text-ink-2">{t("review.split")}</p>
              </Card>
            </div>
            <aside className="flex flex-col gap-4">
              {p.slot === "full" ? (
                <p className="m-0 rounded-card bg-warn-bg p-4 text-sm text-warn">
                  {t("review.full")}
                </p>
              ) : null}
              {p.markets.length === 0 ? (
                <p className="m-0 rounded-card bg-warn-bg p-4 text-sm text-warn">
                  {t("review.noMarkets")}
                </p>
              ) : null}
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={ack}
                  onChange={(e) => {
                    setAck(e.target.checked);
                  }}
                />
                <span>{t("review.ack")}</span>
              </label>
              {twofa ? (
                <TextField
                  label={t("review.twoFactor")}
                  value={code}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  onChange={setCode}
                />
              ) : null}
              {start.isError ? (
                <p role="alert" className="m-0 text-sm text-neg">
                  {start.error instanceof ApiError && start.error.code === "STATE_CONFLICT"
                    ? t("review.full")
                    : t("review.failed")}
                </p>
              ) : null}
              <Button
                disabled={
                  !ack ||
                  start.isPending ||
                  p.markets.length === 0 ||
                  p.slot === "full" ||
                  !p.copyable.ok ||
                  req === null
                }
                onClick={() => {
                  if (req === null) return;
                  start.mutate(
                    { ...req, acknowledged: true, ...(code === "" ? {} : { twoFactorCode: code }) },
                    {
                      onSuccess: (bot) => {
                        router.push(`/agent/${bot.id}`);
                      },
                    },
                  );
                }}
              >
                {start.isPending ? t("review.starting") : t("review.start")}
              </Button>
              <p className="m-0 text-xs text-muted">{t("review.never")}</p>
            </aside>
          </div>
        )}
      </div>
    </Workspace>
  );
}
