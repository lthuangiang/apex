"use client";

import {
  builderFeeRateFor,
  NEWS_SIGNAL_LEVERAGE,
  NEWS_SIGNAL_LIVE_MAX_USDC,
  Strategy,
} from "@drift/shared";
import { useTranslations } from "next-intl";
import { useId, type ReactNode } from "react";

import { feeLabels } from "@/lib/format";
import { useFeatures } from "@/lib/queries";

import { STEP_KEYS, type StepKey } from "./overview-flow";

// Tab Overview của drawer How it works khi trang đang ở chế độ Mainnet (#454, mockup
// docs/mockups/signal-research/mainnet-mode-colors.html khung 4–5): lệnh thật gửi xuống SoDEX từ tài khoản của người dùng,
// TP / SL là lệnh trên SoDEX. Bước 1–4 dùng chung với Paper nên chỉ một mục "same as Paper"; bước 5, 6, phần trên SoDEX và
// Mainnet trades có nhãn "mainnet". Số lấy từ hằng của @drift/shared (trần 200 USDC, 1×) và builder fee của News bot (có
// override riêng của người dùng thì theo override); chu kỳ lấy từ API như bản Paper, không có thì "Not available".

const b = (c: ReactNode) => <b className="text-ink">{c}</b>;

const W = 580;
const H = 760;
/** Hộp của 6 bước trên trục giữa (toạ độ theo khung 4 của mockup). */
const BOX = { x: 170, w: 230, h: 58, y0: 22, gap: 78 } as const;

/** Nhãn "Mainnet" cạnh tiêu đề drawer (nền `pos`, chữ trắng như tab Mainnet). */
export function MainnetTag() {
  const t = useTranslations("signalAnalysis.research.page.drawer.overview.mainnet");
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-pos px-2.5 py-0.5 text-xs font-extrabold text-white">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-surface" />
      {t("tag")}
    </span>
  );
}

export function MainnetOverviewPanel({ cycleMinutes = null }: { cycleMinutes?: number | null }) {
  const t = useTranslations("signalAnalysis.research.page.drawer.overview.mainnet");
  const features = useFeatures();
  const nums = {
    usdc: NEWS_SIGNAL_LIVE_MAX_USDC,
    lev: NEWS_SIGNAL_LEVERAGE,
    fee: feeLabels(builderFeeRateFor(Strategy.newsSignal, features.data?.builderFees)).pct,
  };
  const items = ["filter", "decide", "sodex", "trades"] as const;
  return (
    <>
      <p
        data-testid="hiw-intro"
        className="m-0 shrink-0 rounded-[12px] border border-pos-border bg-pos-bg/60 px-3.5 py-3 text-ink"
      >
        {cycleMinutes === null
          ? t.rich("introNa", { b })
          : t.rich("intro", { min: cycleMinutes, b })}
      </p>

      <div
        data-testid="hiw-flow"
        className="shrink-0 overflow-x-auto rounded-tile border border-border px-2 py-3"
      >
        <div className="min-w-[580px]">
          <MainnetDiagram cycleMinutes={cycleMinutes} usdc={nums.usdc} lev={nums.lev} />
        </div>
      </div>

      <ul data-testid="hiw-mainnet-list" className="m-0 grid shrink-0 list-none gap-2.5 p-0">
        <li className="rounded-[14px] border border-border px-3.5 py-3">
          <b className="text-[15px] text-ink">{t("list.shared.name")}</b>
          <span className="ml-1.5 rounded-full bg-surface-2 px-2 py-px align-[2px] text-[11px] font-extrabold text-muted">
            {t("list.same")}
          </span>
          <p className="m-0 mt-1.5 text-[13.5px] text-ink-2">{t("list.shared.body")}</p>
        </li>
        {items.map((k) => (
          <li key={k} className="rounded-[14px] border border-pos-border bg-pos-bg/60 px-3.5 py-3">
            <b className="text-[15px] text-ink">{t(`list.${k}.name`)}</b>
            <span className="ml-1.5 rounded-full bg-pos px-2 py-px align-[2px] text-[11px] font-extrabold text-white">
              {t("list.badge")}
            </span>
            <div className="text-[13px] text-muted">{t(`list.${k}.sub`)}</div>
            <p className="m-0 mt-1.5 text-[13.5px] text-ink-2">{t(`list.${k}.body`, nums)}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

function MainnetDiagram({
  cycleMinutes,
  usdc,
  lev,
}: {
  cycleMinutes: number | null;
  usdc: string;
  lev: number;
}) {
  const t = useTranslations("signalAnalysis.research.page.drawer.overview");
  const tm = useTranslations("signalAnalysis.research.page.drawer.overview.mainnet.diagram");
  const id = useId().replace(/:/g, "");
  const arrow = `${id}-a`;
  const arrowPos = `${id}-ap`;
  const arrowAi = `${id}-aa`;
  const strong = (c: ReactNode) => <tspan fontWeight={800}>{c}</tspan>;
  const muted = "fill-muted";
  const step = (k: StepKey, i: number) => {
    const y = BOX.y0 + i * BOX.gap;
    const decide = k === "decide";
    const context = k === "context";
    return (
      <g key={k}>
        <rect
          x={BOX.x}
          y={y}
          width={BOX.w}
          height={BOX.h}
          rx={10}
          className={
            decide
              ? "fill-pos"
              : context
                ? "fill-surface stroke-accent stroke-[1.5] [stroke-dasharray:6_4]"
                : "fill-surface stroke-accent stroke-[1.5]"
          }
        />
        <text
          x={BOX.x + 14}
          y={y + 24}
          fontSize={13}
          fontWeight={800}
          className={decide ? "fill-white" : "fill-ink"}
        >
          {tm("stepTitle", { n: i + 1, name: t(`steps.${k}.name`) })}
        </text>
        <text x={BOX.x + 14} y={y + 42} fontSize={11} className={decide ? "fill-pos-bg" : muted}>
          {tm(`steps.${k}`)}
        </text>
      </g>
    );
  };
  const marker = (mid: string, cls: string) => (
    <marker
      id={mid}
      viewBox="0 0 10 10"
      refX={9}
      refY={5}
      markerWidth={7}
      markerHeight={7}
      orient="auto-start-reverse"
    >
      <path d="M0 0L10 5L0 10z" className={cls} />
    </marker>
  );
  const spine = STEP_KEYS.slice(1).map((_, i) => {
    const y = BOX.y0 + i * BOX.gap + BOX.h;
    return `M285 ${String(y)} V${String(y + BOX.gap - BOX.h - 2)}`;
  });
  return (
    <svg
      viewBox={`0 0 ${String(W)} ${String(H)}`}
      role="img"
      aria-label={tm("label")}
      className="block h-auto w-full"
    >
      <defs>
        {marker(arrow, "fill-muted")}
        {marker(arrowPos, "fill-pos")}
        {marker(arrowAi, "fill-unknown")}
      </defs>

      {/* nguồn */}
      <rect x={8} y={22} width={150} height={58} rx={10} className="fill-surface-2 stroke-border" />
      <text x={20} y={46} fontSize={13} fontWeight={800} className="fill-ink">
        {t("diagram.soso.title")}
      </text>
      <text x={20} y={64} fontSize={11} className={muted}>
        {cycleMinutes === null ? tm("sosoNa") : tm("soso", { min: cycleMinutes })}
      </text>
      <path
        d="M158 51 H168"
        fill="none"
        markerEnd={`url(#${arrow})`}
        className="stroke-muted stroke-[1.5]"
      />

      {/* trục giữa */}
      {STEP_KEYS.map(step)}
      {spine.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          markerEnd={`url(#${arrow})`}
          className="stroke-muted stroke-[1.5]"
        />
      ))}

      {/* Claude reader */}
      <rect
        x={424}
        y={172}
        width={148}
        height={70}
        rx={10}
        className="fill-unknown-bg stroke-unknown"
      />
      <text x={436} y={194} fontSize={12} fontWeight={800} className="fill-unknown">
        {tm("reader.title")}
      </text>
      <text x={436} y={211} fontSize={10.5} className="fill-ink-2">
        {tm("reader.l1")}
      </text>
      <text x={436} y={227} fontSize={10.5} className="fill-ink-2">
        {tm("reader.l2")}
      </text>
      <path
        d="M400 200 H420"
        fill="none"
        markerEnd={`url(#${arrowAi})`}
        className="stroke-unknown stroke-[1.5]"
      />
      <path
        d="M424 216 H404"
        fill="none"
        markerEnd={`url(#${arrowAi})`}
        className="stroke-unknown stroke-[1.5]"
      />

      {/* bot */}
      <rect
        x={424}
        y={328}
        width={148}
        height={70}
        rx={10}
        className="fill-surface stroke-border"
      />
      <text x={436} y={350} fontSize={12} fontWeight={800} className="fill-ink">
        {tm("bot.title")}
      </text>
      <text x={436} y={367} fontSize={10.5} className="fill-ink-2">
        {tm("bot.l1")}
      </text>
      <text x={436} y={383} fontSize={10.5} className="fill-ink-2">
        {tm("bot.l2", { usdc, lev })}
      </text>
      <path
        d="M424 363 H404"
        fill="none"
        markerEnd={`url(#${arrow})`}
        className="stroke-muted stroke-[1.5]"
      />

      {/* SoDEX */}
      <path
        d="M285 470 V496"
        fill="none"
        markerEnd={`url(#${arrowPos})`}
        className="stroke-pos stroke-2"
      />
      <text x={292} y={490} fontSize={11} fontWeight={700} className="fill-pos">
        {tm("sodex.order")}
      </text>
      <rect
        x={96}
        y={500}
        width={456}
        height={150}
        rx={14}
        className="fill-pos-bg stroke-pos-dot stroke-2"
      />
      <text x={114} y={526} fontSize={14} fontWeight={800} className="fill-pos">
        {tm("sodex.title")}
      </text>
      <text x={114} y={550} fontSize={12} className="fill-ink">
        {tm.rich("sodex.entry", { b: strong })}
      </text>
      <text x={114} y={574} fontSize={12} className="fill-ink">
        {tm.rich("sodex.tpsl", { b: strong })}
      </text>
      <text x={114} y={598} fontSize={12} className="fill-ink">
        {tm("sodex.cancel")}
      </text>
      <text x={114} y={622} fontSize={12} className="fill-ink">
        {tm.rich("sodex.hold", { b: strong })}
      </text>

      {/* kết quả */}
      <path
        d="M200 650 V668"
        fill="none"
        markerEnd={`url(#${arrow})`}
        className="stroke-muted stroke-[1.5]"
      />
      <rect x={96} y={672} width={210} height={62} rx={10} className="fill-surface stroke-border" />
      <text x={110} y={696} fontSize={12.5} fontWeight={800} className="fill-ink">
        {tm("trades.title")}
      </text>
      <text x={110} y={714} fontSize={10.5} className="fill-ink-2">
        {tm("trades.l1")}
      </text>
      <text x={110} y={728} fontSize={10.5} className="fill-ink-2">
        {tm("trades.l2")}
      </text>
      <rect
        x={328}
        y={672}
        width={224}
        height={62}
        rx={10}
        className="fill-surface stroke-border"
      />
      <text x={342} y={696} fontSize={12.5} fontWeight={800} className="fill-ink">
        {tm("control.title")}
      </text>
      <text x={342} y={714} fontSize={10.5} className="fill-ink-2">
        {tm("control.l1")}
      </text>
      <text x={342} y={728} fontSize={10.5} className="fill-ink-2">
        {tm("control.l2")}
      </text>
      <text x={8} y={756} fontSize={11.5} fontWeight={700} className="fill-pos">
        {tm("never")}
      </text>
    </svg>
  );
}
