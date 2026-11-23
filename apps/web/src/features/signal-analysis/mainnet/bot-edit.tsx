"use client";

import {
  AssetMode,
  ErrorCode,
  NEWS_SIGNAL_LEVERAGES,
  type BotVersionConfig,
  type NewsBotVersionResult,
  type NewsSignalConfig,
  type NewsSignalLeverage,
} from "@drift/shared";
import { BottomSheet, Button, SegmentedControl } from "@drift/ui";
import { useTranslations } from "next-intl";
import { useId, useRef, useState, type ReactNode } from "react";

import { ApiError } from "@/lib/api";
import { useTwoFactorNeeded } from "@/lib/queries";
import { BELOW_LG, useMediaQuery } from "@/lib/use-media";

import { useResearchMarkets } from "../research/api";
import { Pill } from "../research/ui";
import {
  AssetsGroup,
  draftOf,
  Err,
  Group,
  input,
  lbl,
  MarginCalc,
  Num,
  validateBot,
  type Draft,
  type FieldError,
  type FieldKey,
} from "../research/version-sheet";

import { useNewsTrades, useSaveNewsVersion } from "./api";
import { useMainnetErrorText, useMarketsText } from "./text";

// Edit bot `news_signal` Mainnet (#469 phần 2, mockup docs/mockups/signal-research/news-signal-settings.html khung 3): lưu
// thành version mới của bot. Chỉ 5 ô sửa được (PM chốt): Leverage, Position size, Max open trades, Markets (chỉ thu hẹp
// version gốc), Min level (chỉ nâng). Mọi field khác gửi đúng như version đang chạy (API từ chối `locked` nếu khác).
// Lệnh đang mở giữ TP / SL, max hold và đòn bẩy lúc vào; config mới chỉ áp cho tín hiệu sau. Trạng thái lấy từ backend
// (quy tắc 1.6): lưu xong chỉ đọc lại, "Applying v{n}…" tới khi engine xác nhận.

type Level = BotVersionConfig["minLevel"];

/** 5 ô của form Edit. */
export interface EditDraft {
  leverage: NewsSignalLeverage;
  size: string;
  maxOpen: string;
  minLevel: Level;
  mode: Draft["mode"];
  markets: string[];
  crypto: boolean;
  stocks: boolean;
}

export const editDraftOf = (cfg: NewsSignalConfig): EditDraft => ({
  leverage: cfg.leverage,
  size: cfg.sizeUsdc,
  maxOpen: String(cfg.maxOpenTrades),
  minLevel: cfg.minLevel,
  mode: cfg.assets.mode,
  markets: [...cfg.assets.markets],
  crypto: cfg.assets.crypto,
  stocks: cfg.assets.stocks,
});

/** Draft đầy đủ của editor version (để dùng lại `validateBot`): 5 ô từ form, còn lại từ version đang chạy. */
const fullDraft = (current: NewsSignalConfig, e: EditDraft): Draft => ({
  ...draftOf(current, "-"),
  ...e,
});

/** Lỗi từng ô, khớp API (`newsSignalConfigSchema` + `narrowsVersion` với version gốc). Thuần, có test. */
export function validateEdit(
  current: NewsSignalConfig,
  e: EditDraft,
  source: BotVersionConfig | null,
): Partial<Record<FieldKey, FieldError>> {
  const all = validateBot(fullDraft(current, e), source);
  // Chỉ các ô có trên form Edit: ô khác của version không bao giờ đổi, nên không báo.
  const keep: readonly FieldKey[] = ["size", "maxOpen", "markets", "kinds", "assets", "minLevel"];
  return Object.fromEntries(
    Object.entries(all).filter(([k]) => (keep as readonly string[]).includes(k)),
  );
}

/**
 * Config gửi API: version đang chạy + 5 ô của form (field khác giữ nguyên từng byte, để API không báo `locked`). null khi
 * còn lỗi.
 */
export function editConfigOf(
  current: NewsSignalConfig,
  e: EditDraft,
  source: BotVersionConfig | null,
): NewsSignalConfig | null {
  if (Object.keys(validateEdit(current, e, source)).length > 0) return null;
  return {
    ...current,
    leverage: e.leverage,
    sizeUsdc: e.size.trim(),
    maxOpenTrades: Number(e.maxOpen.trim()),
    minLevel: e.minLevel,
    assets: {
      mode: e.mode,
      markets: e.mode === AssetMode.all ? [] : e.markets,
      crypto: e.crypto,
      stocks: e.stocks,
    },
  };
}

/** Mã lỗi theo ô của API (`fieldErrors`) → ô trên form. */
const API_FIELD: Readonly<Record<string, FieldKey>> = {
  "config.sizeUsdc": "size",
  sizeUsdc: "size",
  "config.maxOpenTrades": "maxOpen",
  maxOpenTrades: "maxOpen",
  assets: "assets",
  "config.assets": "assets",
  "config.assets.markets": "markets",
  minLevel: "minLevel",
  "config.minLevel": "minLevel",
};

export function BotEditSheet({
  botId,
  name,
  current,
  source,
  next,
  onClose,
  onSaved,
}: {
  botId: string;
  name: string;
  /** Config của version đang chạy. */
  current: NewsSignalConfig;
  /** Config của Signal research version gốc; null = không biết (API vẫn kiểm `narrowsVersion`). */
  source: BotVersionConfig | null;
  /** Số của version sẽ được tạo. */
  next: number;
  onClose: () => void;
  onSaved: (result: NewsBotVersionResult) => void;
}) {
  const t = useTranslations("signalAnalysis.research.mainnet.settings");
  const tb = useTranslations("signalAnalysis.research.mainnet.editor");
  const td = useTranslations("signalAnalysis.research.mainnet.dialogs");
  const tm = useTranslations("signalAnalysis.research.mainnet");
  const tv = useTranslations("signalAnalysis.research.versions");
  const tn = useTranslations("signalAnalysis.research");
  const tc = useTranslations("common.errors");
  const id = useId();
  const mobile = useMediaQuery(BELOW_LG);
  const markets = useResearchMarkets(true);
  const trades = useNewsTrades(botId);
  const marketsText = useMarketsText();
  const errorText = useMainnetErrorText();
  const twoFactorNeeded = useTwoFactorNeeded();
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState("");
  const [e, setE] = useState<EditDraft>(() => editDraftOf(current));
  const [touched, setTouched] = useState<ReadonlySet<FieldKey>>(new Set());
  const [tried, setTried] = useState(false);
  const [serverFields, setServerFields] = useState<Partial<Record<FieldKey, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const pickerOpen = useRef(false);
  const save = useSaveNewsVersion();

  const errors = validateEdit(current, e, source);
  const shown = (k: FieldKey) => (tried || touched.has(k) ? errors[k] : undefined);
  const errText = (x: FieldError | undefined): string | undefined => {
    if (x === undefined) return undefined;
    if (x.key === "range") return tv("sheet.errors.range", { min: x.min, max: x.max });
    if (x.key === "sizeCap" || x.key === "narrowMarkets" || x.key === "raiseLevel")
      return tb(x.key);
    return tv(`sheet.errors.${x.key}`);
  };
  /** Lỗi của ô: kiểm ở client trước, rồi lỗi API (`fieldErrors`) cho tới khi ô đó được sửa. */
  const fieldText = (k: FieldKey, always = false) =>
    errText(always ? errors[k] : shown(k)) ?? serverFields[k];
  const set = (p: Partial<EditDraft>, k?: FieldKey) => {
    setE((x) => ({ ...x, ...p }));
    setError(null);
    if (k !== undefined) {
      setTouched((s) => new Set(s).add(k));
      setServerFields((f) => Object.fromEntries(Object.entries(f).filter(([x]) => x !== k)));
    }
  };

  const config = editConfigOf(current, e, source);
  const changes = config === null ? [] : changeList(current, config);
  const pending = save.isPending;

  // Lệnh đang mở (mỗi market của bot chỉ một lệnh mở): giữ đòn bẩy lúc vào; null = lệnh cũ chưa lưu đòn bẩy.
  const open = (trades.data?.items ?? []).filter((x) => x.status !== "closed");

  function changeList(a: NewsSignalConfig, b: NewsSignalConfig): ReactNode[] {
    const out: ReactNode[] = [];
    if (a.leverage !== b.leverage)
      out.push(t("changeLeverage", { from: a.leverage, to: b.leverage }));
    if (a.sizeUsdc !== b.sizeUsdc) out.push(t("changeSize", { from: a.sizeUsdc, to: b.sizeUsdc }));
    if (a.maxOpenTrades !== b.maxOpenTrades)
      out.push(t("changeMaxOpen", { from: a.maxOpenTrades, to: b.maxOpenTrades }));
    const ma = marketsText(a);
    const mb = marketsText(b);
    if (JSON.stringify(a.assets) !== JSON.stringify(b.assets))
      out.push(t("changeMarkets", { from: ma, to: mb }));
    if (a.minLevel !== b.minLevel)
      out.push(
        t("changeLevel", { from: tn(`levels.${a.minLevel}`), to: tn(`levels.${b.minLevel}`) }),
      );
    return out;
  }

  const submit = () => {
    setTried(true);
    setError(null);
    if (config === null) {
      setError(tv("sheet.errors.fix"));
      return;
    }
    if (changes.length === 0 || pending) return;
    save.mutate(
      {
        botId,
        config,
        ...(code.trim() === "" ? {} : { twoFactorCode: code.trim() }),
      },
      {
        onSuccess: (r) => {
          onSaved(r);
        },
        onError: (err) => {
          if (err instanceof ApiError) {
            if (err.code === ErrorCode.twoFactorRequired) setNeedCode(true);
            if (err.code === ErrorCode.botStateConflict && err.details.reason === "applying") {
              setError(t("stillApplying"));
              return;
            }
            const fe = err.details.fieldErrors;
            if (err.code === ErrorCode.validationFailed && typeof fe === "object" && fe !== null) {
              const mapped: Partial<Record<FieldKey, string>> = {};
              let other = false;
              for (const [k, v] of Object.entries(fe as Record<string, unknown>)) {
                const f = API_FIELD[k];
                const first = Array.isArray(v) ? String(v[0] ?? "") : "";
                if (f === undefined || first === "locked") other = true;
                else
                  mapped[f] =
                    f === "assets"
                      ? tb("narrowMarkets")
                      : f === "minLevel"
                        ? tb("raiseLevel")
                        : f === "size"
                          ? tb("sizeCap")
                          : first;
              }
              setServerFields(mapped);
              if (other || Object.keys(mapped).length === 0) setError(errorText(err));
              else setError(tv("sheet.errors.fix"));
              return;
            }
          }
          setError(errorText(err));
        },
      },
    );
  };

  return (
    <BottomSheet
      open
      onOpenChange={(o) => {
        if (!o && !pending) onClose();
      }}
      title={t("editTitle", { name })}
      titleAside={<Pill tone="neg">{tm("strip.mainnet")}</Pill>}
      closeLabel={tv("sheet.close")}
      side
      onEscapeKeyDown={(ev) => {
        if (pickerOpen.current || pending) ev.preventDefault();
      }}
      footer={
        <div className="flex w-full flex-col gap-2.5">
          {twoFactorNeeded || needCode ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-2fa`} className={lbl}>
                {td("start.twoFactor")}
              </label>
              <input
                id={`${id}-2fa`}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                disabled={pending}
                onChange={(ev) => {
                  setCode(ev.target.value);
                }}
                className={`${input} max-w-[10rem]`}
              />
            </div>
          ) : null}
          <div className="flex flex-col gap-2 md:flex-row md:justify-end">
            <Button variant="secondary" disabled={pending} onClick={onClose}>
              {tv("sheet.cancel")}
            </Button>
            <Button
              pending={pending}
              disabled={changes.length === 0 && config !== null}
              onClick={submit}
            >
              {t("saveAs", { n: next })}
            </Button>
          </div>
        </div>
      }
    >
      {open.length === 0 ? null : (
        <div
          role="note"
          className="flex flex-col gap-1 rounded-tile border border-warn-border bg-warn-bg px-3.5 py-3 text-sm leading-normal text-warn"
        >
          {open.map((x) => (
            <p key={x.id} className="m-0">
              {x.leverage === null
                ? t.rich("openTradeNoLev", { n: 1, market: x.market, b: bold })
                : t.rich("openTrade", { n: 1, market: x.market, lev: x.leverage, b: bold })}
            </p>
          ))}
        </div>
      )}

      <Group legend={tb("botBlock")} grid>
        <div className="flex flex-col gap-1.5">
          <span className={lbl} aria-hidden="true">
            {tb("leverage")}
          </span>
          <SegmentedControl
            label={tb("leverage")}
            value={String(e.leverage)}
            disabled={pending}
            options={NEWS_SIGNAL_LEVERAGES.map((l) => ({
              value: String(l),
              label: tb("leverageOpt", { lev: l }),
            }))}
            onValueChange={(v) => {
              const l = NEWS_SIGNAL_LEVERAGES.find((x) => String(x) === v);
              if (l !== undefined) set({ leverage: l });
            }}
          />
          <span className="text-xs leading-normal text-muted">{tb("leverageHelp")}</span>
        </div>
        <Num
          label={tb("size")}
          hint={tb("sizeHint")}
          value={e.size}
          disabled={pending}
          wide
          error={fieldText("size")}
          onChange={(v) => {
            set({ size: v }, "size");
          }}
        />
        <Num
          label={tv("sheet.maxOpen")}
          unit={tv("sheet.maxOpenUnit")}
          value={e.maxOpen}
          inputMode="numeric"
          disabled={pending}
          error={fieldText("maxOpen")}
          onChange={(v) => {
            set({ maxOpen: v }, "maxOpen");
          }}
        />
        <MarginCalc size={e.size} maxOpen={e.maxOpen} leverage={e.leverage} />
      </Group>

      <Group legend={t("signals")} grid>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-lvl`} className={lbl}>
            {t("minLevel")}
          </label>
          <select
            id={`${id}-lvl`}
            value={e.minLevel}
            disabled={pending}
            aria-invalid={fieldText("minLevel", true) === undefined ? undefined : true}
            aria-describedby={`${id}-lvl-h${fieldText("minLevel", true) === undefined ? "" : ` ${id}-lvl-e`}`}
            onChange={(ev) => {
              set({ minLevel: ev.target.value as Level }, "minLevel");
            }}
            className={input}
          >
            {(["high", "medium", "low"] as const).map((l) => (
              <option key={l} value={l}>
                {tv(`sheet.levelOpt.${l}`)}
              </option>
            ))}
          </select>
          <span id={`${id}-lvl-h`} className="text-xs text-muted">
            {tb("raiseLevel")}
          </span>
          <Err id={`${id}-lvl-e`} text={fieldText("minLevel", true)} />
        </div>
      </Group>

      <AssetsGroup
        value={e}
        onChange={(p, k) => {
          set(
            {
              ...(p.mode === undefined ? {} : { mode: p.mode }),
              ...(p.markets === undefined ? {} : { markets: p.markets }),
              ...(p.crypto === undefined ? {} : { crypto: p.crypto }),
              ...(p.stocks === undefined ? {} : { stocks: p.stocks }),
            },
            k ?? "assets",
          );
        }}
        errors={{
          kinds: fieldText("kinds"),
          markets: fieldText("markets"),
          assets: fieldText("assets", true),
        }}
        markets={{
          data: markets.data,
          loading: markets.isPending && markets.fetchStatus !== "idle",
          error: markets.isError,
        }}
        mobile={mobile}
        disabled={pending}
        help={tb("narrowMarkets")}
        onPickerOpen={(o) => {
          pickerOpen.current = o;
        }}
      />

      <div className="rounded-tile bg-accent-tint p-3.5 text-sm leading-normal text-accent-ink">
        <b className="block">{t("changes", { n: next })}</b>
        {changes.length === 0 ? (
          <span className="block">{t("noChanges")}</span>
        ) : (
          <ul className="m-0 mt-1.5 pl-4.5">
            {changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        )}
      </div>

      {save.checking ? (
        <p role="status" className="m-0 text-sm font-semibold text-ink-2">
          {tc("unconfirmed")}
        </p>
      ) : error !== null ? (
        <p role="alert" className="m-0 text-sm font-semibold text-neg-ink">
          {error}
        </p>
      ) : null}
    </BottomSheet>
  );
}

const bold = (c: ReactNode) => <b>{c}</b>;
