"use client";

import type { ResearchSignalContext } from "@drift/shared";
import { useTranslations } from "next-intl";
import type { CSSProperties, ReactNode } from "react";

import { clock } from "../format";

import { IdleScenes, useIdlePauseRef } from "./context-idle";
import {
  answerTone,
  contextYesCount,
  exploratoryRows,
  h1Text,
  h2Text,
  h3Text,
  priceDirection,
  type AnswerText,
  type AnswerTone,
  type ContextAnswer,
} from "./context-text";
import type { ContextReach } from "./trace-player";
import { Na } from "./ui";
import { WhaleIcon } from "./whale-icon";

// Khung 4 · Context cạnh phễu + thẻ bước 4 (#343, mockup redesign-trace-live.html, redesign-trace-no-signal.html,
// redesign-context-effects.html, redesign-context-card.html). Chỉ hiển thị: không hẹn giờ, không đọc API. Hiệu ứng là CSS
// chạy một lần khi phần tử gắn vào DOM; muốn chạy lại (Replay) thì đổi `playKey`. Trạng thái gốc của mọi phần tử là khung
// cuối, nên reduced motion (không có lớp motion-safe) hiện ngay khung cuối. Dùng chung với bài mới live (#345).

/** Màu nhạt của phễu / nước (token accent pha với nền). */
export const ACCENT_SOFT = "bg-[color-mix(in_srgb,var(--accent)_25%,var(--surface))]";

const TAG: Record<AnswerTone | "plain", string> = {
  accent: "bg-surface text-accent-ink",
  warn: "bg-warn-bg text-warn",
  neutral: "bg-surface text-ink-2",
  plain: "bg-surface text-muted",
};
const WORD: Record<AnswerTone, string> = {
  accent: "text-accent-ink",
  warn: "text-warn",
  neutral: "text-ink-2",
};

const POP = "motion-safe:animate-[sr-pop_.35s_cubic-bezier(.2,1.6,.4,1)_.8s_both]";

function Tag({ tone, children }: { tone: AnswerTone | "plain"; children: ReactNode }) {
  return (
    <span
      className={`absolute left-1.5 top-1.5 z-[1] max-w-[calc(100%-12px)] truncate rounded-full px-2 py-0.5 text-[11px] font-extrabold ${TAG[tone]} ${POP}`}
    >
      {children}
    </span>
  );
}

export { WhaleIcon };

/* ---------------------------------------------------------------- Scenes */

/** H1: cá voi nhảy lên (Yes), sonar + cá voi lội nền (No), cá voi xám bơi đi (Disagree), hộp đứt (Not available). */
export function WhaleScene({ answer, tag }: { answer: ContextAnswer; tag: string }) {
  return (
    <div
      data-testid="sr-ctx-h1"
      data-answer={answer}
      className="relative h-[70px] overflow-hidden rounded-[10px] bg-accent-tint"
    >
      <div aria-hidden="true" className={`absolute inset-x-0 bottom-0 h-[22px] ${ACCENT_SOFT}`} />
      {answer === "yes" ? (
        <div aria-hidden="true" className="absolute inset-0">
          <div className="absolute left-1/2 top-[50px] -ml-5 h-2.5 w-10 rounded-[50%] border-2 border-accent opacity-0 motion-safe:animate-[sr-ripple_.8s_ease-out_.4s_both]" />
          <WhaleIcon
            spout
            style={{ transform: "translate(8px, 2px)" }}
            className="absolute left-1/2 top-[18px] -ml-[35px] h-10 w-[70px] fill-accent-ink motion-safe:animate-[sr-whale_1.1s_cubic-bezier(.3,.7,.3,1)_both]"
          />
        </div>
      ) : null}
      {answer === "no" ? (
        <div aria-hidden="true" className="absolute inset-0">
          <div className="absolute inset-y-0 left-full w-[60px] bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--accent)_25%,transparent),transparent)] motion-safe:animate-[sr-scan_1.1s_ease-in-out_both]" />
          {/* Cá voi lội nền: 2.6 s một lượt, dưới chữ (z thấp hơn tag), ẩn hẳn khi reduced motion. */}
          <WhaleIcon
            style={{ transform: "translateX(60px)" }}
            className="sr-swim absolute left-[18%] top-[52px] h-[18px] w-[30px] fill-accent opacity-55 motion-reduce:hidden motion-safe:animate-[sr-swim_2.6s_ease-in-out_both]"
          />
          <WhaleIcon
            style={{ transform: "translateX(-50px) scaleX(-1)" }}
            className="sr-swim absolute left-[64%] top-[56px] h-3.5 w-6 fill-accent opacity-40 motion-reduce:hidden motion-safe:animate-[sr-swim2_2.6s_ease-in-out_.2s_both]"
          />
          <div className="absolute left-1/2 top-1/2 -ml-[45px] -mt-[45px] size-[90px] rounded-full border-2 border-accent opacity-35 motion-safe:animate-[sr-sonar_1.1s_ease-out_both]" />
          <div className="absolute left-1/2 top-1/2 -ml-[45px] -mt-[45px] size-[90px] rounded-full border-2 border-accent opacity-35 motion-safe:animate-[sr-sonar_1.1s_ease-out_.35s_both]" />
          <div className="absolute left-1/2 top-1/2 -ml-1 -mt-1 size-2 rounded-full bg-accent" />
        </div>
      ) : null}
      {answer === "against" ? (
        <WhaleIcon
          flip
          style={{ transform: "translateX(50px)" }}
          className="absolute left-1/2 top-6 -ml-[35px] h-10 w-[70px] fill-muted opacity-35 motion-safe:animate-[sr-away_1.1s_ease-in_both]"
        />
      ) : null}
      {answer === "na" ? (
        <div
          aria-hidden="true"
          className="absolute inset-1.5 rounded-lg border-2 border-dashed border-border-input bg-surface-2"
        />
      ) : null}
      <Tag tone={answer === "yes" ? "accent" : answer === "na" ? "plain" : "neutral"}>{tag}</Tag>
    </div>
  );
}

/** H2: bập bênh nghiêng về đám đông (Yes), lắc rồi cân bằng (No / Not available). */
export function SeesawScene({ answer, tag }: { answer: ContextAnswer; tag: string }) {
  const yes = answer === "yes";
  const na = answer === "na";
  return (
    <div
      data-testid="sr-ctx-h2"
      data-answer={answer}
      className="relative h-14 overflow-hidden rounded-[10px] border border-border bg-surface-2"
    >
      <div
        aria-hidden="true"
        className="absolute bottom-2 left-1/2 -ml-2 size-0 border-x-8 border-b-[14px] border-x-transparent border-b-ink-2"
      />
      <div
        aria-hidden="true"
        style={
          { "--tip": yes ? "-8deg" : "0deg", transform: "rotate(var(--tip))" } as CSSProperties
        }
        className={`absolute bottom-[22px] left-1/2 -ml-20 h-1 w-40 origin-bottom rounded-sm ${
          na ? "bg-border-input" : "bg-ink"
        } ${
          yes
            ? "motion-safe:animate-[sr-tip_1s_cubic-bezier(.5,1.6,.4,1)_.1s_both]"
            : "motion-safe:animate-[sr-wobble_1s_ease-out_both]"
        }`}
      >
        {na ? null : (
          <>
            <div className="absolute bottom-1 left-0.5 flex gap-0.5">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="h-3 w-2 rounded-t-[4px] rounded-b-[1px] bg-neg-ink" />
              ))}
            </div>
            <span className="absolute bottom-1 right-1 h-3.5 w-2.5 rounded-t-[5px] rounded-b-[1px] bg-accent" />
          </>
        )}
      </div>
      <Tag tone={yes ? "accent" : na ? "plain" : "neutral"}>{tag}</Tag>
    </div>
  );
}

const PRE = "M10 28 L60 26 L110 29 L150 28";
const RUN: Record<"up" | "down" | "flat", { yes: string; no: string }> = {
  up: { yes: "M150 28 L180 14 L210 4", no: "M150 28 L180 26 L210 24" },
  down: { yes: "M150 28 L180 42 L210 52", no: "M150 28 L180 30 L210 31" },
  flat: { yes: "M150 28 L180 28 L210 28", no: "M150 28 L180 28 L210 28" },
};

/** H3: đường giá chạy tới vạch vào lệnh; hổ phách khi đã chạy ≥ 1 biến động 1 giờ (cảnh báo, không ăn mừng). */
export function PriceRunScene({
  answer,
  tag,
  direction,
}: {
  answer: ContextAnswer;
  tag: string;
  direction: "up" | "down" | "flat";
}) {
  const yes = answer === "yes";
  const na = answer === "na";
  return (
    <div
      data-testid="sr-ctx-h3"
      data-answer={answer}
      className="relative h-14 overflow-hidden rounded-[10px] border border-border bg-surface-2"
    >
      <svg
        aria-hidden="true"
        width="100%"
        height="56"
        viewBox="0 0 280 56"
        preserveAspectRatio="none"
        className="absolute inset-0"
      >
        <line
          x1="210"
          y1="4"
          x2="210"
          y2="52"
          className="stroke-muted"
          strokeWidth="2"
          strokeDasharray="3 3"
        />
        <path d={PRE} className="fill-none stroke-muted" strokeWidth="3" strokeLinecap="round" />
        {na ? null : (
          <path
            d={RUN[direction][yes ? "yes" : "no"]}
            className={`fill-none ${yes ? "stroke-warn-bar" : "stroke-accent"} motion-safe:animate-[sr-run_.9s_cubic-bezier(.2,.8,.2,1)_.1s_both]`}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray="120"
            strokeDashoffset="0"
          />
        )}
      </svg>
      <Tag tone={yes ? "warn" : na ? "plain" : "neutral"}>{tag}</Tag>
    </div>
  );
}

/** Ba biểu tượng nhỏ trên tầng 4 (sáng lên theo từng Yes). */
export function ContextIcons({ context }: { context: ResearchSignalContext }) {
  const h1 = context.h1.status;
  return (
    <span aria-hidden="true" className="hidden items-center gap-1.5 min-[1400px]:inline-flex">
      <WhaleIcon
        className={`h-3 w-5 ${
          h1 === "yes"
            ? "fill-accent-ink"
            : h1 === "na"
              ? "fill-bg"
              : "fill-[color-mix(in_srgb,var(--accent)_25%,var(--surface))]"
        }`}
      />
      <svg viewBox="0 0 22 16" className="h-3 w-4">
        <path
          d="M1 12 L21 6"
          className={
            context.h2.status === "yes"
              ? "stroke-ink"
              : "stroke-[color-mix(in_srgb,var(--accent)_25%,var(--surface))]"
          }
          strokeWidth="3"
          strokeLinecap="round"
        />
        <path
          d="M11 9 L8 15 L14 15 Z"
          className={
            context.h2.status === "yes"
              ? "fill-ink"
              : "fill-[color-mix(in_srgb,var(--accent)_25%,var(--surface))]"
          }
        />
      </svg>
      <svg viewBox="0 0 22 16" className="h-3 w-4">
        <path
          d="M1 2 L8 4 L13 9 L21 14"
          className={`fill-none ${context.h3.status === "yes" ? "stroke-warn-bar" : "stroke-[color-mix(in_srgb,var(--accent)_25%,var(--surface))]"}`}
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

/* ---------------------------------------------------------------- Panel */

/**
 * `idle`: chế độ tổng, chưa có bài nào để xem (hoạt cảnh chờ); `waiting`: chip chưa tới bước 4; `notReached` / `missing`:
 * bài không có snapshot; `shown`: chạy hiệu ứng có thông tin. Mọi trạng thái trừ `shown` dùng hoạt cảnh chờ.
 */
export type ContextPanelState = "idle" | "waiting" | "shown" | Exclude<ContextReach, "recorded">;

export interface ContextAnswers {
  h1: AnswerText;
  h2: AnswerText;
  h3: AnswerText;
}

/** Câu của cả ba giả thuyết (dùng chung cho khung và thẻ). */
export function useContextAnswers(
  context: ResearchSignalContext | null,
  asset: string,
  tz: string,
): ContextAnswers | null {
  const t = useTranslations("signalAnalysis.research");
  if (context === null) return null;
  return { h1: h1Text(context, asset, tz, t), h2: h2Text(context, t), h3: h3Text(context, t) };
}

/**
 * Khung "4 · Context" cạnh phễu. `state`: `waiting` (chip chưa tới bước 4), `shown` (chạy hiệu ứng), `notReached` (bài
 * dừng trước bước 4), `missing` (bài trước khi có bước này). `playKey` đổi = hiệu ứng chạy lại.
 */
export function ContextPanel({
  state,
  context,
  asset,
  tz,
  playKey,
  className = "",
}: {
  state: ContextPanelState;
  context: ResearchSignalContext | null;
  asset: string;
  tz: string;
  playKey: string | number;
  className?: string;
}) {
  const t = useTranslations("signalAnalysis.research");
  const answers = useContextAnswers(context, asset, tz);
  const shown = state === "shown" && context !== null && answers !== null;
  const { ref, paused } = useIdlePauseRef();
  return (
    <div
      ref={ref}
      role="group"
      aria-labelledby="sr-ctx-panel-title"
      data-testid="sr-ctx-panel"
      data-state={shown ? "shown" : state}
      className={`flex min-w-0 flex-col gap-2 rounded-[14px] border-2 border-dashed bg-surface p-2.5 ${
        shown ? "border-accent" : "border-[color-mix(in_srgb,var(--accent)_25%,var(--surface))]"
      } ${className}`}
    >
      <div className="flex items-center justify-between gap-2">
        <h4 id="sr-ctx-panel-title" className="m-0 text-[13px] font-extrabold">
          {t("trace.band", { n: 4, name: t("trace.stages.context") })}
        </h4>
        <span className="text-[11px] font-bold text-muted">{t("context.recordsOnly")}</span>
      </div>
      {shown ? (
        <div key={playKey} className="flex flex-col gap-2">
          <WhaleScene answer={answers.h1.answer} tag={answers.h1.tag} />
          <SeesawScene answer={answers.h2.answer} tag={answers.h2.tag} />
          <PriceRunScene
            answer={answers.h3.answer}
            tag={answers.h3.tag}
            direction={priceDirection(context)}
          />
        </div>
      ) : (
        <>
          <IdleScenes paused={paused} />
          <p className="m-0 text-center text-xs text-muted">
            {state === "notReached"
              ? t("context.never")
              : state === "missing"
                ? t("context.missing")
                : state === "waiting"
                  ? t("context.waiting")
                  : t("context.idle")}
          </p>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Step 4 card */

/** Thẻ bước 4 trong danh sách bước của trace (giữa Score và Filter): giá trị lưu lúc quyết định, không tính lại. */
export function ContextCard({
  context,
  asset,
  tz,
}: {
  context: ResearchSignalContext;
  asset: string;
  tz: string;
}) {
  const t = useTranslations("signalAnalysis.research");
  const answers = useContextAnswers(context, asset, tz);
  if (answers === null) return null;
  const items: { key: "h1" | "h2" | "h3"; a: AnswerText }[] = [
    { key: "h1", a: answers.h1 },
    { key: "h2", a: answers.h2 },
    { key: "h3", a: answers.h3 },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 md:gap-2.5">
        <span
          aria-hidden="true"
          className="inline-flex size-6 flex-none items-center justify-center rounded-full bg-accent-tint text-xs font-extrabold text-accent-ink md:size-7 md:text-[13px]"
        >
          4
        </span>
        <h4 className="m-0 flex-1 text-sm font-extrabold md:text-[15px]">
          {t("context.cardTitle", { time: clock(context.decidedAt, tz) })}
        </h4>
        <span className="flex-none rounded-full bg-bg px-2.5 py-[3px] text-xs font-extrabold text-ink-2">
          {t(`context.cardTag.${context.source}`)}
        </span>
      </div>
      <p className="sr-only">{t("context.yesOf", { n: contextYesCount(context) })}</p>
      <div className="grid gap-2.5 md:grid-cols-3">
        {items.map(({ key, a }) => {
          const tone = answerTone(key, a.answer);
          return (
            <div
              key={key}
              data-testid={`sr-ctx-card-${key}`}
              className="flex flex-col gap-1.5 rounded-tile border border-border p-3"
            >
              <span className="text-xs font-extrabold text-muted">{t(`context.h.${key}`)}</span>
              <div className={`text-lg font-extrabold ${WORD[tone]}`}>{a.badge}</div>
              <p className="m-0 text-xs leading-[1.45] text-ink-2">{a.text}</p>
            </div>
          );
        })}
      </div>
      <details className="border-t border-bg pt-2">
        <summary className="flex min-h-8 cursor-pointer items-center text-[13px] font-bold">
          {t("context.exploratory")}
        </summary>
        <dl className="m-0 mt-1.5 flex flex-col gap-1 text-[13px]">
          {exploratoryRows(context, t).map((r) => (
            <div key={r.label} className="grid grid-cols-[minmax(0,200px)_minmax(0,1fr)] gap-3">
              <dt className="text-muted">{r.label}</dt>
              <dd className="m-0 font-bold">{r.value ?? <Na />}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
