"use client";

import {
  CLASSIFIER_GATE,
  EXPERIMENT_PAIRS,
  MARKET_STATE_RULES,
  READER_NEW_BADGE,
  RESEARCH_LEVELS,
  RULES_NEW_BADGE,
  SIGNAL_CATALYSTS,
  versionHoldHours,
  type ResearchVersion,
} from "@drift/shared";
import { BottomSheet, Button } from "@drift/ui";
import { useTranslations } from "next-intl";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { ScrollTable } from "../components/bits";
import { count } from "../format";

import { useResearchClassifiers } from "./api";
import { useBotsLabels } from "./bots-labels-context";
import { hold, pctSigned } from "./format";
import { MainnetOverviewPanel, MainnetTag } from "./how-it-works-mainnet";
import { OverviewPanel } from "./how-it-works-overview";
import { LEVEL_TONE, Na, Note, Pill, Sub, tdR, tdW, thR } from "./ui";
import {
  catalystName,
  catalystSide,
  classifierShort,
  configLine,
  readerBadgeShown,
  rulesBadgeShown,
  versionShort,
} from "./version-text";

// Drawer "How it works" của trang Signal research (#342, thiết kế docs/mockups/signal-research/redesign-full-page*.html):
// nội dung cũ của khối "What counts as a news signal" chuyển vào đây, chia tab, theo luật của version đang chọn ở đầu trang.
// Không bao giờ tự mở; Esc đóng; Radix giữ focus trong drawer và trả focus về nút đã mở (BottomSheet). Desktop: bám cạnh
// phải (`side`); dưới 768px: chiếm màn hình như sheet của version. Trang gọn (2026-11-20): giải thích dài của Paper bots và
// Classifier quality chuyển vào tab Versions và tab Labels (mới), Market state (#376), Experiments (#377); các tab cuộn
// ngang, mép phải mờ khi còn tab phía sau.
// #391: tab Overview (một vòng chạy, how-it-works-overview.tsx) đứng đầu; nút "How it works" mở vào đây, nút "?" vẫn mở đúng
// tab của nó. Dải tab và panel có `shrink-0`: BottomSheet side là cột tự cuộn, khối con không được bị ép dẹt.

export const HOW_TABS = [
  "overview",
  "news",
  "levels",
  "tpsl",
  "gate",
  "context",
  "market",
  "versions",
  "labels",
  "experiments",
] as const;
export type HowTab = (typeof HOW_TABS)[number];
/** #391: mở drawer mà không chỉ định tab (nút "How it works") thì vào Overview. */
export const DEFAULT_HOW_TAB: HowTab = "overview";

const HowContext = createContext<((tab: HowTab) => void) | null>(null);
export const HowItWorksProvider = HowContext.Provider;
/** Mở drawer đúng tab; null ngoài provider (component đứng riêng trong test). */
export const useHowItWorks = () => useContext(HowContext);

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
  maxRunning = null,
  baselineNumber = null,
  cycleMinutes = null,
  mode = "paper",
}: {
  /** null = đóng. */
  tab: HowTab | null;
  onTab: (tab: HowTab) => void;
  onClose: () => void;
  /** Version đang chọn ở đầu trang (null khi chưa tải được). */
  version: ResearchVersion | null;
  /** Rules vN của bảng loại tin (tổng kết); null khi không có. */
  rulesVersion: number | null;
  /** Số version chạy cùng lúc (API versions); null khi chưa tải. */
  maxRunning?: number | null;
  /** #377: số của Baseline (đối chứng cố định của thí nghiệm); null khi chưa tải. */
  baselineNumber?: number | null;
  /** #394: chu kỳ lane tin tức (phút) từ API tổng kết; null = không biết ("Not available"). */
  cycleMinutes?: number | null;
  /** #454: chế độ đang xem của trang; Mainnet thì tab Overview hiện bản Mainnet và tiêu đề có nhãn "Mainnet". */
  mode?: "paper" | "mainnet";
}) {
  const t = useTranslations("signalAnalysis.research.page.drawer");
  const tv = useTranslations("signalAnalysis.research.versions");
  const tn = useTranslations("signalAnalysis.research");
  const refs = useRef(new Map<HowTab, HTMLButtonElement>());
  const cur = tab ?? DEFAULT_HOW_TAB;
  // Các tab cuộn ngang khi drawer hẹp: mép phải mờ khi còn tab phía sau; tab đang chọn luôn cuộn vào khung.
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (list === null) return;
    const check = () => {
      // > 6 px: lề p-1 (4 px) của dải tab còn lại khi tab cuối được cuộn vào khung không tính là "còn tab phía sau".
      setMore(list.scrollWidth - list.clientWidth - list.scrollLeft > 6);
    };
    check();
    list.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => {
      list.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, [list]);
  useEffect(() => {
    const el = refs.current.get(cur);
    // jsdom (test) không có scrollIntoView.
    if (el !== undefined && "scrollIntoView" in el)
      // Giữa dải (#376): tab ở giữa danh sách (Market state) không nằm dưới mép mờ bên phải.
      el.scrollIntoView({ block: "nearest", inline: "center" });
  }, [cur, list]);
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
      : (HOW_TABS[(i + d + HOW_TABS.length) % HOW_TABS.length] ?? DEFAULT_HOW_TAB);
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
      {...(mode === "mainnet" ? { titleAside: <MainnetTag /> } : {})}
      description={name === null ? t("descNa") : t("desc", { name })}
      closeLabel={t("close")}
      side
    >
      <div
        ref={setList}
        role="tablist"
        aria-label={t("tabsLabel")}
        data-more={more || undefined}
        className={`flex shrink-0 gap-1 overflow-x-auto rounded-tile border border-border bg-surface-2 p-1 [scrollbar-width:none] ${more ? "mask-r-from-85%" : ""}`}
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
        className="flex shrink-0 flex-col gap-3 text-sm leading-normal text-ink-2"
      >
        <Panel
          tab={cur}
          version={version}
          name={name}
          rulesVersion={rulesVersion}
          maxRunning={maxRunning}
          baselineNumber={baselineNumber}
          cycleMinutes={cycleMinutes}
          mode={mode}
          onClose={onClose}
        />
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
  maxRunning,
  baselineNumber,
  cycleMinutes,
  mode,
  onClose,
}: {
  tab: HowTab;
  version: ResearchVersion | null;
  name: string | null;
  rulesVersion: number | null;
  maxRunning: number | null;
  baselineNumber: number | null;
  cycleMinutes: number | null;
  mode: "paper" | "mainnet";
  onClose: () => void;
}) {
  const t = useTranslations("signalAnalysis.research.page.drawer");
  const tr = useTranslations("signalAnalysis.research.rules");
  const tv = useTranslations("signalAnalysis.research.versions");
  const tn = useTranslations("signalAnalysis.research");
  const cfg = version?.config ?? null;
  switch (tab) {
    case "overview":
      return mode === "mainnet" ? (
        <MainnetOverviewPanel cycleMinutes={cycleMinutes} />
      ) : (
        <OverviewPanel cycleMinutes={cycleMinutes} />
      );
    case "news":
      return (
        <>
          <NewsSub rulesVersion={rulesVersion} />
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
          <NewsBoxes />
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
          {/* #530: drawer mô tả Rules hiện tại (news-v6), luôn chia cỡ lệnh cho các coin của một sự kiện → "up to". */}
          <p className="m-0">
            {t.rich("sizeUpTo", { size: count(Number(cfg.sizeUsdc)), b })}
          </p>
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
          <p className="m-0">{t.rich("versions1", { b })}</p>
          <p className="m-0">{t.rich("versions2", { max: maxRunning ?? tn("na"), b })}</p>
          <p className="m-0">{t.rich("versions3", { b })}</p>
          {version === null || name === null ? (
            <Na />
          ) : (
            <p className="m-0">
              {t.rich("versionNow", { name, config: configLine(version, tv), b })}
            </p>
          )}
        </>
      );
    case "market":
      return <MarketStatePanel />;
    case "labels":
      return <LabelsPanel onClose={onClose} />;
    case "experiments": {
      // #377: luật "một giả thuyết, một thay đổi" và cách đọc kết quả (mockup catalyst-drawer-experiments-1440.png).
      const baseline =
        baselineNumber === null
          ? t("experimentsBaseline")
          : tn("page.baselineOption", { n: baselineNumber });
      const max = maxRunning ?? tn("na");
      return (
        <>
          <p className="m-0">{t.rich("experiments1", { baseline, b })}</p>
          <p className="m-0">{t.rich("experiments2", { pairs: EXPERIMENT_PAIRS, b })}</p>
          <p className="m-0">{t.rich("experiments3", { pairs: EXPERIMENT_PAIRS, max, b })}</p>
          <p className="m-0">{t.rich("experiments4", { b })}</p>
          <p className="m-0">{t.rich("experiments5", { b })}</p>
          <p className="m-0 text-xs text-muted">{t("experimentsNote")}</p>
        </>
      );
    }
  }
}

/** Tab Market state (#376, mockup catalyst-drawer-market-state-1440.png): ngưỡng lấy từ `MARKET_STATE_RULES`. */

function MarketStatePanel() {
  const t = useTranslations("signalAnalysis.research.market.drawer");
  const r = MARKET_STATE_RULES;
  const box = "flex flex-col gap-1.5 rounded-tile border border-border p-3.5";
  return (
    <>
      <p className="m-0">{t.rich("intro", { b })}</p>
      <div className={box}>
        <b className="text-ink">{t("btcTitle")}</b>
        <span>{t("btcBody", { h: r.btcHours })}</span>
        <span>{t.rich("btcUp", { pct: pctSigned(r.btcUpPct, 1), b })}</span>
        <span>{t.rich("btcDown", { pct: pctSigned(r.btcDownPct, 1), b })}</span>
        <span>{t.rich("btcFlat", { b })}</span>
      </div>
      <div className={box}>
        <b className="text-ink">{t("volTitle")}</b>
        <span>{t("volBody", { h: r.volHours, days: r.volLookbackDays })}</span>
        <span>{t.rich("volLow", { n: r.volLowPercentile, b })}</span>
        <span>{t.rich("volHigh", { n: r.volHighPercentile, b })}</span>
        <span>{t.rich("volNormal", { b })}</span>
      </div>
      <p className="m-0 text-xs text-muted">{t("missing")}</p>
      <p className="m-0 text-xs text-muted">
        {t("candles", { pct: Math.round(r.volMinCoverage * 100), h: r.volHours })}
      </p>
    </>
  );
}

/**
 * #395, #399: nhãn "New in v{n}" / "v3 → v4". Hộp reader theo reader hiện tại (`READER_NEW_BADGE`, `readerBadgeShown`);
 * hộp "Not counted" và chip theo Rules v4 (`RULES_NEW_BADGE`, `rulesBadgeShown`). Mỗi nhãn hiện trong 14 ngày đầu.
 */
function NewBadge({ children }: { children: ReactNode }) {
  return (
    <span className="ml-1.5 inline-block rounded-full bg-pos-bg px-[7px] py-px align-[1px] text-[10.5px] font-extrabold text-pos">
      {children}
    </span>
  );
}

/** Dòng sub của tab News types: "Rules v4 · Claude reader v4 · …" (reader lấy từ classifier đang chạy). */
function NewsSub({ rulesVersion }: { rulesVersion: number | null }) {
  const tr = useTranslations("signalAnalysis.research.rules");
  const q = useResearchClassifiers();
  if (rulesVersion === null) return null;
  const cur = q.data?.items.find((r) => r.current) ?? null;
  // Chip "v{v−1} → v{v}" nói về Rules nên theo mốc của Rules (`RULES_NEW_BADGE`): đổi reader không làm chip hiện lại.
  const fresh = rulesBadgeShown(q.data?.items, Date.now());
  return (
    <Sub>
      {cur === null
        ? tr("sub", { v: rulesVersion })
        : tr("subReader", { v: rulesVersion, name: classifierShort(cur.classifierVersion) })}
      {fresh && rulesVersion > 1 ? (
        <NewBadge>{tr("changed", { from: rulesVersion - 1, to: rulesVersion })}</NewBadge>
      ) : null}
    </Sub>
  );
}

/**
 * #395 (mockup docs/mockups/signal-research/reader-v4.html): hai hộp của tab News types. "Not counted" = luật cố định trong
 * code (`etfExcludedMarkets`, `treasuryExcludedMarkets`, `listingExcludedMarkets` #506); hộp thứ hai = thay đổi trong prompt
 * của Claude reader hiện tại (#399: tên reader lấy từ classifier đang chạy; dòng của v6 (#505) đứng đầu, rồi dòng của v5,
 * rồi các dòng của v4).
 */
function NewsBoxes() {
  const tr = useTranslations("signalAnalysis.research.rules");
  const q = useResearchClassifiers();
  const now = Date.now();
  const rulesFresh = rulesBadgeShown(q.data?.items, now);
  const readerFresh = readerBadgeShown(q.data?.items, now);
  const cur = q.data?.items.find((r) => r.current) ?? null;
  const rulesBadge = rulesFresh ? (
    <NewBadge>{tr("newIn", { name: classifierShort(RULES_NEW_BADGE.classifierVersion) })}</NewBadge>
  ) : null;
  const readerBadge = readerFresh ? (
    <NewBadge>
      {tr("newIn", { name: classifierShort(READER_NEW_BADGE.classifierVersion) })}
    </NewBadge>
  ) : null;
  const box = "flex flex-col gap-2 rounded-tile border px-3.5 py-3";
  const list = "m-0 flex list-disc flex-col gap-1.5 pl-[18px] text-ink-2";
  return (
    <>
      <section
        aria-labelledby="hiw-not-counted"
        className={`${box} ${rulesFresh ? "border-pos bg-surface" : "border-border bg-surface-2"}`}
      >
        <h3 id="hiw-not-counted" className="m-0 text-sm font-extrabold text-ink">
          {tr("notCounted.title")}
          {rulesBadge}
        </h3>
        <ul className={list}>
          <li>{tr.rich("notCounted.etf", { b })}</li>
          <li>{tr.rich("notCounted.treasury", { b })}</li>
          <li>{tr.rich("notCounted.listing", { b })}</li>
        </ul>
      </section>
      <section aria-labelledby="hiw-reader" className={`${box} border-border bg-surface-2`}>
        <h3 id="hiw-reader" className="m-0 text-sm font-extrabold text-ink">
          {cur === null
            ? tr("reader.titleAny")
            : tr("reader.title", { name: classifierShort(cur.classifierVersion) })}
          {readerBadge}
        </h3>
        <ul className={list}>
          <li>{tr.rich("reader.types", { b })}</li>
          <li>{tr.rich("reader.stocks", { b })}</li>
          <li>{tr.rich("reader.bug", { b })}</li>
          <li>{tr.rich("reader.stolen", { b })}</li>
          <li>{tr.rich("reader.laundering", { b })}</li>
          <li>{tr.rich("reader.etf", { b })}</li>
        </ul>
      </section>
    </>
  );
}

/** Tab Labels (mới, trang gọn): nhãn là gì, vì sao tính theo Claude reader, khi nào lệnh bắt đầu được tính. */
function LabelsPanel({ onClose }: { onClose: () => void }) {
  const t = useTranslations("signalAnalysis.research.page.drawer");
  const tl = useTranslations("signalAnalysis.research.labeling");
  const tn = useTranslations("signalAnalysis.research");
  const q = useResearchClassifiers();
  const open = useBotsLabels();
  const cur = q.data?.items.find((r) => r.current) ?? null;
  const min = CLASSIFIER_GATE.minLabels;
  const pct = CLASSIFIER_GATE.minPrecisionPct;
  return (
    <>
      <p className="m-0">{t.rich("labels1", { b })}</p>
      <p className="m-0">{t.rich("labels2", { b })}</p>
      <p className="m-0">{t.rich("labels3", { b })}</p>
      <p className="m-0">{t.rich("labels4", { min, pct, b })}</p>
      <p className="m-0">{t.rich("labels5", { min, b })}</p>
      <Sub>{t("labelsRule")}</Sub>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-tile border border-border p-3.5 text-[13px]">
        <span>
          {cur === null ? (
            <Na />
          ) : (
            t.rich("labelsNow", {
              v: classifierShort(cur.classifierVersion),
              n: cur.labeled,
              min,
              pct:
                cur.precisionPct === null ? tn("na") : `${String(Math.round(cur.precisionPct))}%`,
              b,
            })
          )}
        </span>
        {open === null ? null : (
          <Button
            onClick={() => {
              onClose();
              open.openLabels();
            }}
          >
            {tl("random")}
          </Button>
        )}
      </div>
    </>
  );
}
