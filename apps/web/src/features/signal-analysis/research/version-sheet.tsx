"use client";

import {
  AssetMode,
  baselineVersionConfig,
  botVersionConfigSchema,
  defaultMaxOpenTrades,
  diffVersionConfig,
  ErrorCode,
  NEWS_RULES,
  OppositeNewsPolicy,
  SIGNAL_CATALYSTS,
  VERSION_START_BALANCE,
  type BotVersionConfig,
  type ResearchVersion,
  type ResearchVersionCreateBody,
  type SignalCatalyst,
} from "@drift/shared";
import { BottomSheet, Button, SegmentedControl } from "@drift/ui";
import { useTranslations } from "next-intl";
import { useId, useRef, useState, type ReactNode } from "react";

import { ApiError } from "@/lib/api";
import { uncertainOutcome } from "@/lib/financial-action";
import { BELOW_LG, useMediaQuery } from "@/lib/use-media";

import { count } from "../format";

import { AssetPicker, type MarketsState } from "./asset-picker";
import { hold } from "./format";
import { catalystName, catalystSide, changeText, isTreasury } from "./version-text";

// Sheet tạo News bot version (#306; thiết kế docs/mockups/signal-research/bot-versions-editor.html): desktop là sheet bám
// cạnh phải, điện thoại toàn màn hình. Config bất biến sau khi lưu (DEC-328); "Rules" mở cùng sheet ở chế độ chỉ xem.
// Số nhập dùng dấu chấm thập phân; kiểm như `botVersionConfigSchema` của API (TP tối thiểu ≥ 1× chi phí…).

type Level = BotVersionConfig["minLevel"];
type Mode = BotVersionConfig["assets"]["mode"];
type Policy = BotVersionConfig["onOppositeNews"];

export interface Draft {
  name: string;
  news: Record<SignalCatalyst, { enabled: boolean; hold: number }>;
  minLevel: Level;
  maxDelay: string;
  size: string;
  minTp: string;
  tp: string;
  sl: string;
  maxOpen: string;
  dayLimit: boolean;
  perDay: string;
  opposite: Policy;
  mode: Mode;
  /** Giữ khi đổi chế độ ("Switching mode keeps the picked assets"); chế độ All gửi danh sách rỗng. */
  markets: string[];
  crypto: boolean;
  stocks: boolean;
}

export function draftOf(cfg: BotVersionConfig, name: string): Draft {
  const news = {} as Draft["news"];
  for (const c of SIGNAL_CATALYSTS) {
    const x = cfg.news[c];
    news[c] = {
      enabled: x?.enabled === true,
      hold: x?.maxHoldHours ?? NEWS_RULES.catalysts[c].maxHoldHours,
    };
  }
  return {
    name,
    news,
    minLevel: cfg.minLevel,
    maxDelay: String(cfg.maxSourceDelayMinutes),
    size: cfg.sizeUsdc,
    minTp: cfg.minTpCostMultiple,
    tp: cfg.tpMultiple,
    sl: cfg.slMultiple,
    maxOpen: String(cfg.maxOpenTrades),
    dayLimit: cfg.maxNewTradesPerDay !== null,
    perDay: cfg.maxNewTradesPerDay === null ? "" : String(cfg.maxNewTradesPerDay),
    opposite: cfg.onOppositeNews,
    mode: cfg.assets.mode,
    markets: [...cfg.assets.markets],
    crypto: cfg.assets.crypto,
    stocks: cfg.assets.stocks,
  };
}

export type FieldKey =
  "name" | "maxDelay" | "size" | "minTp" | "tp" | "sl" | "maxOpen" | "perDay" | "markets" | "kinds";

export type FieldError =
  | { key: "required" | "number" | "whole" | "positive" | "atLeastOne" | "aboveBalance" }
  | { key: "range"; min: number; max: number }
  | { key: "pickAsset" | "pickKind" };

const DECIMAL = /^\d+(\.\d+)?$/;
const WHOLE = /^\d+$/;

function decimalError(v: string, min: "positive" | "atLeastOne"): FieldError | null {
  const s = v.trim();
  if (s === "") return { key: "required" };
  if (!DECIMAL.test(s)) return { key: "number" };
  const n = Number(s);
  if (min === "positive" ? n <= 0 : n < 1) return { key: min };
  return null;
}

function wholeError(v: string, min: number, max: number): FieldError | null {
  const s = v.trim();
  if (s === "") return { key: "required" };
  if (!WHOLE.test(s)) return { key: DECIMAL.test(s) ? "whole" : "number" };
  const n = Number(s);
  return n < min || n > max ? { key: "range", min, max } : null;
}

/** Lỗi từng ô (thuần, có test). Ô không có trong kết quả là hợp lệ. */
export function validate(d: Draft): Partial<Record<FieldKey, FieldError>> {
  const e: Partial<Record<FieldKey, FieldError>> = {};
  const name = d.name.trim();
  if (name === "") e.name = { key: "required" };
  else if (name.length > 60) e.name = { key: "range", min: 1, max: 60 };
  const delay = wholeError(d.maxDelay, 1, NEWS_RULES.maxSourceDelayMinutes);
  if (delay !== null) e.maxDelay = delay;
  const size = decimalError(d.size, "positive");
  if (size !== null) e.size = size;
  else if (Number(d.size) > Number(VERSION_START_BALANCE)) e.size = { key: "aboveBalance" };
  const minTp = decimalError(d.minTp, "atLeastOne");
  if (minTp !== null) e.minTp = minTp;
  const tp = decimalError(d.tp, "positive");
  if (tp !== null) e.tp = tp;
  const sl = decimalError(d.sl, "positive");
  if (sl !== null) e.sl = sl;
  const open = wholeError(d.maxOpen, 1, 1000);
  if (open !== null) e.maxOpen = open;
  if (d.dayLimit) {
    const day = wholeError(d.perDay, 1, 1000);
    if (day !== null) e.perDay = day;
  }
  if (d.mode === AssetMode.only && d.markets.length === 0) e.markets = { key: "pickAsset" };
  if (d.mode !== AssetMode.only && !d.crypto && !d.stocks) e.kinds = { key: "pickKind" };
  return e;
}

/** Config gửi API; null khi còn lỗi ở một ô của config (tên không thuộc config). */
export function configOf(d: Draft): BotVersionConfig | null {
  if (Object.keys(validate(d)).some((k) => k !== "name")) return null;
  const news: BotVersionConfig["news"] = {};
  for (const c of SIGNAL_CATALYSTS)
    news[c] = { enabled: d.news[c].enabled, maxHoldHours: d.news[c].hold };
  const parsed = botVersionConfigSchema.safeParse({
    news,
    minLevel: d.minLevel,
    maxSourceDelayMinutes: Number(d.maxDelay.trim()),
    sizeUsdc: d.size.trim(),
    tpMultiple: d.tp.trim(),
    slMultiple: d.sl.trim(),
    minTpCostMultiple: d.minTp.trim(),
    assets: {
      mode: d.mode,
      markets: d.mode === AssetMode.all ? [] : d.markets,
      crypto: d.crypto,
      stocks: d.stocks,
    },
    maxOpenTrades: Number(d.maxOpen.trim()),
    maxNewTradesPerDay: d.dayLimit ? Number(d.perDay.trim()) : null,
    onOppositeNews: d.opposite,
  });
  return parsed.success ? parsed.data : null;
}

/** Body của `POST /versions` ("Save and start"). */
export function bodyOf(d: Draft, from: ResearchVersion | null): ResearchVersionCreateBody | null {
  const config = configOf(d);
  if (config === null || validate(d).name !== undefined) return null;
  return {
    name: d.name.trim(),
    config,
    savedFromVersionId: from?.id ?? null,
    start: true,
  };
}

const HOLDS = [6, 12, 24, 48, 72, 120, 168] as const;

export type SheetMode =
  { kind: "new"; from: ResearchVersion | null } | { kind: "rules"; of: ResearchVersion };

export function VersionSheet({
  mode,
  next,
  running,
  maxRunning,
  markets,
  pending,
  checking,
  error,
  onClose,
  onSave,
}: {
  mode: SheetMode;
  /** Số của version sẽ được tạo (max + 1, như DB). */
  next: number;
  running: number;
  maxRunning: number;
  markets: MarketsState;
  pending: boolean;
  checking: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (body: ResearchVersionCreateBody) => void;
}) {
  const t = useTranslations("signalAnalysis.research.versions");
  const tn = useTranslations("signalAnalysis.research");
  const tc = useTranslations("common.errors");
  const mobile = useMediaQuery(BELOW_LG);
  const view = mode.kind === "rules";
  const source = mode.kind === "rules" ? mode.of : mode.from;
  const [d, setD] = useState<Draft>(() =>
    draftOf(source?.config ?? baselineVersionConfig(), mode.kind === "rules" ? mode.of.name : ""),
  );
  const [touched, setTouched] = useState<ReadonlySet<FieldKey>>(new Set());
  const [tried, setTried] = useState(false);
  const pickerOpen = useRef(false);
  const id = useId();

  const errors = view ? {} : validate(d);
  const shown = (k: FieldKey) => (tried || touched.has(k) ? errors[k] : undefined);
  const set = (p: Partial<Draft>, k?: FieldKey) => {
    setD((x) => ({ ...x, ...p }));
    if (k !== undefined) setTouched((s) => new Set(s).add(k));
  };
  const errText = (e: FieldError | undefined): string | undefined => {
    if (e === undefined) return undefined;
    if (e.key === "range") return t("sheet.errors.range", { min: e.min, max: e.max });
    return t(`sheet.errors.${e.key}`);
  };

  const config = view ? null : configOf(d);
  const full = running >= maxRunning;
  const changes =
    !view && source?.config != null && config !== null
      ? diffVersionConfig(source.config, config)
      : null;
  const sizeOk = errors.size === undefined;
  const maxOpenN = WHOLE.test(d.maxOpen.trim()) ? Number(d.maxOpen.trim()) : null;
  const effective =
    d.mode === AssetMode.only && maxOpenN !== null && new Set(d.markets).size < maxOpenN
      ? new Set(d.markets).size
      : null;

  const title =
    mode.kind === "rules"
      ? t("sheet.rulesTitle", { n: mode.of.number, name: mode.of.name })
      : source === null
        ? t("sheet.titleNew")
        : t("sheet.titleFrom", { n: source.number });
  const description =
    mode.kind === "rules"
      ? t("sheet.rulesDesc")
      : source === null
        ? t("sheet.descNew", { next })
        : source.status === "running"
          ? t("sheet.descFrom", { next, n: source.number })
          : t("sheet.descFromIdle", { next, n: source.number });

  const save = () => {
    setTried(true);
    const body = bodyOf(d, source);
    if (body === null || full || pending) return;
    onSave(body);
  };
  const formError = tried && Object.keys(errors).length > 0 ? t("sheet.errors.fix") : null;

  return (
    <BottomSheet
      open
      onOpenChange={(o) => {
        if (!o && !pending) onClose();
      }}
      title={title}
      description={description}
      closeLabel={t("sheet.close")}
      side
      onEscapeKeyDown={(e) => {
        // Esc khi danh sách tài sản đang mở chỉ đóng danh sách (thiết kế: "Esc to close").
        if (pickerOpen.current || pending) e.preventDefault();
      }}
      footer={
        view ? (
          <Button variant="secondary" onClick={onClose}>
            {t("sheet.close")}
          </Button>
        ) : (
          <div className="flex w-full flex-col gap-2.5 md:flex-row md:items-center md:justify-between">
            <p className="m-0 text-xs leading-normal text-muted" id={`${id}-foot`}>
              {t("sheet.footer", { n: running, max: maxRunning, next })}
              {full ? (
                <span className="block font-semibold text-warn">{t("sheet.full")}</span>
              ) : null}
            </p>
            <div className="flex flex-col gap-2 md:flex-row">
              <Button variant="secondary" disabled={pending} onClick={onClose}>
                {t("sheet.cancel")}
              </Button>
              <Button
                pending={pending}
                disabled={full}
                aria-describedby={`${id}-foot`}
                onClick={save}
              >
                {pending ? t("sheet.saving") : t("sheet.save", { next })}
              </Button>
            </div>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-name`} className="text-sm font-semibold text-ink">
          {t("sheet.name")}
        </label>
        <input
          id={`${id}-name`}
          type="text"
          value={d.name}
          disabled={view}
          maxLength={60}
          aria-invalid={shown("name") === undefined ? undefined : true}
          aria-describedby={shown("name") === undefined ? undefined : `${id}-name-e`}
          onChange={(e) => {
            set({ name: e.target.value }, "name");
          }}
          className={input}
        />
        <Err id={`${id}-name-e`} text={errText(shown("name"))} />
      </div>

      <Group legend={t("sheet.newsTypes")}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{t("sheet.newsTable")}</caption>
            <thead>
              <tr>
                {(["colTrade", "colType", "colDir", "colHold"] as const).map((k) => (
                  <th
                    key={k}
                    scope="col"
                    className="border-b border-border px-2 py-2 text-left text-xs font-bold text-muted"
                  >
                    {t(`sheet.${k}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SIGNAL_CATALYSTS.map((c) => {
                const type = catalystName(c, tn);
                const row = d.news[c];
                const opts = (HOLDS as readonly number[]).includes(row.hold)
                  ? HOLDS
                  : [...HOLDS, row.hold].sort((a, b) => a - b);
                return (
                  <tr key={c}>
                    <td className={cell}>
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        disabled={view}
                        aria-label={t("sheet.tradeType", { type })}
                        onChange={(e) => {
                          set({ news: { ...d.news, [c]: { ...row, enabled: e.target.checked } } });
                        }}
                        className="size-5 accent-accent"
                      />
                    </td>
                    <td className={cell}>
                      {type}
                      {isTreasury(c) ? (
                        <span className="block text-xs text-muted">{t("sheet.treasuryNote")}</span>
                      ) : null}
                    </td>
                    <td className={cell}>{tn(`sides.${catalystSide(c)}`)}</td>
                    <td className={cell}>
                      <select
                        value={row.hold}
                        disabled={view}
                        aria-label={t("sheet.holdOf", { type })}
                        onChange={(e) => {
                          set({
                            news: { ...d.news, [c]: { ...row, hold: Number(e.target.value) } },
                          });
                        }}
                        className={`${input} w-auto min-w-[5.5rem]`}
                      >
                        {opts.map((h) => (
                          <option key={h} value={h}>
                            {hold(h)}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="m-0 text-xs text-muted">{t("sheet.directionNote")}</p>
      </Group>

      <Group legend={t("sheet.quality")} grid>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-lvl`} className={lbl}>
            {t("sheet.minLevel")}
          </label>
          <select
            id={`${id}-lvl`}
            value={d.minLevel}
            disabled={view}
            onChange={(e) => {
              set({ minLevel: e.target.value as Level });
            }}
            className={input}
          >
            {(["high", "medium", "low"] as const).map((l) => (
              <option key={l} value={l}>
                {t(`sheet.levelOpt.${l}`)}
              </option>
            ))}
          </select>
        </div>
        <Num
          label={t("sheet.maxDelay")}
          unit={t("sheet.maxDelayUnit")}
          value={d.maxDelay}
          inputMode="numeric"
          disabled={view}
          error={errText(shown("maxDelay"))}
          onChange={(v) => {
            set({ maxDelay: v }, "maxDelay");
          }}
        />
      </Group>

      <Group legend={t("sheet.orders")} grid>
        <Num
          label={t("sheet.size")}
          value={d.size}
          disabled={view}
          wide
          error={errText(shown("size"))}
          onChange={(v) => {
            set({ size: v }, "size");
          }}
        />
        <Num
          label={t("sheet.minTp")}
          unit={t("sheet.minTpUnit")}
          hint={t("sheet.minTpHint")}
          value={d.minTp}
          disabled={view}
          error={errText(shown("minTp"))}
          onChange={(v) => {
            set({ minTp: v }, "minTp");
          }}
        />
        <Num
          label={t("sheet.tp")}
          unit={t("sheet.moveUnit")}
          value={d.tp}
          disabled={view}
          error={errText(shown("tp"))}
          onChange={(v) => {
            set({ tp: v }, "tp");
          }}
        />
        <Num
          label={t("sheet.sl")}
          unit={t("sheet.moveUnit")}
          value={d.sl}
          disabled={view}
          error={errText(shown("sl"))}
          onChange={(v) => {
            set({ sl: v }, "sl");
          }}
        />
        <Num
          label={t("sheet.maxOpen")}
          unit={t("sheet.maxOpenUnit")}
          hint={
            sizeOk
              ? t("sheet.maxOpenHint", {
                  n: defaultMaxOpenTrades(d.size.trim()),
                  size: count(Number(d.size)),
                })
              : undefined
          }
          note={effective === null ? undefined : t("effectively", { n: effective })}
          value={d.maxOpen}
          inputMode="numeric"
          disabled={view}
          error={errText(shown("maxOpen"))}
          onChange={(v) => {
            set({ maxOpen: v }, "maxOpen");
          }}
        />
        <div className="flex flex-col gap-1.5">
          <span className={lbl} id={`${id}-day`}>
            {t("sheet.maxDay")}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              label={t("sheet.maxDay")}
              value={d.dayLimit ? "limit" : "off"}
              disabled={view}
              options={[
                { value: "off", label: t("sheet.off") },
                { value: "limit", label: t("sheet.limit") },
              ]}
              onValueChange={(v) => {
                set({ dayLimit: v === "limit" });
              }}
            />
            {d.dayLimit ? (
              <input
                type="text"
                inputMode="numeric"
                aria-label={t("sheet.perDay")}
                value={d.perDay}
                disabled={view}
                aria-invalid={shown("perDay") === undefined ? undefined : true}
                aria-describedby={shown("perDay") === undefined ? undefined : `${id}-pd-e`}
                onChange={(e) => {
                  set({ perDay: e.target.value }, "perDay");
                }}
                className={`${input} w-24`}
              />
            ) : null}
            <span className="text-xs text-muted">{t("sheet.maxDayHint")}</span>
          </div>
          <Err id={`${id}-pd-e`} text={errText(shown("perDay"))} />
        </div>
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <span className={lbl}>{t("sheet.opposite")}</span>
          <SegmentedControl
            label={t("sheet.opposite")}
            value={d.opposite}
            disabled={view}
            options={[
              { value: OppositeNewsPolicy.keep, label: t("sheet.keep") },
              { value: OppositeNewsPolicy.close, label: t("sheet.closeMarket") },
            ]}
            onValueChange={(v) => {
              set({ opposite: v });
            }}
          />
          <span className="text-xs leading-normal text-muted">{t("sheet.oppositeHint")}</span>
        </div>
        <p className="m-0 rounded-tile bg-surface-2 p-3 text-xs leading-normal text-ink-2 md:col-span-2">
          {t("sheet.shadowNote", { n: maxOpenN ?? d.maxOpen })}
        </p>
      </Group>

      <Group legend={t("sheet.assets")}>
        {/* PM: ẩn Crypto / Stocks ở chế độ Only these (danh sách đã chọn đúng từng market). */}
        {d.mode === AssetMode.only ? null : (
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap gap-4">
              <label className="inline-flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={d.crypto}
                  disabled={view}
                  onChange={(e) => {
                    set({ crypto: e.target.checked }, "kinds");
                  }}
                  className="size-5 accent-accent"
                />
                {t("sheet.crypto")}
              </label>
              <label className="inline-flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={d.stocks}
                  disabled={view}
                  onChange={(e) => {
                    set({ stocks: e.target.checked }, "kinds");
                  }}
                  className="size-5 accent-accent"
                />
                {t("sheet.stocks")}
              </label>
            </div>
            <Err id={`${id}-k-e`} text={errText(shown("kinds"))} />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <span className={lbl}>{t("sheet.which")}</span>
          <SegmentedControl
            label={t("sheet.which")}
            value={d.mode}
            disabled={view}
            options={(["all", "only", "except"] as const).map((m) => ({
              value: m,
              label: t(`sheet.modes.${m}`),
            }))}
            onValueChange={(v) => {
              set({ mode: v });
            }}
          />
          <span className="text-xs text-muted">{t("sheet.whichHint")}</span>
        </div>
        {d.mode === AssetMode.all ? null : (
          <div className="flex flex-col gap-1">
            <AssetPicker
              markets={markets}
              value={d.markets}
              mode={d.mode}
              mobile={mobile}
              disabled={view}
              invalid={shown("markets") !== undefined}
              describedBy={shown("markets") === undefined ? undefined : `${id}-m-e`}
              onChange={(m) => {
                set({ markets: m }, "markets");
              }}
              onOpenChange={(o) => {
                pickerOpen.current = o;
              }}
            />
            <Err id={`${id}-m-e`} text={errText(shown("markets"))} />
          </div>
        )}
      </Group>

      {view ? null : (
        <div className="rounded-tile bg-accent-tint p-3.5 text-sm leading-normal text-accent-ink">
          {source === null ? null : changes === null ? null : changes.length === 0 ? (
            <span className="block">{t("sheet.noChanges", { n: source.number })}</span>
          ) : (
            <span className="block">
              {t.rich("sheet.changed", {
                n: source.number,
                list: changes.map((c) => changeText(c, config, t, tn)).join(" · "),
                b: (c: ReactNode) => <b>{c}</b>,
              })}
            </span>
          )}
          <span className="block">{t("sheet.countNote", { next })}</span>
        </div>
      )}
      {checking ? (
        <p role="status" className="m-0 text-sm font-semibold text-ink-2">
          {tc("unconfirmed")}
        </p>
      ) : error !== null || formError !== null ? (
        <p role="alert" className="m-0 text-sm font-semibold text-neg-ink">
          {error ?? formError}
        </p>
      ) : null}
    </BottomSheet>
  );
}

/** Câu lỗi khi lưu version (C6: chỉ dùng `code` / `details`, không hiện message của server). */
export function saveErrorText(
  e: unknown,
  t: ReturnType<typeof useTranslations<"signalAnalysis.research.versions">>,
  unconfirmed: string,
): string {
  // Kết quả không rõ (mạng, 5xx, 409 unknown / in_progress): không được khẳng định là chưa có gì thay đổi (quy tắc 1.8).
  if (uncertainOutcome(e) !== null) return unconfirmed;
  if (e instanceof ApiError) {
    if (e.code === ErrorCode.stateConflict && e.details.reason === "MAX_RUNNING_VERSIONS")
      return t("errors.maxRunning");
    if (e.code === ErrorCode.marketListUnavailable) return t("sheet.errors.marketsMissing");
    const markets = e.details.markets;
    if (e.code === ErrorCode.validationFailed && Array.isArray(markets) && markets.length > 0)
      return t("sheet.errors.notListed", { list: markets.map(String).join(", ") });
  }
  return t("sheet.errors.generic");
}

const input =
  "min-h-tap w-full rounded-control border border-border-input bg-surface px-3 text-sm text-ink tabular-nums aria-invalid:border-neg disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-2";
const lbl = "text-sm font-semibold text-ink";
const cell = "border-b border-bg px-2 py-2 align-middle";

function Group({
  legend,
  grid = false,
  children,
}: {
  legend: string;
  grid?: boolean;
  children: ReactNode;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-3 rounded-tile border border-border p-3.5 md:p-4">
      <legend className="px-1 text-[15px] font-extrabold text-ink">{legend}</legend>
      {grid ? <div className="grid gap-3.5 md:grid-cols-2">{children}</div> : children}
    </fieldset>
  );
}

function Err({ id, text }: { id: string; text: string | undefined }) {
  if (text === undefined) return null;
  return (
    <p id={id} className="m-0 text-xs font-semibold text-neg-ink">
      {text}
    </p>
  );
}

function Num({
  label,
  unit,
  hint,
  note,
  value,
  error,
  disabled,
  wide = false,
  inputMode = "decimal",
  onChange,
}: {
  label: string;
  unit?: string;
  hint?: string | undefined;
  note?: string | undefined;
  value: string;
  error: string | undefined;
  disabled: boolean;
  wide?: boolean;
  inputMode?: "decimal" | "numeric";
  onChange: (v: string) => void;
}) {
  const id = useId();
  const describedBy = [
    unit === undefined ? null : `${id}-u`,
    hint === undefined ? null : `${id}-h`,
    note === undefined ? null : `${id}-n`,
    error === undefined ? null : `${id}-e`,
  ]
    .filter((x) => x !== null)
    .join(" ");
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={lbl}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="text"
          inputMode={inputMode}
          value={value}
          disabled={disabled}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy === "" ? undefined : describedBy}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          className={`${input} ${wide ? "" : "max-w-[7.5rem]"}`}
        />
        {unit === undefined ? null : (
          <span id={`${id}-u`} className="text-sm text-ink-2">
            {unit}
          </span>
        )}
      </div>
      {hint === undefined ? null : (
        <span id={`${id}-h`} className="text-xs text-muted">
          {hint}
        </span>
      )}
      {note === undefined ? null : (
        <span id={`${id}-n`} className="text-xs font-semibold text-ink-2">
          {note}
        </span>
      )}
      <Err id={`${id}-e`} text={error} />
    </div>
  );
}
