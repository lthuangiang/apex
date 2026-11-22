"use client";

import {
  applyCommand,
  BotCommand,
  botDetailSchema,
  newsSignalConfigSchema,
  type BotSummary,
  type ResearchSource,
} from "@drift/shared";
import { Button, SegmentedControl, Select, StatusPill } from "@drift/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useState, type ReactNode } from "react";

import { useStateLabel } from "@/features/bots/components/bots-page";
import { api } from "@/lib/api";
import { useSodexConnection, useTwoFactorNeeded } from "@/lib/queries";

import { DEFAULT_HOW_TAB, type HowTab } from "../research/how-it-works";
import type { ResearchMode } from "../research/mode-memory";
import { DOT, useSourceLine } from "../research/summary-strip";
import { Na, Pill } from "../research/ui";

import {
  TRANSITIONAL_STATES,
  useNewsBotAction,
  useNewsTrades,
  type NewsBotActionVars,
} from "./api";
import { StartNewsBotDialog, StopNewsBotDialog } from "./dialogs";
import { useMainnetErrorText } from "./text";

// Phần đầu trang ở chế độ Mainnet (#421, mockup mainnet-team-test khung 2): dải "Mainnet" có chấm nguồn, ô Bots (Paper /
// Mainnet), ô Bot (My mainnet bots), dòng bot có Pause / Stop… (trạng thái từ backend), khung nhắc cổng + cấu hình bot +
// "Start bot from a version". Không phụ thuộc layout admin: dùng được ở tab Signal Analysis và trang Signal Research.

export type { ResearchMode };

/**
 * Ô "Bots" với hai nút Paper / Mainnet (chỉ đổi chế độ xem; không bao giờ cộng chung paper và mainnet). #454: tab đang chọn
 * mang màu chế độ (Paper cam như dải Paper, Mainnet xanh lá như dải Mainnet).
 */
export function ModeSwitch({
  mode,
  onMode,
}: {
  mode: ResearchMode;
  onMode: (m: ResearchMode) => void;
}) {
  const t = useTranslations("signalAnalysis.research.mainnet.mode");
  return (
    <div className="flex flex-none flex-col gap-1">
      <span aria-hidden="true" className="text-xs font-extrabold">
        {t("label")}
      </span>
      <SegmentedControl
        label={t("label")}
        value={mode}
        options={[
          { value: "paper", label: t("paper"), tone: "warn" },
          { value: "mainnet", label: t("mainnet"), tone: "pos" },
        ]}
        onValueChange={onMode}
      />
    </div>
  );
}

function MainnetBanner({
  sources,
  tz,
}: {
  sources: { items: readonly ResearchSource[]; now: string } | null;
  tz: string;
}) {
  const t = useTranslations("signalAnalysis.research.mainnet.banner");
  const tp = useTranslations("signalAnalysis.research.page.banner");
  const ts = useTranslations("signalAnalysis.research.sources");
  const line = useSourceLine();
  return (
    <div
      role="note"
      className="flex flex-col gap-1 border-b border-pos-border bg-pos-bg px-3 py-2.5 text-xs text-pos md:flex-row md:flex-wrap md:items-center md:gap-x-4 md:px-[18px] md:py-2 md:text-[13px]"
    >
      <strong className="text-[13px] md:text-sm">{t("title")}</strong>
      <span>{t("body")}</span>
      {sources === null || sources.items.length === 0 ? null : (
        <ul
          aria-label={tp("sourcesLabel")}
          className="m-0 flex list-none flex-col gap-0.5 p-0 md:flex-row md:flex-wrap md:gap-x-4"
        >
          {sources.items.map((s) => {
            const l = line(s, sources.now, tz);
            return (
              <li key={s.key} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={`size-2 flex-none rounded-full ${DOT[s.status]}`}
                />
                {l.text}
                {l.statusShown ? null : (
                  <span className="sr-only">
                    {ts("statusSr", { status: ts(`status.${s.status}`) })}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Config của bot (version đang chạy) để ghi dòng cấu hình; null = chưa có / không đọc được. */
function useBotConfig(botId: string | null) {
  const q = useQuery({
    queryKey: ["bot", botId],
    queryFn: () => api("GET", `/api/v1/bots/${botId ?? ""}`, botDetailSchema),
    enabled: botId !== null,
    refetchInterval: 10_000,
  });
  const active = q.data?.versions.find((v) => v.status === "active");
  const parsed = newsSignalConfigSchema.safeParse(active?.config);
  return parsed.success ? parsed.data : null;
}

export function MainnetPanel({
  sources,
  tz,
  modeSwitch,
  bots,
  botsLoading,
  botsError,
  selected,
  onBot,
  onHow,
  onStartFromVersion,
}: {
  sources: { items: readonly ResearchSource[]; now: string } | null;
  tz: string;
  modeSwitch: ReactNode;
  bots: readonly BotSummary[];
  botsLoading: boolean;
  /** Lỗi khi tải danh sách bot (ví dụ 403); null = không lỗi. */
  botsError: string | null;
  selected: BotSummary | null;
  onBot: (id: string) => void;
  onHow: (tab: HowTab) => void;
  onStartFromVersion: () => void;
}) {
  const t = useTranslations("signalAnalysis.research.mainnet");
  const tp = useTranslations("signalAnalysis.research.page");
  const stateLabel = useStateLabel();
  const errorText = useMainnetErrorText();
  const id = useId();
  const [dialog, setDialog] = useState<"stop" | "start" | null>(null);
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const twoFactorNeeded = useTwoFactorNeeded();
  const conn = useSodexConnection();
  const trades = useNewsTrades(selected?.id ?? null);
  const config = useBotConfig(selected?.id ?? null);
  const act = useNewsBotAction(() => {
    setDialog(null);
    setCode("");
  });
  const send = (v: NewsBotActionVars) => {
    act.mutate(v, {
      onError: (e) => {
        if (e instanceof Error && "code" in e && e.code === "TWO_FACTOR_REQUIRED")
          setNeedCode(true);
      },
    });
  };
  const c = conn.data?.connection;
  const last4 = c?.status === "connected" && c.apiKey !== null ? c.apiKey.last4 : null;
  const openCount =
    trades.data === undefined
      ? null
      : trades.data.items.filter((x) => x.status !== "closed").length;
  const can = (cmd: (typeof BotCommand)[keyof typeof BotCommand]) =>
    selected !== null && applyCommand(selected.state, cmd) !== null;
  const busy = selected !== null && TRANSITIONAL_STATES.includes(selected.state);
  const actError = act.error === null ? null : errorText(act.error);

  const picker = botsLoading ? (
    <span className="text-sm text-muted">{t("loading")}</span>
  ) : (
    <Select
      id={`${id}-bot`}
      value={selected?.id ?? ""}
      onChange={(e) => {
        onBot(e.target.value);
      }}
      className="w-full md:w-auto md:min-w-[190px]"
    >
      {bots.length === 0 ? <option value="">{t("noBots")}</option> : null}
      <optgroup label={t("botGroup")}>
        {bots.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </optgroup>
    </Select>
  );

  const pill =
    selected === null
      ? null
      : (() => {
          const s = stateLabel(selected);
          return (
            <StatusPill
              state={s.state}
              label={s.label}
              {...(s.reason === undefined ? {} : { reason: s.reason })}
              {...(s.reasonLabel === undefined ? {} : { reasonLabel: s.reasonLabel })}
            />
          );
        })();

  const strip =
    selected === null ? null : (
      <div
        aria-label={t("strip.label")}
        role="group"
        className="flex min-h-[52px] flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-tile border-l-[3px] border-neg bg-surface-2 px-4 py-1.5 text-sm"
      >
        <strong className="font-extrabold">{selected.name}</strong>
        <Pill tone="neg">{t("strip.mainnet")}</Pill>
        {pill}
        {last4 === null ? null : (
          <span className="tabular-nums">{t("strip.account", { last4 })}</span>
        )}
        <span>
          {t("strip.result")} <Na />
        </span>
        {openCount === null ? null : <span>{t("strip.open", { n: openCount })}</span>}
        <span className="ml-auto flex flex-wrap gap-2">
          {can(BotCommand.pause) ? (
            <Button
              variant="secondary"
              pending={act.isPending && act.variables.action === "pause"}
              disabled={busy}
              onClick={() => {
                send({ id: selected.id, action: "pause", body: {} });
              }}
            >
              {t("strip.pause")}
            </Button>
          ) : null}
          {can(BotCommand.resume) ? (
            <Button
              variant="secondary"
              pending={act.isPending && act.variables.action === "resume"}
              onClick={() => {
                send({ id: selected.id, action: "resume", body: {} });
              }}
            >
              {t("strip.resume")}
            </Button>
          ) : null}
          {can(BotCommand.start) ? (
            <Button
              onClick={() => {
                act.reset();
                setDialog("start");
              }}
            >
              {t("strip.start")}
            </Button>
          ) : null}
          {can(BotCommand.stop) ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                act.reset();
                setDialog("stop");
              }}
              className="inline-flex min-h-tap cursor-pointer items-center rounded-control border border-neg bg-surface px-4 text-sm font-bold text-neg-ink disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t("strip.stop")}
            </button>
          ) : null}
        </span>
        {dialog === null && actError !== null ? (
          <p role="alert" className="m-0 w-full text-sm font-semibold text-neg-ink">
            {actError}
          </p>
        ) : null}
      </div>
    );

  const configLine =
    config === null
      ? null
      : config.maxNewTradesPerDay === null
        ? t("count.configNoDay", { size: config.sizeUsdc, open: config.maxOpenTrades })
        : t("count.config", {
            size: config.sizeUsdc,
            open: config.maxOpenTrades,
            day: config.maxNewTradesPerDay,
          });

  return (
    <section
      aria-label={t("banner.title")}
      className="overflow-hidden rounded-card bg-surface shadow-card"
    >
      <MainnetBanner sources={sources} tz={tz} />
      <div className="flex flex-col gap-2.5 p-3 md:grid md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-start md:gap-x-5 md:gap-y-3 md:px-[18px] md:py-3.5">
        <div className="flex min-w-0 flex-wrap items-end gap-3 md:col-start-1 md:row-start-1">
          {modeSwitch}
          <div className="flex min-w-0 flex-1 flex-col gap-1 md:flex-none">
            {botsLoading ? (
              <span className="text-xs font-extrabold">{t("bot")}</span>
            ) : (
              <label htmlFor={`${id}-bot`} className="text-xs font-extrabold">
                {t("bot")}
              </label>
            )}
            {picker}
          </div>
        </div>
        <div className="min-w-0 md:col-start-2 md:row-start-1 md:pt-[18px]">
          {botsError === null ? (
            strip
          ) : (
            <p role="alert" className="m-0 text-sm font-semibold text-neg-ink">
              {botsError}
            </p>
          )}
        </div>
        <div className="flex-none md:col-start-3 md:row-start-1 md:pt-[18px]">
          <button
            type="button"
            onClick={() => {
              onHow(DEFAULT_HOW_TAB);
            }}
            className="inline-flex min-h-11 flex-none cursor-pointer items-center rounded-control border border-accent bg-surface px-3.5 text-[13px] font-extrabold text-accent-ink hover:bg-surface-2 md:text-sm"
          >
            {tp("howItWorks")}
          </button>
        </div>
        <div className="flex flex-col gap-2.5 rounded-tile bg-accent-tint px-3 py-3 md:col-span-3 md:row-start-2 md:flex-row md:flex-wrap md:items-center md:justify-between md:px-3.5 md:py-2.5">
          <div className="flex min-w-0 flex-col gap-1 text-sm text-ink">
            <p className="m-0 flex flex-wrap items-center gap-2">
              <Pill tone="warn">{t("count.pill")}</Pill>
              <span>{t("count.notForecast")}</span>
            </p>
            {configLine === null ? null : <p className="m-0 text-xs text-ink-2">{configLine}</p>}
          </div>
          <Button onClick={onStartFromVersion} className="font-extrabold">
            {t("count.start")}
          </Button>
        </div>
      </div>
      {dialog === "stop" && selected !== null ? (
        <StopNewsBotDialog
          bot={selected}
          openTrades={openCount}
          pending={act.isPending}
          error={actError}
          onClose={() => {
            setDialog(null);
          }}
          onConfirm={(closeAll) => {
            send({ id: selected.id, action: "stop", body: { closePosition: closeAll } });
          }}
        />
      ) : null}
      {dialog === "start" && selected !== null ? (
        <StartNewsBotDialog
          bot={selected}
          twoFactor={twoFactorNeeded || needCode ? { value: code, onChange: setCode } : null}
          pending={act.isPending}
          error={actError}
          onClose={() => {
            setDialog(null);
          }}
          onConfirm={() => {
            send({
              id: selected.id,
              action: "start",
              body: {
                acknowledged: true,
                ...(code.trim() === "" ? {} : { twoFactorCode: code.trim() }),
              },
            });
          }}
        />
      ) : null}
    </section>
  );
}
