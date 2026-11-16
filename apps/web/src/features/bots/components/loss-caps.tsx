"use client";

import { useTranslations } from "next-intl";
import { useId, type ReactNode } from "react";

import { mmNumbers } from "../field-copy";
import type { FormValues } from "../fields";

// "How your losses are capped" của Market Making (thiết kế "MM form explained", DEC-TBD-mm-form-copy): ba kiểm tra
// chạy cùng lúc. Smart quoting bật: Stop when costs reach · Position cut · Max position. Tắt: Position loss limit
// thay Position cut, và ô Position loss limit (`children`) nằm cuối khối. Số lấy từ form; ô trống thì bỏ số.

type Tone = "plain" | "accent" | "warn";

const BOX: Record<Tone, string> = {
  plain: "bg-surface-2",
  accent: "bg-accent-tint",
  warn: "bg-warn-bg",
};
const TERM: Record<Tone, string> = {
  plain: "text-muted",
  accent: "text-accent-ink",
  warn: "text-warn",
};

function CapCard({
  title,
  watches,
  then,
  tone,
}: {
  title: string;
  watches: string;
  then: string;
  tone: Tone;
}) {
  const t = useTranslations("createBot.lossCaps");
  return (
    <div className={`flex flex-col gap-2 rounded-[12px] p-4 ${BOX[tone]}`}>
      <h4 className="m-0 text-[15px] font-bold text-ink">{title}</h4>
      <dl className="m-0 flex flex-col gap-2">
        <dt className={`text-[13px] font-semibold ${TERM[tone]}`}>{t("watches")}</dt>
        <dd className="m-0 text-sm leading-snug text-ink-body">{watches}</dd>
        <dt className={`text-[13px] font-semibold ${TERM[tone]}`}>{t("then")}</dt>
        <dd className="m-0 text-sm leading-snug text-ink-body">{then}</dd>
      </dl>
    </div>
  );
}

export function LossCaps({
  values,
  children,
}: {
  values: FormValues;
  /** Ô Position loss limit, chỉ khi tắt Smart quoting. */
  children?: ReactNode;
}) {
  const t = useTranslations("createBot.lossCaps");
  const id = useId();
  const smart = values.smartQuoting === true;
  const n = mmNumbers(values);
  const intro = smart
    ? n.size === null
      ? t("introOnShort")
      : t("introOn", { size: n.size })
    : n.size === null
      ? t("introOffShort")
      : t("introOff", { size: n.size });
  const maxWatches = smart
    ? n.max === null
      ? t("max.watchesOnShort")
      : t("max.watchesOn", { max: n.max })
    : n.max === null
      ? t("max.watchesOffShort")
      : t("max.watchesOff", { max: n.max });
  return (
    <section
      aria-labelledby={id}
      data-testid="loss-caps"
      data-smart={smart ? "on" : "off"}
      className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4"
    >
      <div className="flex flex-col gap-1">
        <h3 id={id} className="m-0 text-[15px] font-extrabold">
          {t("title")}
        </h3>
        <p className="m-0 text-sm leading-snug text-muted">{intro}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <CapCard
          tone="plain"
          title={t("cost.title")}
          watches={t("cost.watches")}
          then={t("cost.then")}
        />
        {smart ? (
          <CapCard
            tone="accent"
            title={t("cut.title")}
            watches={
              n.size === null || n.cut === null
                ? t("cut.watchesShort")
                : t("cut.watches", { cut: n.cut, size: n.size })
            }
            then={t("cut.then")}
          />
        ) : (
          <CapCard
            tone="warn"
            title={t("posLoss.title")}
            watches={t("posLoss.watches")}
            then={t("posLoss.then")}
          />
        )}
        <CapCard tone="plain" title={t("max.title")} watches={maxWatches} then={t("max.then")} />
      </div>
      {smart ? <p className="m-0 text-[13px] leading-snug text-muted">{t("footOn")}</p> : children}
    </section>
  );
}
