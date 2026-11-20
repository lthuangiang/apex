import { SIGNAL_CONTEXT_V1, type ResearchSignalContext } from "@drift/shared";

import { clock } from "../format";

import { pctSigned, usdCompact } from "./format";
import type { Tr } from "./text";

// Câu chữ của bước 4 · Context (#343, thiết kế docs/mockups/signal-research/redesign-trace-live.html,
// redesign-context-effects.html, redesign-context-card.html). Hàm thuần: chỉ dựng câu từ snapshot API #349 đã lưu lúc
// quyết định; thiếu số thì "Not available", không bao giờ 0 (quy tắc 1.8). Dùng chung cho trace và bài mới live (#345).

export type ContextAnswer = "yes" | "no" | "against" | "na";
/** Màu badge: Yes = xanh dương trung tính; H3 Yes = hổ phách (cảnh báo); còn lại xám. Không bao giờ xanh lá. */
export type AnswerTone = "accent" | "warn" | "neutral";

export const answerTone = (key: "h1" | "h2" | "h3", a: ContextAnswer): AnswerTone =>
  a !== "yes" ? "neutral" : key === "h3" ? "warn" : "accent";

/** "2 of 3 yes": số giả thuyết trả lời Yes. */
export function contextYesCount(c: Pick<ResearchSignalContext, "h1" | "h2" | "h3">): number {
  return [c.h1.status, c.h2.status, c.h3.status].filter((s) => s === "yes").length;
}

type Side = ResearchSignalContext["side"];
const opposite = (s: Side): Side => (s === "long" ? "short" : "long");

/** Phần trăm 1 chữ số có dấu: "+1.1%" / "−0.9%". */
const pct1 = (v: number): string => pctSigned(v, 1);
/** Phần trăm không dấu 1 chữ số: "0.6%". */
const pctAbs1 = (v: number): string => `${Math.abs(v).toFixed(1)}%`;
/** Funding thô mỗi kỳ (0.0001 = 0.010%), 3 chữ số như thiết kế. */
const fundingPct = (raw: string): string => {
  const v = Number(raw) * 100;
  return `${v < 0 && Number(v.toFixed(3)) !== 0 ? "−" : ""}${Math.abs(v).toFixed(3)}%`;
};
/** Giờ của kỳ funding: 8 → "8", 0.5 → "0.5". */
const hoursText = (h: number): string => String(Math.round(h * 100) / 100);

export interface AnswerText {
  answer: ContextAnswer;
  /** Badge: "Yes" / "No" / "Disagree" / "Not available" / "Yes · warning". */
  badge: string;
  /** Nhãn ngắn trong khung Context cạnh phễu. */
  tag: string;
  /** Câu đầy đủ trên thẻ bước 4. */
  text: string;
}

function badgeOf(key: "h1" | "h2" | "h3", a: ContextAnswer, t: Tr): string {
  if (key === "h3" && a === "yes") return t("context.answer.yesWarn");
  return t(`context.answer.${a}`);
}

/** Câu H1 có ở cả hai bộ (v1 "tracked wallets" và "research wallets"). */
type H1Key = "yes" | "no" | "noNa" | "against" | "naWallets" | "naAny" | "tagNaWallets";

/**
 * H1 · Whales agree. `asset`: tên ngắn của tài sản ("ETH"). Câu chữ theo context version của snapshot (#353): context-v1
 * (ví được follow) giữ câu "tracked wallets"; version hiện tại ghi "research wallets (top {K} of the leaderboard)" với K =
 * số ví của tập ví nghiên cứu đã dùng (thiếu thì "top of the leaderboard", không bao giờ bịa số).
 */
export function h1Text(c: ResearchSignalContext, asset: string, tz: string, t: Tr): AnswerText {
  const h = c.h1;
  const side = t(`sides.${c.side}`);
  const mins = h.windowMinutes;
  const badge = badgeOf("h1", h.status, t);
  const checked = h.walletsChecked;
  const v1 = c.contextVersion === SIGNAL_CONTEXT_V1;
  const top =
    h.walletSetSize === null ? t("context.h1.topNoK") : t("context.h1.top", { k: h.walletSetSize });
  /** Khoá câu theo version: v1 `context.h1.<k>`, hiện tại `context.h1.research.<k>` (kèm `top`). */
  const say = (k: H1Key, v: Record<string, string | number> = {}) =>
    v1 ? t(`context.h1.${k}`, v) : t(`context.h1.research.${k}`, { ...v, top });
  switch (h.status) {
    case "yes": {
      const n = h.agreeingWallets ?? 0;
      const usd = h.agreeingUsdc === null ? null : usdCompact(h.agreeingUsdc);
      const parts = [say("yes", { n, side, asset, mins })];
      if (usd !== null) parts.push(usd);
      if (h.firstAt !== null)
        parts.push(t("context.h1.first", { time: clock(h.firstAt, tz, false) }));
      return {
        answer: "yes",
        badge,
        tag:
          usd === null
            ? t("context.h1.tagYesNoUsd", { n, side })
            : t("context.h1.tagYes", { n, usd: usd.replace(/^−/, ""), side }),
        text: parts.join(t("trades.sep")),
      };
    }
    case "no":
      return {
        answer: "no",
        badge,
        tag: checked === null ? t("context.h1.tagNoNa") : t("context.h1.tagNo", { n: checked }),
        text:
          checked === null ? say("noNa", { asset, mins }) : say("no", { n: checked, asset, mins }),
      };
    case "against": {
      const n = h.opposingWallets ?? 0;
      const opp = t(`sides.${opposite(c.side)}`);
      return {
        answer: "against",
        badge,
        tag: t("context.h1.tagAgainst", { n, side: opp }),
        text: say("against", { n, opp, asset, mins, side }),
      };
    }
    case "na": {
      // Snapshot dựng lại sau (#354): không dựng lại được việc theo dõi ví trong quá khứ, nên H1 luôn `na`.
      if (c.source === "backfilled")
        return { answer: "na", badge, tag: badge, text: t("context.h1.naBackfilled") };
      // Hai lý do (#349): tài sản không có trên Hyperliquid, hoặc 0 ví được kiểm (v1: ví theo dõi; hiện tại: ví nghiên cứu
      // đọc được trong 60 phút). Dòng cũ không lưu lý do.
      const why =
        h.assetOnHyperliquid === false ? "naAsset" : checked === 0 ? "naWallets" : "naAny";
      return {
        answer: "na",
        badge,
        tag:
          why === "naAsset"
            ? t("context.h1.tagNaAsset", { asset })
            : why === "naWallets"
              ? say("tagNaWallets")
              : t("context.h1.tagNaAny"),
        text: why === "naAsset" ? t("context.h1.naAsset") : say(why, { mins }),
      };
    }
  }
}

/** H2 · Funding against the crowd. */
export function h2Text(c: ResearchSignalContext, t: Tr): AnswerText {
  const h = c.h2;
  const badge = badgeOf("h2", h.status, t);
  if (h.status === "na" || h.percentile === null)
    return {
      answer: "na",
      badge: t("context.answer.na"),
      tag: t("context.h2.tagNa"),
      text: t("context.h2.na"),
    };
  const p = Math.round(h.percentile);
  const rate =
    h.fundingRate === null
      ? t("context.h2.rateNa")
      : h.intervalHours === null || h.intervalHours === 0
        ? t("context.h2.rateNoH", { rate: fundingPct(h.fundingRate) })
        : t("context.h2.rate", {
            rate: fundingPct(h.fundingRate),
            h: hoursText(h.intervalHours),
          });
  const need = t(c.side === "long" ? "context.h2.needLong" : "context.h2.needShort", {
    side: t(`sides.${c.side}`),
    p: Math.round(h.thresholdPercentile),
  });
  const text = [rate, t("context.h2.pct", { p, days: h.lookbackDays }), need].join(t("trades.sep"));
  const tag =
    h.status === "yes"
      ? t("context.h2.tagYes", {
          p,
          payer: t(`context.h2.payer.${h.payer ?? "none"}`),
        })
      : t("context.h2.tagNo", { p });
  return { answer: h.status, badge, tag, text };
}

/** H3 · Price already moved. Cảnh báo: Yes màu hổ phách. */
export function h3Text(c: ResearchSignalContext, t: Tr): AnswerText {
  const h = c.h3;
  const badge = badgeOf("h3", h.status, t);
  const na = t("na");
  const moved = h.movedPct === null ? null : pct1(h.movedPct);
  const text = [
    moved === null ? t("context.h3.movedNa") : t("context.h3.moved", { moved }),
    t("context.h3.typical", { pct: h.typicalMovePct === null ? na : pctAbs1(h.typicalMovePct) }),
    t("context.h3.threshold", { pct: h.thresholdPct === null ? na : pctAbs1(h.thresholdPct) }),
  ].join(t("trades.sep"));
  if (h.status === "na" || moved === null)
    return { answer: "na", badge: t("context.answer.na"), tag: t("context.h3.tagNa"), text };
  return {
    answer: h.status,
    badge,
    tag: h.status === "yes" ? t("context.h3.tagYes", { moved }) : t("context.h3.tagNo", { moved }),
    text,
  };
}

export interface ExploratoryRow {
  label: string;
  /** null = "Not available". */
  value: string | null;
}

/** Chỉ số khám phá; open interest luôn "Not available" (SoDEX không có). */
export function exploratoryRows(c: ResearchSignalContext, t: Tr): ExploratoryRow[] {
  const v = c.exploratory.volumeVs24h;
  const r = c.exploratory.rangeBreakout;
  return [
    {
      label: t("context.volume"),
      value: v === null ? null : t("context.times", { x: (Math.round(v * 10) / 10).toString() }),
    },
    { label: t("context.breakout"), value: r === null ? null : t(`context.breakouts.${r}`) },
    { label: t("context.openInterest"), value: null },
  ];
}

/** Hướng đường giá của H3 trong khung (theo dấu của giá đã chạy; thiếu số thì đi ngang). */
export function priceDirection(c: ResearchSignalContext): "up" | "down" | "flat" {
  const m = c.h3.movedPct;
  if (m === null || m === 0) return "flat";
  return m > 0 ? "up" : "down";
}
