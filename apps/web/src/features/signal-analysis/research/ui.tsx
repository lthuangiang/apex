"use client";

import type { ResearchLabel } from "@drift/shared";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

// Thành phần nhỏ của tab Signal research (docs/mockups/signal-research).

export function Block({
  id,
  title,
  titleShort,
  right,
  children,
  className = "",
}: {
  id: string;
  title: string;
  /** Tiêu đề dưới 768px, nếu mockup 390 ghi khác. */
  titleShort?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`flex min-w-0 flex-col gap-3.5 rounded-card bg-surface p-4 shadow-card md:p-6 ${className}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={id} className="m-0 text-lg font-extrabold md:text-[22px]">
          {titleShort === undefined ? (
            title
          ) : (
            <>
              <span className="md:hidden">{titleShort}</span>
              <span className="max-md:hidden">{title}</span>
            </>
          )}
        </h2>
        {right === undefined ? null : <span className="text-sm text-muted">{right}</span>}
      </div>
      {children}
    </section>
  );
}

export type PillTone = "pos" | "neg" | "accent" | "neutral" | "paper" | "warn";
const TONES: Record<PillTone, string> = {
  pos: "bg-pos-bg text-pos",
  neg: "bg-neg-bg text-neg-ink",
  accent: "bg-accent-tint text-accent-ink",
  neutral: "bg-bg text-ink-2",
  paper: "bg-unknown-bg text-unknown",
  warn: "bg-warn-bg text-warn",
};

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export const STATUS_TONE = { collecting: "warn", failing: "neg", passing: "pos" } as const;
export const LEVEL_TONE = { high: "pos", medium: "accent", low: "neutral" } as const;
export const SIDE_TONE = { long: "pos", short: "neg" } as const;

export function LabelPill({ label }: { label: ResearchLabel }) {
  const t = useTranslations("signalAnalysis.research");
  return <Pill tone={label === "live" ? "paper" : "neutral"}>{t(`labels.${label}`)}</Pill>;
}

/** Nhãn "Retry": lệnh News vào ở bài sau của cùng câu chuyện, trong 2 giờ sau bài đầu (#278). */
export function RetryTag() {
  const t = useTranslations("signalAnalysis.research.trades");
  return (
    <span
      title={t("retryTip")}
      className="ml-1.5 inline-block whitespace-nowrap rounded-full bg-accent-tint px-2 py-0.5 align-middle text-xs font-bold text-accent-ink"
    >
      {t("retry")}
      <span className="sr-only">: {t("retryTip")}</span>
    </span>
  );
}

/** Ô thiếu dữ liệu: "Not available" (quy tắc 1.8). */
export function Na() {
  const t = useTranslations("signalAnalysis.research");
  return <span className="text-muted">{t("na")}</span>;
}

/** Ô trung bình khi chưa đủ lệnh. */
export function NotEnough() {
  const t = useTranslations("signalAnalysis.research");
  return <span className="text-muted">{t("notEnough")}</span>;
}

export function Dash() {
  const t = useTranslations("signalAnalysis.research");
  return <span className="text-muted">{t("dash")}</span>;
}

export function Sub({
  children,
  className = "text-muted",
}: {
  children: ReactNode;
  /** Màu / độ đậm (mặc định chữ mờ). */
  className?: string;
}) {
  return <span className={`mt-0.5 block text-xs ${className}`}>{children}</span>;
}

const thBase =
  "border-b border-border px-2.5 py-2.5 text-left align-bottom text-xs font-bold text-muted";
export const thR = `whitespace-nowrap ${thBase}`;
/** Tiêu đề cột được xuống dòng. */
export const thW = `whitespace-normal ${thBase}`;
const tdBase = "border-b border-bg px-2.5 py-3 text-left align-top text-sm text-ink";
export const tdR = `whitespace-nowrap ${tdBase}`;
/** Ô cho câu dài: xuống dòng. */
export const tdW = `whitespace-normal ${tdBase}`;

export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-tile bg-surface-2 p-3.5 text-sm leading-normal text-ink-2">
      {children}
    </div>
  );
}
