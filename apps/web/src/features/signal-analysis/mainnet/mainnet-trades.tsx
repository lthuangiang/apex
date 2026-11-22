"use client";

import type { NewsTrade } from "@drift/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { clock } from "../format";
import { priceText } from "../research/format";
import { Na } from "../research/ui";

import { useNewsCommand, useNewsTrades } from "./api";
import { CloseTradeDialog, EditTpslDialog } from "./dialogs";
import { useMainnetErrorText } from "./text";

// Bảng "Mainnet trades" (#421, mockup mục 2). Kết quả chưa có dữ liệu (#443): luôn "Not available", không bao giờ 0.
// Close now / Edit TP/SL chỉ ghi command; nhãn chuyển tiếp ("Closing…", "Applying…") giữ tới khi backend xác nhận.

/** "SOL-USD" → "SOL". */
export const baseOf = (market: string) => market.split("-")[0] ?? market;

const CLOSE_REASONS = [
  "TAKE_PROFIT",
  "STOP_LOSS",
  "MAX_HOLD",
  "OPPOSITE_NEWS",
  "MANUAL",
  "STOP",
  "SL_REJECTED",
  "ENTRY_NOT_FILLED",
] as const;

type Open = { kind: "close" | "edit"; trade: NewsTrade } | null;

export function MainnetTrades({ botId, tz }: { botId: string; tz: string }) {
  const t = useTranslations("signalAnalysis.research.mainnet.trades");
  const tn = useTranslations("signalAnalysis.research");
  const tm = useTranslations("signalAnalysis.research.mainnet");
  const q = useNewsTrades(botId);
  const [open, setOpen] = useState<Open>(null);
  const errorText = useMainnetErrorText();
  const cmd = useNewsCommand(() => {
    setOpen(null);
  });
  const sideOf = (x: NewsTrade) => tn(`sides.${x.side}`);
  const label = (x: NewsTrade) => t("market", { market: baseOf(x.market), side: sideOf(x) });

  const reason = (x: NewsTrade) =>
    x.closeReason !== null && (CLOSE_REASONS as readonly string[]).includes(x.closeReason)
      ? t(`reasons.${x.closeReason as (typeof CLOSE_REASONS)[number]}`)
      : t("reasons.other");

  const actions = (x: NewsTrade) => {
    if (x.status === "closed") return <span className="text-muted">{reason(x)}</span>;
    // Trạng thái lấy từ backend: lệnh đang đóng hoặc command chưa xong thì chỉ hiện nhãn chuyển tiếp.
    if (x.status === "closing" || x.pendingCommand?.kind === "close")
      return (
        <span role="status" className="font-semibold text-ink-2">
          {t("closing")}
        </span>
      );
    if (x.pendingCommand?.kind === "edit_tpsl")
      return (
        <span role="status" className="font-semibold text-ink-2">
          {t("applying")}
        </span>
      );
    const btn =
      "cursor-pointer border-0 bg-transparent p-0 font-bold text-accent-ink underline-offset-2 hover:underline";
    return (
      <span className="inline-flex flex-wrap items-center gap-x-1.5">
        <button
          type="button"
          className={btn}
          onClick={() => {
            cmd.reset();
            setOpen({ kind: "edit", trade: x });
          }}
        >
          {t("edit")}
        </button>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          className={btn}
          onClick={() => {
            cmd.reset();
            setOpen({ kind: "close", trade: x });
          }}
        >
          {t("close")}
        </button>
      </span>
    );
  };

  const price = (v: string | null) => (v === null ? <Na /> : priceText(v));
  const hold = (x: NewsTrade) =>
    x.status === "closed" ? (
      x.closedAt === null ? (
        <Na />
      ) : (
        t("closedAt", { time: clock(x.closedAt, tz, false) })
      )
    ) : x.maxHoldUntil === null ? (
      t("noMaxHold")
    ) : (
      t("until", { time: clock(x.maxHoldUntil, tz, false) })
    );

  let body;
  if (q.isPending) body = <p className="m-0 text-sm text-muted">{tm("loading")}</p>;
  else if (q.isError)
    body = (
      <p role="alert" className="m-0 text-sm text-neg-ink">
        {errorText(q.error)}
      </p>
    );
  else if (q.data.items.length === 0) body = <p className="m-0 text-sm text-muted">{t("empty")}</p>;
  else
    body = (
      <div className="relative overflow-x-auto">
        <table aria-label={t("label")} className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr>
              {(
                ["opened", "market", "entry", "tp", "sl", "maxHold", "result", "actions"] as const
              ).map((k) => (
                <th
                  key={k}
                  scope="col"
                  className={`border-b border-border px-2.5 py-2 text-xs font-bold whitespace-nowrap text-muted ${
                    k === "entry" || k === "tp" || k === "sl" || k === "result"
                      ? "text-right"
                      : "text-left"
                  }`}
                >
                  {k === "actions" ? (
                    <span className="sr-only">{t("cols.actions")}</span>
                  ) : (
                    t(`cols.${k}`)
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {q.data.items.map((x) => (
              <tr key={x.id}>
                <td className={cell}>{clock(x.openedAt, tz, false)}</td>
                <td className={cell}>{label(x)}</td>
                <td className={`${cell} text-right`}>{price(x.entryAvgPrice)}</td>
                <td className={`${cell} text-right`}>{price(x.tpPrice)}</td>
                <td className={`${cell} text-right`}>{price(x.slPrice)}</td>
                <td className={cell}>{hold(x)}</td>
                <td className={`${cell} text-right`}>
                  <Na />
                </td>
                <td className={cell}>{actions(x)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  const pending = cmd.isPending;
  const err =
    cmd.error === null ? null : cmd.checking ? errorText(cmd.error) : errorText(cmd.error);
  return (
    <section
      aria-labelledby="sr-mainnet-trades"
      className="flex min-w-0 flex-col gap-3 rounded-card bg-surface p-4 shadow-card md:p-6"
    >
      <h2 id="sr-mainnet-trades" className="m-0 text-lg font-extrabold md:text-xl">
        {t("title")}
      </h2>
      {body}
      <p className="m-0 text-xs text-muted">{t("note")}</p>
      {open?.kind === "close" ? (
        <CloseTradeDialog
          market={baseOf(open.trade.market)}
          side={sideOf(open.trade)}
          pending={pending}
          error={err}
          onClose={() => {
            setOpen(null);
          }}
          onConfirm={() => {
            cmd.mutate({ botId, tradeId: open.trade.id, kind: "close" });
          }}
        />
      ) : null}
      {open?.kind === "edit" ? (
        <EditTpslDialog
          trade={open.trade}
          market={baseOf(open.trade.market)}
          side={sideOf(open.trade)}
          pending={pending}
          error={err}
          onClose={() => {
            setOpen(null);
          }}
          onConfirm={(b) => {
            cmd.mutate({ botId, tradeId: open.trade.id, kind: "edit_tpsl", body: b });
          }}
        />
      ) : null}
    </section>
  );
}

const cell = "border-b border-border px-2.5 py-2.5 whitespace-nowrap tabular-nums";
