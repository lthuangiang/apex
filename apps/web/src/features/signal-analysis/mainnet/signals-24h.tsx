"use client";

import { SIGNAL_CATALYSTS, type NewsBotSignal, type SignalCatalyst } from "@drift/shared";
import { useTranslations } from "next-intl";

import { clock } from "../format";
import { catalystName } from "../research/version-text";

import { useNewsBotSignals } from "./api";
import { baseOf } from "./mainnet-trades";
import { funnelReasonOf, useMainnetErrorText } from "./text";

// Khối "Signals in the last 24 h" (#421, PM chốt điểm 3): tín hiệu dùng chung và kết quả trên bot đang chọn. Lý do bị bỏ
// dùng nhãn của phễu (`trace.reasonLabels`); mã chưa có nhãn ở phễu hiện nguyên mã. Phễu theo bot: #444.

const isCatalyst = (c: string): c is SignalCatalyst =>
  (SIGNAL_CATALYSTS as readonly string[]).includes(c);

export function Signals24h({ botId, tz }: { botId: string; tz: string }) {
  const t = useTranslations("signalAnalysis.research.mainnet.signals");
  const tn = useTranslations("signalAnalysis.research");
  const tm = useTranslations("signalAnalysis.research.mainnet");
  const q = useNewsBotSignals(botId);
  const errorText = useMainnetErrorText();

  const outcome = (s: NewsBotSignal) => {
    if (s.outcome === null) return <span className="text-muted">{t("notReceived")}</span>;
    if (s.outcome === "accepted")
      return <span className="font-semibold text-ink">{t("accepted")}</span>;
    const key = s.reason === null ? null : funnelReasonOf(s.reason);
    return (
      <span className="text-ink-2">
        {key !== null
          ? t("dropped", { reason: tn(`trace.reasonLabels.${key}`) })
          : t("droppedCode", { code: s.reason ?? "" })}
      </span>
    );
  };

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
      <ul aria-label={t("label")} className="m-0 flex list-none flex-col p-0">
        {q.data.items.map((s) => (
          <li
            key={s.id}
            className="flex flex-col gap-0.5 border-b border-border py-2 text-sm last:border-b-0 md:flex-row md:items-center md:gap-3"
          >
            <span className="flex-none text-xs text-muted tabular-nums md:w-14">
              {clock(s.decidedAt, tz, false)}
            </span>
            <span className="min-w-0 flex-1 text-ink">
              {t("row", {
                market: baseOf(s.market),
                side: tn(`sides.${s.side}`),
                type: isCatalyst(s.catalyst) ? catalystName(s.catalyst, tn) : s.catalyst,
              })}
            </span>
            <span className="flex-none">{outcome(s)}</span>
          </li>
        ))}
      </ul>
    );

  return (
    <section
      aria-labelledby="sr-mainnet-signals"
      className="flex min-w-0 flex-col gap-3 rounded-card bg-surface p-4 shadow-card md:p-6"
    >
      <h2 id="sr-mainnet-signals" className="m-0 text-lg font-extrabold md:text-xl">
        {t("title")}
      </h2>
      {body}
    </section>
  );
}
