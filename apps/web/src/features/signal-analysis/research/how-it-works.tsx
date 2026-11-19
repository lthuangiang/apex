"use client";

import {
  CLASSIFIER_GATE,
  RESEARCH_LEVELS,
  SIGNAL_CATALYSTS,
  versionHoldHours,
  type ResearchVersion,
} from "@drift/shared";
import { BottomSheet } from "@drift/ui";
import { useTranslations } from "next-intl";
import { createContext, useContext, useRef, type KeyboardEvent, type ReactNode } from "react";

import { ScrollTable } from "../components/bits";
import { count } from "../format";

import { hold } from "./format";
import { LEVEL_TONE, Na, Note, Pill, Sub, tdR, tdW, thR } from "./ui";
import { catalystName, catalystSide, configLine, versionShort } from "./version-text";

// Drawer "How it works" của trang Signal research (#342, thiết kế docs/mockups/signal-research/redesign-full-page*.html):
// nội dung cũ của khối "What counts as a news signal" chuyển vào đây, chia tab, theo luật của version đang chọn ở đầu trang.
// Không bao giờ tự mở; Esc đóng; Radix giữ focus trong drawer và trả focus về nút đã mở (BottomSheet). Desktop: bám cạnh
// phải (`side`); dưới 768px: chiếm màn hình như sheet của version.

export const HOW_TABS = ["news", "levels", "tpsl", "gate", "context", "versions"] as const;
export type HowTab = (typeof HOW_TABS)[number];

const HowContext = createContext<((tab: HowTab) => void) | null>(null);
export const HowItWorksProvider = HowContext.Provider;

/** Nút "?" nhỏ cạnh "Rules v3" / chip level: mở drawer đúng tab. Ngoài provider thì không hiện. */
export function HelpButton({ tab }: { tab: HowTab }) {
  const t = useTranslations("signalAnalysis.research.page");
  const open = useContext(HowContext);
  if (open === null) return null;
  return (
    <button
      type="button"
      aria-label={t("help", { tab: t(`drawer.tabs.${tab}`) })}
      onClick={() => {
        open(tab);
      }}
      className="ml-1 inline-flex size-6 cursor-pointer items-center justify-center rounded-full border border-border-input bg-surface p-0 align-middle text-xs font-extrabold text-accent-ink hover:bg-surface-2"
    >
      <span aria-hidden="true">?</span>
    </button>
  );
}

export function HowItWorksDrawer({
  tab,
  onTab,
  onClose,
  version,
  rulesVersion,
}: {
  /** null = đóng. */
  tab: HowTab | null;
  onTab: (tab: HowTab) => void;
  onClose: () => void;
  /** Version đang chọn ở đầu trang (null khi chưa tải được). */
  version: ResearchVersion | null;
  /** Rules vN của bảng loại tin (tổng kết); null khi không có. */
  rulesVersion: number | null;
}) {
  const t = useTranslations("signalAnalysis.research.page.drawer");
  const tv = useTranslations("signalAnalysis.research.versions");
  const tn = useTranslations("signalAnalysis.research");
  const refs = useRef(new Map<HowTab, HTMLButtonElement>());
  const cur = tab ?? "news";
  const name =
    version === null
      ? null
      : version.isBaseline
        ? tn("page.baselineOption", { n: version.number })
        : versionShort(version, tv);
  const onKey = (e: KeyboardEvent) => {
    const i = HOW_TABS.indexOf(cur);
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -i : 0;
    const end = e.key === "End";
    if (d === 0 && !end) return;
    e.preventDefault();
    const next = end
      ? (HOW_TABS[HOW_TABS.length - 1] ?? "versions")
      : (HOW_TABS[(i + d + HOW_TABS.length) % HOW_TABS.length] ?? "news");
    onTab(next);
    refs.current.get(next)?.focus();
  };
  return (
    <BottomSheet
      open={tab !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t("title")}
      description={name === null ? t("descNa") : t("desc", { name })}
      closeLabel={t("close")}
      side
    >
      <div
        role="tablist"
        aria-label={t("tabsLabel")}
        className="flex gap-1 overflow-x-auto rounded-tile border border-border bg-surface-2 p-1 max-md:mask-r-from-85%"
      >
        {HOW_TABS.map((k) => {
          const on = k === cur;
          return (
            <button
              key={k}
              ref={(el) => {
                if (el === null) refs.current.delete(k);
                else refs.current.set(k, el);
              }}
              type="button"
              role="tab"
              id={`hiw-tab-${k}`}
              aria-selected={on}
              aria-controls="hiw-panel"
              tabIndex={on ? 0 : -1}
              onKeyDown={onKey}
              onClick={() => {
                onTab(k);
              }}
              className={`min-h-11 flex-none cursor-pointer whitespace-nowrap rounded-[10px] border-0 px-3.5 text-[13px] font-extrabold ${on ? "bg-surface text-ink shadow-card" : "bg-transparent text-muted"}`}
            >
              {t(`tabs.${k}`)}
            </button>
          );
        })}
      </div>
      <div
        id="hiw-panel"
        role="tabpanel"
        aria-labelledby={`hiw-tab-${cur}`}
        className="flex flex-col gap-3 text-sm leading-normal text-ink-2"
      >
        <Panel tab={cur} version={version} name={name} rulesVersion={rulesVersion} />
      </div>
    </BottomSheet>
  );
}

const b = (c: ReactNode) => <b className="text-ink">{c}</b>;

function Panel({
  tab,
  version,
  name,
  rulesVersion,
}: {
  tab: HowTab;
  version: ResearchVersion | null;
  name: string | null;
  rulesVersion: number | null;
}) {
  const t = useTranslations("signalAnalysis.research.page.drawer");
  const tr = useTranslations("signalAnalysis.research.rules");
  const tv = useTranslations("signalAnalysis.research.versions");
  const tn = useTranslations("signalAnalysis.research");
  const cfg = version?.config ?? null;
  switch (tab) {
    case "news":
      return (
        <>
          {rulesVersion === null ? null : <Sub>{tr("sub", { v: rulesVersion })}</Sub>}
          <p className="m-0">{tr.rich("intro", { b })}</p>
          <ScrollTable label={tr("typesTable")}>
            <table className="w-full border-collapse">
              <caption className="sr-only">{tr("typesTable")}</caption>
              <thead>
                <tr>
                  {(["colType", "colDir", "colHold"] as const).map((k) => (
                    <th key={k} scope="col" className={thR}>
                      {tr(k)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SIGNAL_CATALYSTS.map((c) => {
                  const side = catalystSide(c);
                  const h = cfg === null ? null : versionHoldHours(cfg, c);
                  return (
                    <tr key={c}>
                      <td className={tdW}>{catalystName(c, tn)}</td>
                      <td className={tdR}>
                        <span
                          className={`font-bold ${side === "long" ? "text-pos" : "text-neg-ink"}`}
                        >
                          {tn(`sides.${side}`)}
                        </span>
                      </td>
                      <td className={tdR}>
                        {cfg === null ? (
                          <Na />
                        ) : h === null ? (
                          <span className="text-muted">{t("off")}</span>
                        ) : (
                          hold(h)
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollTable>
          <p className="m-0 text-muted">{tr("rows.notSignals")}</p>
        </>
      );
    case "levels":
      return (
        <>
          {cfg === null ? (
            <Na />
          ) : (
            <p className="m-0">{t.rich("minLevel", { level: tn(`levels.${cfg.minLevel}`), b })}</p>
          )}
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {RESEARCH_LEVELS.map((l) => (
              <li key={l} className="flex flex-wrap items-start gap-2">
                <Pill tone={LEVEL_TONE[l]}>{tn(`levels.${l}`)}</Pill>
                <span className="min-w-0 flex-[1_1_240px]">{tr(`when.${l}`)}</span>
              </li>
            ))}
          </ul>
          <Note>
            {tr.rich("tiers", { b, t: (c) => <b>{c}</b>, br: () => <br /> })}
            <Sub>{tr("tiersNote")}</Sub>
          </Note>
        </>
      );
    case "tpsl":
      return cfg === null ? (
        <Na />
      ) : (
        <>
          <p className="m-0">
            {t.rich("tpsl", {
              tp: cfg.tpMultiple,
              sl: cfg.slMultiple,
              min: cfg.minTpCostMultiple,
              b,
            })}
          </p>
          <p className="m-0">{t.rich("size", { size: count(Number(cfg.sizeUsdc)), b })}</p>
        </>
      );
    case "gate":
      return (
        <>
          <p className="m-0">{t.rich("gate", { b })}</p>
          <p className="m-0">
            {t.rich("classifierGate", {
              min: CLASSIFIER_GATE.minLabels,
              pct: CLASSIFIER_GATE.minPrecisionPct,
              b,
            })}
          </p>
          <Note>{tr.rich("firstAnswer", { b })}</Note>
          <Note>{tr.rich("passIf", { b })}</Note>
        </>
      );
    case "context":
      return (
        <>
          <p className="m-0">{t.rich("context1", { b })}</p>
          <p className="m-0">{t.rich("context2", { b })}</p>
          <p className="m-0">{t.rich("context3", { b })}</p>
        </>
      );
    case "versions":
      return (
        <>
          <p className="m-0">{tv("intro")}</p>
          {version === null || name === null ? (
            <Na />
          ) : (
            <p className="m-0">
              {t.rich("versionNow", { name, config: configLine(version, tv), b })}
            </p>
          )}
        </>
      );
  }
}
