"use client";

import {
  BotState,
  botListSchema,
  featuresSchema,
  ReasonCode,
  UserRole,
  type BotSummary,
  type BotWaiting,
  builderFeeRateFor,
} from "@drift/shared";
import { DataTable, StatusPill } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { PageHead } from "@/components/workspace";
import { WorkspaceShell } from "@/components/workspace-shell";
import { AskAboutThis } from "@/features/desk/components/ask-about-this";
import { PaperChip } from "@/features/desk/components/paper-chip";
import { api } from "@/lib/api";
import { feeLabels, formatAmount, formatDateTime } from "@/lib/format";
import { useMarketNames } from "@/lib/markets";
import { useMe } from "@/lib/queries";
import { useMediaQuery } from "@/lib/use-media";

import { botCapital, botMarket } from "../bot-label";
import { catalogFor } from "../catalog";
import { FIELDS, presetMarket } from "../fields";

import { BotActions } from "./bot-actions";
import { BotProfit } from "./bot-profit";

// Strategy Lab (SCREENS.md mục 8.2, artboard "Bots"): tab My bots và Strategy catalog.

export const BOTS_KEY = ["bots"] as const;
// Market Making và Volume Builder (DEC-94): mở cho mọi tài khoản, đứng đầu lưới catalog (DEC-133); team vẫn tắt được
// từng người.
const VOLUME_KEYS: readonly string[] = ["volume_maker", "volume_farm"];
// Chiến lược thử nghiệm (AI Adaptive DCA, DEC-107): chỉ hiện khi team bật AI Desk cho tài khoản.
const EXPERIMENTAL_KEYS: readonly string[] = ["adaptive_dca", "copy_trade"];
const CATALOG_BASE = (Object.keys(FIELDS) as (keyof typeof FIELDS)[]).filter(
  (k) => !VOLUME_KEYS.includes(k) && !EXPERIMENTAL_KEYS.includes(k),
);
// Chip nhóm và chip engine của thẻ catalog (artboard Bots).
const CHIP = "rounded-full px-[9px] py-[3px] text-[11px] font-extrabold tracking-[0.06em]";
const GROUP_CHIP: Record<keyof typeof FIELDS, string> = {
  spot_grid: "bg-bot-orange text-cat-grid-ink",
  futures_grid: "bg-bot-orange text-cat-grid-ink",
  spot_dca: "bg-bot-teal text-cat-dca-ink",
  futures_dca: "bg-bot-teal text-cat-dca-ink",
  adaptive_dca: "bg-bot-teal text-cat-dca-ink",
  copy_trade: "bg-cat-exec-bg text-ink-2",
  recurring_buy: "bg-accent-tint text-accent-ink",
  rebalancing: "bg-accent-tint text-accent-ink",
  funding_arb: "bg-unknown-bg text-unknown",
  twap: "bg-cat-exec-bg text-ink-2",
  volume_maker: "bg-ink text-surface",
  volume_farm: "bg-ink text-surface",
};
const SPOT_CHIP = "bg-accent-tint text-accent-ink";
const PERPS_CHIP = "bg-unknown-bg text-unknown";
const BOTH_CHIP = "bg-ink text-surface";
const ENGINE_CHIP: Record<keyof typeof FIELDS, string> = {
  spot_grid: SPOT_CHIP,
  futures_grid: PERPS_CHIP,
  spot_dca: SPOT_CHIP,
  futures_dca: PERPS_CHIP,
  adaptive_dca: PERPS_CHIP,
  copy_trade: PERPS_CHIP,
  recurring_buy: SPOT_CHIP,
  rebalancing: SPOT_CHIP,
  funding_arb: BOTH_CHIP,
  twap: BOTH_CHIP,
  volume_maker: PERPS_CHIP,
  volume_farm: PERPS_CHIP,
};
const STATUS_FILTERS = ["all", "running", "paused", "stopped", "draft", "archived"] as const;
const ENGINE_FILTERS = ["all", "spot", "perps"] as const;

/** Trạng thái chuyển tiếp chờ backend / SoDEX quá 60 s (UI_REVIEW H1): báo cho người dùng, không im lặng. */
const TRANSITIONAL: readonly string[] = [
  BotState.starting,
  BotState.pausing,
  BotState.resuming,
  BotState.stopping,
];
export function waitingTooLong(b: Pick<BotSummary, "state" | "updatedAt">, now = Date.now()) {
  return TRANSITIONAL.includes(b.state) && now - Date.parse(b.updatedAt) > 60_000;
}

/** "Waiting for price" kèm điều kiện (DEC-91). Giá là chuỗi backend trả về; giờ theo múi giờ ở Settings. */
export function useWaitingText() {
  const t = useTranslations("waiting");
  const me = useMe();
  const tz = me.data?.timezone;
  const price = (v: string) => formatAmount(v)?.text ?? v;
  return (w: BotWaiting): string => {
    switch (w.kind) {
      case "entry":
        return w.condition.type === "in_range"
          ? t("range", { low: price(w.condition.low), high: price(w.condition.high) })
          : t(w.condition.type === "cross" ? "cross" : "atPrice", {
              price: price(w.condition.price),
            });
      case "pullback":
        return t("pullback", { price: price(w.price) });
      case "cooldown":
        return t("cooldown", { time: formatDateTime(w.until, tz) });
      case "start_at":
        return t("startAt", { time: formatDateTime(w.at, tz) });
    }
  };
}

const VOLUME_TARGET_STRATEGIES = new Set<string>(["volume_farm"]);

export function useStateLabel() {
  const t = useTranslations("states");
  const tr = useTranslations("reasons");
  const waiting = useWaitingText();
  return (
    b: Pick<BotSummary, "state" | "reasonCode" | "needsAttention"> &
      Partial<Pick<BotSummary, "waiting" | "strategy">>,
  ) => ({
    state: b.state,
    label: t(b.state),
    ...(b.state === BotState.running && b.waiting != null ? { detail: waiting(b.waiting) } : {}),
    ...(b.reasonCode === null
      ? {}
      : {
          reason: b.reasonCode,
          // Bot khối lượng dừng vì đủ volume target, không phải "max cycles" (cùng reason code MAX_CYCLES).
          reasonLabel:
            b.reasonCode === ReasonCode.maxCycles && VOLUME_TARGET_STRATEGIES.has(b.strategy ?? "")
              ? tr("MAX_CYCLES_VOLUME")
              : tr(b.reasonCode),
        }),
    ...(b.needsAttention ? { needsAttention: true, needsAttentionLabel: t("needsAttention") } : {}),
  });
}

export function BotsPage() {
  const names = useMarketNames();
  const t = useTranslations("bots");
  const tc = useTranslations("createBot");
  const te = useTranslations("common.errors");
  const tm = useTranslations("common.missing");
  const tsh = useTranslations("common.shell");
  const me = useMe();
  // < 768 px: danh sách thẻ thay cho bảng (UI_REVIEW J4, artboard Mobile-Bots).
  const isMobile = useMediaQuery("(max-width: 767px)");
  // Lấy cả bot đã archive cho bộ lọc Archived; mặc định danh sách không hiện chúng (DEC-84).
  const bots = useQuery({
    queryKey: [...BOTS_KEY, "withArchived"],
    queryFn: () => api("GET", "/api/v1/bots?archived=true", botListSchema),
    refetchInterval: 5_000,
  });
  // `?tab=catalog` (ví dụ từ "+ New agent" ở Trading Agent) mở thẳng Strategy catalog.
  const params = useSearchParams();
  const [tab, setTab] = useState<"mine" | "catalog">(
    params.get("tab") === "catalog" ? "catalog" : "mine",
  );
  // `?market=&engine=` (Watchlist › "New bot on …", DEC-74): catalog chỉ còn chiến lược dùng được market đó.
  const forMarket = ((): { market: string; engine: "spot" | "perps" } | null => {
    const m = params.get("market");
    const e = params.get("engine");
    return m !== null && (e === "spot" || e === "perps") ? { market: m, engine: e } : null;
  })();
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [engine, setEngine] = useState<(typeof ENGINE_FILTERS)[number]>("all");
  const stateLabel = useStateLabel();

  const everyBot = bots.data?.items ?? [];
  const items = everyBot.filter((b) => b.state !== BotState.archived);
  const feeRevoked = items.some(
    (b) => b.reasonCode === ReasonCode.builderFeeRevoked && b.state === BotState.paused,
  );
  // Funding Arbitrage chạy cả hai engine: hiện ở cả Spot lẫn Perps.
  const rows = (status === "archived" ? everyBot : items).filter(
    (b) =>
      (status === "all" || b.state === status) &&
      (engine === "all" || b.engine === engine || b.engine === "spot+perps"),
  );
  const features = useQuery({
    queryKey: ["features"],
    queryFn: () => api("GET", "/api/v1/features", featuresSchema),
    staleTime: 60_000,
  });
  const catalog = catalogFor(
    {
      volumeMaker: features.data?.volumeMaker === true,
      volumeFarm: features.data?.volumeFarm === true,
      adaptiveDca: features.data?.adaptiveDca === true,
      aiDesk: features.data?.aiDesk === true,
    },
    CATALOG_BASE,
  ).filter(
    (k) => forMarket === null || presetMarket(k, forMarket.market, forMarket.engine) !== null,
  );
  const marketQuery =
    forMarket === null
      ? ""
      : `?${new URLSearchParams({ market: forMarket.market, engine: forMarket.engine }).toString()}`;
  const count = { mine: items.length, catalog: catalog.length };

  const catalogList = (keys: readonly (keyof typeof FIELDS)[]) => (
    <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4 p-0">
      {keys.map((key) => {
        return (
          <li
            key={key}
            className="flex min-w-0 flex-col gap-2.5 rounded-[22px] border border-border bg-surface px-5 py-[18px]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className={`${CHIP} ${GROUP_CHIP[key]}`}>{t(`groups.${key}`)}</span>
              <span className={`${CHIP} ${ENGINE_CHIP[key]}`}>
                {tc(`strategies.${key}.engine`)}
              </span>
            </div>
            <h2 className="m-0 text-lg font-extrabold">{tc(`strategies.${key}.name`)}</h2>
            <p className="m-0 text-sm leading-normal text-ink-body">{t(`long.${key}`)}</p>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px] leading-[1.45]">
              <dt className="font-bold text-fits">{t("catalog.fits")}</dt>
              <dd className="m-0 text-ink-2">{t(`fits.${key}`)}</dd>
              <dt className="font-bold text-warn">{t("catalog.risk")}</dt>
              <dd className="m-0 text-ink-2">{t(`risks.${key}`)}</dd>
              {VOLUME_KEYS.includes(key) ? (
                <dd className="col-span-2 m-0 font-bold text-ink">
                  {t("catalog.feeRate", {
                    rate: feeLabels(builderFeeRateFor(key, features.data?.builderFees)).pct,
                  })}
                </dd>
              ) : null}
            </dl>
            <Link
              // Copy Trade (DEC-163): chọn trader trước ở Find traders, không dán địa chỉ.
              href={key === "copy_trade" ? "/traders" : `/bots/new/${key}${marketQuery}`}
              className="mt-auto flex min-h-tap items-center justify-center rounded-control bg-accent-tint px-3 text-center text-sm font-bold text-accent-ink no-underline"
            >
              {t("catalog.setUp", { name: tc(`strategies.${key}.name`) })}
            </Link>
          </li>
        );
      })}
    </ul>
  );
  return (
    <WorkspaceShell current="bots" isTeam={me.data?.role === UserRole.team}>
      <div className="flex flex-col gap-5">
        <PageHead
          title={t("title")}
          subtitle={t("subtitle")}
          action={
            <button
              type="button"
              className="flex min-h-tap items-center gap-2 rounded-[14px] bg-accent px-[18px] text-sm font-bold text-white shadow-accent"
              onClick={() => {
                setTab("catalog");
              }}
            >
              <Plus aria-hidden="true" size={16} strokeWidth={2.4} />
              {t("newBot")}
            </button>
          }
        />

        {feeRevoked ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-warn-bg p-4"
          >
            <div className="flex flex-col gap-1">
              <strong>❚❚ {t("feeRevoked.title")}</strong>
              <span className="text-sm">{t("feeRevoked.body")}</span>
            </div>
            <Link href="/settings" className="font-bold">
              {t("feeRevoked.cta")}
            </Link>
          </div>
        ) : null}

        <div
          role="tablist"
          aria-label={t("tabs.label")}
          className="flex gap-1 self-start rounded-[14px] border border-border bg-surface p-1"
        >
          {(["mine", "catalog"] as const).map((key) => (
            <button
              key={key}
              id={`tab-${key}`}
              type="button"
              role="tab"
              aria-selected={tab === key}
              aria-controls={`panel-${key}`}
              onClick={() => {
                setTab(key);
              }}
              className={`flex min-h-10 items-center gap-1.5 rounded-[10px] px-3.5 text-sm font-bold ${tab === key ? "bg-ink text-surface" : "text-ink-2"}`}
            >
              {t(`tabs.${key}`)}
              <span
                className={`rounded-full px-[7px] py-px text-[11px] tabular-nums ${tab === key ? "bg-accent text-white" : "bg-border text-ink-2"}`}
              >
                {count[key]}
              </span>
            </button>
          ))}
        </div>

        <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === "mine" ? (
            <section
              aria-label={t("tabs.mine")}
              className="flex flex-col gap-3.5 rounded-card border border-border bg-surface px-[22px] py-5"
            >
              <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap">
                <FilterSelect
                  label={t("filters.status")}
                  value={status}
                  options={STATUS_FILTERS.map((f) => ({ value: f, label: t(`filters.${f}`) }))}
                  onChange={setStatus}
                />
                <FilterSelect
                  label={t("filters.engine")}
                  value={engine}
                  options={ENGINE_FILTERS.map((f) => ({ value: f, label: t(`filters.${f}`) }))}
                  onChange={setEngine}
                />
              </div>
              {isMobile && bots.isSuccess && rows.length > 0 ? (
                <ul aria-label={t("tabs.mine")} className="m-0 flex list-none flex-col gap-2.5 p-0">
                  {rows.map((b) => (
                    <li
                      key={b.id}
                      className="flex flex-col gap-2.5 rounded-[16px] border border-border p-3.5"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <span className="flex min-w-0 flex-col">
                          <strong className="flex flex-wrap items-center gap-1.5 break-words">
                            {b.name}
                            {b.mode === "paper" ? (
                              <PaperChip short />
                            ) : (
                              <AskAboutThis
                                context={{ kind: "bot", botId: b.id }}
                                subtitle={b.name}
                              />
                            )}
                          </strong>
                          <span className="text-xs text-muted">
                            {botMarket(b, names)} · {tc(`strategies.${b.strategy}.name`)}
                          </span>
                        </span>
                        <StatusPill {...stateLabel(b)} />
                      </div>
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="text-muted">{t("cols.profit")}</span>
                        <BotProfit bot={b} />
                      </div>
                      <BotActions bot={b} stretch />
                    </li>
                  ))}
                </ul>
              ) : (
                <DataTable
                  caption={t("tabs.mine")}
                  label={t("tabs.mine")}
                  status={
                    bots.isPending
                      ? "loading"
                      : bots.isError
                        ? "error"
                        : rows.length === 0
                          ? "empty"
                          : "ready"
                  }
                  empty={{ title: t("empty.title"), description: t("empty.body") }}
                  error={{
                    title: te("generic"),
                    retryLabel: te("retry"),
                    onRetry: () => {
                      void bots.refetch();
                    },
                  }}
                  rows={rows}
                  getRowKey={(b) => b.id}
                  columns={[
                    {
                      key: "bot",
                      header: t("cols.bot"),
                      cell: (b) => (
                        <span className="flex flex-col">
                          <strong className="flex flex-wrap items-center gap-1.5">
                            {b.name}
                            {b.mode === "paper" ? (
                              <PaperChip short />
                            ) : (
                              <AskAboutThis
                                context={{ kind: "bot", botId: b.id }}
                                subtitle={b.name}
                              />
                            )}
                          </strong>
                          <span className="text-xs text-muted">{botMarket(b, names)}</span>
                        </span>
                      ),
                    },
                    {
                      key: "strategy",
                      header: t("cols.strategy"),
                      cell: (b) => tc(`strategies.${b.strategy}.name`),
                    },
                    {
                      key: "mode",
                      header: t("cols.mode"),
                      cell: (b) => (b.state === BotState.draft ? t("modeDraft") : t("mode")),
                    },
                    {
                      key: "status",
                      header: t("cols.status"),
                      cell: (b) => (
                        <span className="flex max-w-[190px] flex-col gap-1">
                          <StatusPill {...stateLabel(b)} />
                          {waitingTooLong(b) ? (
                            <span className="text-xs font-semibold text-warn">
                              {tsh("waitingLong", {
                                time: formatDateTime(b.updatedAt).split(", ").at(-1) ?? "",
                              })}
                            </span>
                          ) : (
                            <span className="text-xs text-muted">
                              {formatDateTime(b.updatedAt)}
                            </span>
                          )}
                        </span>
                      ),
                    },
                    {
                      key: "profit",
                      header: t("cols.profit"),
                      numeric: true,
                      cell: (b) => <BotProfit bot={b} />,
                    },
                    {
                      key: "capital",
                      header: t("cols.capital"),
                      numeric: true,
                      cell: (b) => botCapital(b, names) ?? tm("notAvailable"),
                    },
                    {
                      key: "actions",
                      header: t("cols.actions"),
                      cell: (b) => <BotActions bot={b} />,
                    },
                  ]}
                />
              )}
            </section>
          ) : (
            <>
              {forMarket === null ? null : (
                <p className="m-0 text-sm text-ink-2">
                  {t("catalog.forMarket", { market: names.market(forMarket.market) })}
                </p>
              )}
              {/* Một lưới chung: Market Making và Volume Builder đứng đầu (DEC-133), cùng cỡ thẻ với các chiến lược khác. */}
              {catalogList([
                ...catalog.filter((k) => VOLUME_KEYS.includes(k)),
                ...catalog.filter((k) => !VOLUME_KEYS.includes(k)),
              ])}
            </>
          )}
        </div>
      </div>
    </WorkspaceShell>
  );
}

function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="flex h-10 items-center gap-2 rounded-control border border-border-input px-3 text-[13px] text-muted">
      {label}
      <select
        className="border-0 bg-transparent text-sm font-semibold text-ink"
        value={value}
        onChange={(e) => {
          const next = options.find((o) => o.value === e.target.value);
          if (next !== undefined) onChange(next.value);
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
