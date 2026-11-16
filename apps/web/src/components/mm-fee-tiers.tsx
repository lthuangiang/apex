"use client";

import {
  builderFeeRateOf,
  Decimal,
  FEE_TIERS,
  formatVolumeUsd,
  Strategy,
  type MmFee,
} from "@drift/shared";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { feeLabels } from "@/lib/format";

// Bậc builder fee Market Making (DEC-258, DEC-261; thiết kế docs/mockups/mm-fee-tiers, mục 2b, 2c, 5a, 5b).
// Số phí và ngưỡng lấy từ FEE_TIERS / builderFeeRateOf, không viết cứng. Bảng bậc luôn hiện, ở mọi trạng thái.

export interface MmTierRow {
  from: number;
  to: number | null;
  rate: number;
}

/** Các bậc theo volume tăng dần: [ngưỡng dưới, ngưỡng trên | null, mức phí]. */
export function mmTierRows(): MmTierRow[] {
  const tiers = [...(FEE_TIERS[Strategy.volumeMaker] ?? [])].sort(
    (a, b) => a.minVolume - b.minVolume,
  );
  const out: MmTierRow[] = [];
  let from = 0;
  let rate = builderFeeRateOf(Strategy.volumeMaker);
  for (const t of tiers) {
    out.push({ from, to: t.minVolume, rate });
    from = t.minVolume;
    rate = t.rate;
  }
  out.push({ from, to: null, rate });
  return out;
}

/** "$200K", "$1M": ngưỡng volume của bậc. */
export function usdShort(n: number): string {
  if (n >= 1e6) return `$${String(n / 1e6)}M`;
  if (n >= 1e3) return `$${String(n / 1e3)}K`;
  return `$${String(n)}`;
}

/** "$142,300": volume làm tròn xuống tới đô (không bao giờ ghi cao hơn thật). */
export function usdFull(value: string): string {
  return `$${formatVolumeUsd(value)}`;
}

const pct = (rate: number) => feeLabels(rate).pct;

/**
 * Trạng thái thẻ phí Market Making từ `mmFee` của GET /features:
 * - `plain`: chưa đăng nhập / `mmFee` null / chưa có volume (null hoặc 0) → chỉ mức + bảng bậc;
 * - `next`: theo bậc, còn bậc thấp hơn → thanh tiến độ và câu tới bậc sau;
 * - `top`: theo bậc, bậc cao nhất → pill "Lowest rate";
 * - `custom`: team đặt tay (DEC-159) → bậc không áp dụng.
 */
export type MmFeeView =
  | { kind: "plain"; rate: number }
  | {
      kind: "next";
      rate: number;
      volume: string;
      nextVolume: string;
      nextRate: number;
      /** nextVolume − volume30d (USD, làm tròn lên); null khi ≤ 0 (bậc theo giờ chưa kịp chạy). */
      amount: string | null;
      /** Phần trăm thanh tiến độ, 0–100. */
      progress: number;
    }
  | { kind: "top"; rate: number; volume: string | null; min: number | null }
  | { kind: "custom"; rate: number };

export function mmFeeView(mmFee: MmFee | null | undefined, fallbackRate: number): MmFeeView {
  if (mmFee === null || mmFee === undefined) return { kind: "plain", rate: fallbackRate };
  if (mmFee.source === "custom") return { kind: "custom", rate: mmFee.rate };
  // Bậc mặc định (dưới ngưỡng đầu) có volume thật > 0 vẫn hiện thanh tiến độ tới bậc sau (2b); chưa có volume
  // (null) hoặc chưa khớp gì ("0") thì chỉ mức + bảng bậc, không vẽ thanh từ $0.
  if (mmFee.volume30d === null || new Decimal(mmFee.volume30d).lte(0))
    return { kind: "plain", rate: mmFee.rate };
  if (mmFee.nextVolume !== null && mmFee.nextRate !== null) {
    const volume = new Decimal(mmFee.volume30d);
    const target = new Decimal(mmFee.nextVolume);
    // Phép trừ ngưỡng − volume hiện tại, không phải dự báo.
    const left = target.minus(volume);
    const ratio = target.gt(0) ? volume.div(target).mul(100) : new Decimal(0);
    return {
      kind: "next",
      rate: mmFee.rate,
      volume: mmFee.volume30d,
      nextVolume: mmFee.nextVolume,
      nextRate: mmFee.nextRate,
      amount: left.gt(0) ? left.ceil().toFixed() : null,
      progress: Math.min(100, Math.max(0, ratio.toNumber())),
    };
  }
  const min = FEE_TIERS[Strategy.volumeMaker]?.find((t) => t.rate === mmFee.rate)?.minVolume;
  return { kind: "top", rate: mmFee.rate, volume: mmFee.volume30d, min: min ?? null };
}

/** Mức của user nằm ở bậc nào: chỉ đánh dấu khi mức đến từ bậc volume. */
function hereRate(view: MmFeeView): number | null {
  return view.kind === "next" || view.kind === "top" ? view.rate : null;
}

/** Bảng 3 bậc; `here` đánh dấu dòng "You". Tiêu đề cột luôn có cho trình đọc màn hình. */
export function MmFeeLadder({ view, showHead = false }: { view: MmFeeView; showHead?: boolean }) {
  const t = useTranslations("fees.tiers");
  const here = hereRate(view);
  const rows = mmTierRows();
  return (
    <table className="w-full border-collapse text-[13px] tabular-nums">
      <thead className={showHead ? undefined : "sr-only"}>
        <tr>
          <th className="pb-1.5 text-left text-[11px] font-extrabold uppercase tracking-[0.04em] text-muted">
            <span className="hidden sm:inline">{t("volumeHead")}</span>
            <span className="sm:hidden">{t("volumeHeadShort")}</span>
          </th>
          <th className="pb-1.5 text-right text-[11px] font-extrabold uppercase tracking-[0.04em] text-muted">
            {t("feeHead")}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const mine = here === r.rate;
          const label =
            i === 0
              ? t("t1", { min: usdShort(r.to ?? 0) })
              : r.to === null
                ? t("t3", { min: usdShort(r.from) })
                : t("t2", { min: usdShort(r.from), max: usdShort(r.to) });
          return (
            <tr
              key={r.rate}
              aria-current={mine ? "true" : undefined}
              className={mine ? "text-accent-ink" : "text-ink-2"}
            >
              <td className="border-t border-border py-2">
                {label}
                {mine ? (
                  <span className="ml-2 rounded-lg bg-accent px-[7px] py-px text-[11px] font-extrabold text-white">
                    {t("you")}
                  </span>
                ) : null}
              </td>
              <td className="border-t border-border py-2 text-right font-extrabold text-ink">
                {pct(r.rate)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function LowestPill() {
  const t = useTranslations("bots.catalog");
  return (
    <span className="rounded-lg bg-pos-bg px-2 py-0.5 text-[11.5px] font-extrabold text-pos">
      {t("topTier")}
    </span>
  );
}

/** Câu trạng thái dưới mức phí (2b / 2c / 5b): dùng chung cho catalog và Settings. */
export function MmFeeStatus({ view, settings = false }: { view: MmFeeView; settings?: boolean }) {
  const t = useTranslations("bots.catalog");
  const tc = useTranslations("createBot.beforeStart");
  const bold = (chunks: ReactNode) => <b className="text-ink">{chunks}</b>;
  switch (view.kind) {
    case "custom":
      return <span className="text-[13px] text-ink-2">{t("customFee")}</span>;
    case "top":
      return view.volume === null || view.min === null ? null : (
        <span className="text-[13px] text-ink-2">
          {t("keepTier", { volume: usdFull(view.volume), min: usdShort(view.min) })}
        </span>
      );
    case "next":
      return (
        <span className="text-[13px] text-ink-2">
          {settings ? `${t("mmVolume", { volume: usdFull(view.volume) })}. ` : null}
          {view.amount === null
            ? null
            : t.rich("toNextTier", {
                amount: usdFull(view.amount),
                rate: pct(view.nextRate),
                b: bold,
              })}
        </span>
      );
    case "plain":
      return settings ? (
        <span className="text-[13px] text-ink-2">{tc("feeMmTiers", mmTierArgs())}</span>
      ) : (
        <span className="text-xs text-muted">{t("tiersNote")}</span>
      );
  }
}

/** Tham số cho câu "The rate drops to {tier2} at {min2} and {tier3} at {min3}…". */
export function mmTierArgs(): { tier2: string; min2: string; tier3: string; min3: string } {
  const [, second, third] = mmTierRows();
  return {
    tier2: second === undefined ? "" : pct(second.rate),
    min2: second === undefined ? "" : usdShort(second.from),
    tier3: third === undefined ? "" : pct(third.rate),
    min3: third === undefined ? "" : usdShort(third.from),
  };
}

/** Khối phí Market Making trên thẻ catalog (2b, 2c; 2a khi chưa có dữ liệu volume). */
export function MmFeeCatalog({ view }: { view: MmFeeView }) {
  const t = useTranslations("bots.catalog");
  return (
    <div className="flex flex-col gap-2 rounded-[14px] bg-bg px-3.5 py-3">
      <div className="flex flex-wrap items-baseline gap-2 tabular-nums">
        {view.kind === "plain" ? (
          <strong className="text-[13px] font-extrabold text-ink">
            {t("feeRate", { rate: pct(view.rate) })}
          </strong>
        ) : (
          <>
            <span className="text-xs font-bold text-muted">{t("yourFee")}</span>
            <strong className="text-xl font-extrabold text-ink">{pct(view.rate)}</strong>
            {view.kind === "top" ? <LowestPill /> : null}
          </>
        )}
      </div>
      {view.kind === "next" ? (
        <div className="flex flex-col gap-1.5">
          <div
            role="img"
            aria-label={t("mmProgress", {
              volume: usdFull(view.volume),
              target: usdFull(view.nextVolume),
            })}
            className="h-2 overflow-hidden rounded bg-border"
          >
            <i
              className="block h-full rounded bg-accent"
              style={{ width: `${String(view.progress)}%` }}
            />
          </div>
          <div className="flex justify-between gap-2 text-xs text-muted tabular-nums">
            <span>{t("mmVolume", { volume: usdFull(view.volume) })}</span>
            <span>{usdShort(Number(view.nextVolume))}</span>
          </div>
        </div>
      ) : null}
      {view.kind === "plain" ? null : <MmFeeStatus view={view} />}
      <MmFeeLadder view={view} showHead={view.kind === "plain"} />
      {view.kind === "plain" ? <MmFeeStatus view={view} /> : null}
    </div>
  );
}
