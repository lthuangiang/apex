"use client";

import type { SignalTimelineItem } from "@drift/shared";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { clockMs, favourTone, price, signed } from "../format";

import { Na } from "./bits";

// Phần dùng chung của hai hộp chi tiết (lượt VB, fill MM).

export function Stat({
  label,
  value,
  sub,
  tone = "text-ink",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-xs text-muted">{label}</span>
      <strong className={`text-lg font-extrabold ${tone}`}>{value}</strong>
      {sub === undefined ? null : <em className="text-xs not-italic text-muted">{sub}</em>}
    </div>
  );
}

export function Panel({
  title,
  tag,
  children,
}: {
  title: string;
  tag?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-tile bg-surface-2 px-3.5 py-3">
      <h3 className="m-0 flex items-center gap-2 text-[13px] font-extrabold">
        {title}
        {tag}
      </h3>
      {children}
    </div>
  );
}

/** Ô bp nhỏ: nhãn, giá trị (+ = có lợi), "all: …". */
export function BpBoxes({
  items,
}: {
  items: readonly { label: string; v: number | null; all: number | null; mark?: boolean }[];
}) {
  const t = useTranslations("signalAnalysis.detail");
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(68px,1fr))] gap-1.5">
      {items.map((x) => (
        <div key={x.label} className="flex flex-col rounded-[8px] bg-surface px-2 py-1.5">
          <span className="text-xs text-muted">{x.label}</span>
          <b
            className={`${x.v === null ? "text-xs" : "whitespace-nowrap text-sm"} ${favourTone(x.v)}`}
          >
            {x.v === null ? <Na /> : `${x.mark === true ? "▲ " : ""}${signed(x.v)}`}
          </b>
          <em className="text-xs not-italic text-muted">
            {t("all", { v: x.all === null ? t("na") : signed(x.all) })}
          </em>
        </div>
      ))}
    </div>
  );
}

export function Timeline({ items, tz }: { items: readonly SignalTimelineItem[]; tz: string }) {
  const t = useTranslations("signalAnalysis.detail");
  if (items.length === 0) return <p className="m-0 text-[13px] text-muted">{t("noTimeline")}</p>;
  const text = (x: SignalTimelineItem) => {
    if (x.kind === "decision") return x.why === null ? x.decision : `${x.decision}: ${x.why}`;
    if (x.kind === "order")
      return t("order", {
        side: x.side,
        type: x.type === "market" ? t("market") : x.postOnly ? t("limitPostOnly") : t("limit"),
        reduce: x.reduceOnly ? t("reduceOnly") : "",
        price: x.price === null ? t("atMarket") : t("atPrice", { p: price(x.price) }),
        status: x.status,
      });
    return t("fill", {
      side: x.side,
      size: x.size,
      price: price(x.price),
      fee: x.fee,
      role: x.maker === null ? "" : x.maker ? t("maker") : t("taker"),
    });
  };
  return (
    <ol className="m-0 flex list-none flex-col gap-1 p-0">
      {items.map((x, i) => (
        <li key={i} className="grid grid-cols-[96px_1fr] gap-3 text-[12.5px]">
          <span className="font-mono text-ink-2">{clockMs(x.at, tz)}</span>
          <span className={x.kind === "fill" ? "text-pos" : "text-ink"}>{text(x)}</span>
        </li>
      ))}
    </ol>
  );
}
