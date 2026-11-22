"use client";

import { dec, type BotSummary, type NewsTrade } from "@drift/shared";
import { ConfirmDialog } from "@drift/ui";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { useMarketLast } from "@/lib/markets";

import { priceText } from "../research/format";

// Hộp thoại của phần Mainnet (#421, mockup docs/mockups/signal-research/mainnet-team-test.html, mục 3). Dùng lại
// `ConfirmDialog` như Stop của Trading Agent (PM chốt: Close now giống Stop). Không đóng giữa chừng khi đang chờ backend.

const radio = (on: boolean) =>
  `flex items-start gap-2.5 rounded-[14px] border px-3.5 py-3 text-sm ${on ? "border-accent bg-accent-tint" : "border-border"}`;

/** Stop…: "Keep open trades" (TP/SL ở lại SoDEX) hoặc "Close all now" (market). Bắt buộc chọn. */
export function StopNewsBotDialog({
  bot,
  openTrades,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  bot: BotSummary;
  /** Số lệnh đang mở; null = chưa biết (không bao giờ hiện 0 khi thiếu dữ liệu). */
  openTrades: number | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (closeAll: boolean) => void;
}) {
  const t = useTranslations("signalAnalysis.research.mainnet.dialogs");
  const [choice, setChoice] = useState<"keep" | "close" | null>(null);
  const id = useId();
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t("stop.title", { name: bot.name })}
      consequencesLabel={t("consequences")}
      consequences={[
        t("stop.body"),
        ...(openTrades === null ? [] : [t("stop.open", { n: openTrades })]),
      ]}
      confirmLabel={t("stop.cta")}
      cancelLabel={t("cancel")}
      tone="danger"
      pending={pending}
      confirmDisabled={choice === null}
      {...(error === null ? {} : { error })}
      onConfirm={() => {
        if (choice !== null) onConfirm(choice === "close");
      }}
    >
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-sm font-semibold text-ink">{t("stop.legend")}</legend>
        {(["keep", "close"] as const).map((v) => (
          <div key={v} className={radio(choice === v)}>
            <input
              id={`${id}-${v}`}
              type="radio"
              name={`${id}-stop`}
              value={v}
              checked={choice === v}
              disabled={pending}
              onChange={() => {
                setChoice(v);
              }}
              aria-describedby={`${id}-${v}-body`}
              className="mt-0.5"
            />
            <span className="flex flex-col gap-0.5">
              <label htmlFor={`${id}-${v}`} className="cursor-pointer font-bold">
                {t(`stop.${v}Title`)}
              </label>
              <span id={`${id}-${v}-body`} className="text-xs text-ink-2">
                {t(`stop.${v}Body`)}
              </span>
            </span>
          </div>
        ))}
      </fieldset>
    </ConfirmDialog>
  );
}

/** Close now một lệnh: market reduce-only (engine), giống Stop. */
export function CloseTradeDialog({
  market,
  side,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  market: string;
  side: string;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("signalAnalysis.research.mainnet.dialogs");
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t("close.title", { market, side })}
      consequencesLabel={t("consequences")}
      consequences={[t("close.body")]}
      confirmLabel={t("close.cta")}
      cancelLabel={t("cancel")}
      tone="danger"
      pending={pending}
      {...(error === null ? {} : { error })}
      onConfirm={onConfirm}
    />
  );
}

const DECIMAL = /^\d+(\.\d+)?$/;

/** Lỗi phía client của Edit TP/SL (khớp kiểm tra của API #443). */
export function tpslError(
  side: "long" | "short",
  tp: string,
  sl: string,
): "invalid" | "slBelow" | "slAbove" | null {
  for (const v of [tp, sl])
    if (v.trim() !== "" && (!DECIMAL.test(v.trim()) || !dec(v.trim()).gt(0))) return "invalid";
  if (tp.trim() === "" && sl.trim() === "") return "invalid";
  if (tp.trim() === "" || sl.trim() === "") return null;
  const ok = side === "long" ? dec(sl.trim()).lt(tp.trim()) : dec(sl.trim()).gt(tp.trim());
  if (ok) return null;
  return side === "long" ? "slBelow" : "slAbove";
}

/** % từ giá mark (dấu theo giá). */
function pctFrom(mark: string | null, v: string): string | null {
  if (mark === null || !DECIMAL.test(v.trim()) || !dec(mark).gt(0)) return null;
  const p = dec(v.trim()).sub(mark).div(mark).mul(100).toDecimalPlaces(1);
  return `${p.gt(0) ? "+" : p.lt(0) ? "−" : ""}${p.abs().toFixed(1)}%`;
}

/** Edit TP / SL: lệnh mới được SoDEX xác nhận rồi mới huỷ lệnh cũ (engine). Giá mark từ `md:last`. */
export function EditTpslDialog({
  trade,
  market,
  side,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  trade: NewsTrade;
  market: string;
  side: string;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (body: { tp: string | null; sl: string | null }) => void;
}) {
  const t = useTranslations("signalAnalysis.research.mainnet.dialogs");
  const [tp, setTp] = useState(trade.tpPrice ?? "");
  const [sl, setSl] = useState(trade.slPrice ?? "");
  const [tried, setTried] = useState(false);
  const last = useMarketLast(trade.market);
  const mark = last.data?.price ?? null;
  const id = useId();
  const problem = tpslError(trade.side, tp, sl);
  const shownProblem = tried ? problem : null;
  const field = (key: "tp" | "sl", value: string, set: (v: string) => void) => {
    const pct = pctFrom(mark, value);
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor={`${id}-${key}`} className="text-sm font-semibold text-ink">
          {t(`edit.${key}`)}
        </label>
        <div className="flex items-center gap-2">
          <input
            id={`${id}-${key}`}
            type="text"
            inputMode="decimal"
            value={value}
            disabled={pending}
            aria-invalid={shownProblem === null ? undefined : true}
            aria-describedby={shownProblem === null ? undefined : `${id}-e`}
            onChange={(e) => {
              set(e.target.value);
            }}
            className="min-h-tap w-full min-w-0 rounded-control border border-border-input bg-surface px-3 text-sm text-ink tabular-nums aria-invalid:border-neg"
          />
          {pct === null ? null : <span className="text-xs text-muted tabular-nums">{pct}</span>}
        </div>
      </div>
    );
  };
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t("edit.title", { market, side })}
      consequencesLabel={t("consequences")}
      consequences={[mark === null ? t("edit.markNa") : t("edit.mark", { price: priceText(mark) })]}
      confirmLabel={t("edit.save")}
      cancelLabel={t("cancel")}
      pending={pending}
      {...(error === null ? {} : { error })}
      onConfirm={() => {
        setTried(true);
        if (problem !== null) return;
        const body = {
          tp: tp.trim() === "" || tp.trim() === trade.tpPrice ? null : tp.trim(),
          sl: sl.trim() === "" || sl.trim() === trade.slPrice ? null : sl.trim(),
        };
        // Không đổi gì: không gửi command.
        if (body.tp === null && body.sl === null) onClose();
        else onConfirm(body);
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        {field("tp", tp, setTp)}
        {field("sl", sl, setSl)}
      </div>
      {shownProblem === null ? null : (
        <p id={`${id}-e`} role="alert" className="m-0 text-xs font-semibold text-neg-ink">
          {t(`edit.${shownProblem}`)}
        </p>
      )}
    </ConfirmDialog>
  );
}

/** Start một bot đã có (Draft / Stopped): xác nhận tiền thật + mã 2FA khi cần (DEC-115). */
export function StartNewsBotDialog({
  bot,
  twoFactor,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  bot: BotSummary;
  /** Ô 2FA khi đã bật mà phiên chưa được tin; null = không hỏi. */
  twoFactor: { value: string; onChange: (v: string) => void } | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("signalAnalysis.research.mainnet.dialogs");
  const [ack, setAck] = useState(false);
  const id = useId();
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t("start.title", { name: bot.name })}
      consequencesLabel={t("consequences")}
      consequences={[t("start.warn"), t("start.never")]}
      confirmLabel={t("start.cta")}
      cancelLabel={t("cancel")}
      pending={pending}
      confirmDisabled={!ack}
      {...(twoFactor === null
        ? error === null
          ? {}
          : { error }
        : {
            twoFactor: {
              label: t("start.twoFactor"),
              value: twoFactor.value,
              onChange: twoFactor.onChange,
              ...(error === null ? {} : { error }),
            },
          })}
      onConfirm={onConfirm}
    >
      <label
        htmlFor={`${id}-ack`}
        className="flex cursor-pointer items-start gap-2.5 text-sm text-ink"
      >
        <input
          id={`${id}-ack`}
          type="checkbox"
          checked={ack}
          disabled={pending}
          onChange={(e) => {
            setAck(e.target.checked);
          }}
          className="mt-0.5 size-5 flex-none accent-accent"
        />
        {t("start.ack")}
      </label>
    </ConfirmDialog>
  );
}
